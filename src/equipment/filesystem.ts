import type { Dirent, Stats } from "node:fs";
import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { join, matchesGlob, relative, resolve } from "node:path";
import { z } from "zod";
import { defineEquipment } from "./registry.js";

const PathInput = z.object({ path: z.string().min(1) });
const MaxBytes = z.number().int().positive().default(200_000);

export const readFileEquipment = defineEquipment({
  name: "read_file",
  description: "Read a UTF-8 text file, up to a byte limit",
  input: PathInput.extend({ maxBytes: MaxBytes }),
  output: z.object({
    path: z.string(),
    text: z.string(),
    truncated: z.boolean(),
    bytes: z.number().int(),
  }),
  cost: { typicalSeconds: 0.01 },
  run: async ({ path, maxBytes }) => {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      const truncated = bytesRead > maxBytes;
      const kept = buffer.subarray(0, Math.min(bytesRead, maxBytes));
      const text = truncated
        ? new TextDecoder("utf-8").decode(kept, { stream: true })
        : kept.toString("utf8");
      return { path, text, truncated, bytes: Math.max(size, bytesRead) };
    } finally {
      await handle.close();
    }
  },
});

const EntryKind = z.enum(["file", "directory", "other"]);

function kindOf(d: Dirent | Stats): z.infer<typeof EntryKind> {
  if (d.isFile()) return "file";
  if (d.isDirectory()) return "directory";
  return "other";
}

export const PathKind = z.enum([...EntryKind.options, "missing"]);

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export const statPathEquipment = defineEquipment({
  name: "stat_path",
  description:
    "Whether a path exists and what it is, following symlinks; only a missing path or component reads as missing, any other failure is an error",
  input: PathInput,
  output: z.object({
    path: z.string(),
    exists: z.boolean(),
    kind: PathKind,
    symlink: z.boolean(),
    bytes: z.number().int().nullable(),
  }),
  cost: { typicalSeconds: 0.001 },
  run: async ({ path }) => {
    let link: Stats;
    try {
      link = await lstat(path);
    } catch (error) {
      if (isMissing(error))
        return {
          path,
          exists: false,
          kind: "missing" as const,
          symlink: false,
          bytes: null,
        };
      throw error;
    }
    const symlink = link.isSymbolicLink();
    let target: Stats;
    try {
      target = symlink ? await stat(path) : link;
    } catch (error) {
      if (isMissing(error))
        return {
          path,
          exists: false,
          kind: "missing" as const,
          symlink,
          bytes: null,
        };
      throw error;
    }
    const kind = kindOf(target);
    return {
      path,
      exists: true,
      kind,
      symlink,
      bytes: kind === "file" ? target.size : null,
    };
  },
});

export const listDirectoryEquipment = defineEquipment({
  name: "list_directory",
  description: "List the entries of a directory with their kind and size",
  input: PathInput,
  output: z.object({
    path: z.string(),
    entries: z.array(
      z.object({
        name: z.string(),
        kind: EntryKind,
        bytes: z.number().int().nullable(),
      }),
    ),
  }),
  cost: { typicalSeconds: 0.01 },
  run: async ({ path }) => {
    const names = await readdir(path, { withFileTypes: true });
    const entries = await Promise.all(
      names.map(async (d) => {
        const kind = kindOf(d);
        const bytes =
          kind === "file" ? (await stat(join(path, d.name))).size : null;
        return { name: d.name, kind, bytes };
      }),
    );
    return {
      path,
      entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

/** Files under root in path order, skipping excluded directory names, matched by basename or, when the glob has a separator, by root-relative path. */
async function* walk(
  root: string,
  dir: string,
  glob: string,
  exclude: readonly string[],
): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of entries) {
    const full = join(dir, d.name);
    if (d.isDirectory()) {
      if (exclude.includes(d.name)) continue;
      yield* walk(root, full, glob, exclude);
    } else if (d.isFile()) {
      const candidate = glob.includes("/") ? relative(root, full) : d.name;
      if (matchesGlob(candidate, glob)) yield full;
    }
  }
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export const grepFilesEquipment = defineEquipment({
  name: "grep_files",
  description:
    "Search files under a directory for a regular expression, returning file, line and text per match",
  input: z.object({
    root: z.string().min(1),
    pattern: z.string().min(1),
    glob: z.string().default("*"),
    ignoreCase: z.boolean().default(false),
    exclude: z.array(z.string()).default(["node_modules", ".git"]),
    maxMatches: z.number().int().positive().default(500),
  }),
  output: z.object({
    root: z.string(),
    matches: z.array(
      z.object({
        file: z.string(),
        line: z.number().int().positive(),
        text: z.string(),
      }),
    ),
    truncated: z.boolean(),
  }),
  cost: { typicalSeconds: 0.1 },
  run: async ({ root, pattern, glob, ignoreCase, exclude, maxMatches }) => {
    const re = new RegExp(pattern, ignoreCase ? "i" : "");
    const base = resolve(root);
    const matches: { file: string; line: number; text: string }[] = [];
    let truncated = false;
    files: for await (const file of walk(base, base, glob, exclude)) {
      const lines = splitLines(await readFile(file, "utf8"));
      for (const [i, text] of lines.entries()) {
        if (!re.test(text)) continue;
        if (matches.length >= maxMatches) {
          truncated = true;
          break files;
        }
        matches.push({ file: relative(base, file), line: i + 1, text });
      }
    }
    return { root, matches, truncated };
  },
});
