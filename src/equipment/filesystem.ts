import { readFile as fsReadFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { defineEquipment } from "./registry.js";

const PathInput = z.object({ path: z.string().min(1) });

export const readFileEquipment = defineEquipment({
  name: "read_file",
  description: "Read a UTF-8 text file, up to a byte limit",
  input: z.object({
    path: z.string().min(1),
    maxBytes: z.number().int().positive().default(200_000),
  }),
  output: z.object({
    path: z.string(),
    text: z.string(),
    truncated: z.boolean(),
    bytes: z.number().int(),
  }),
  cost: { typicalSeconds: 0.01 },
  run: async ({ path, maxBytes }) => {
    const buffer = await fsReadFile(path);
    const truncated = buffer.byteLength > maxBytes;
    return {
      path,
      text: buffer.subarray(0, maxBytes).toString("utf8"),
      truncated,
      bytes: buffer.byteLength,
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
        kind: z.enum(["file", "directory", "other"]),
        bytes: z.number().int().nullable(),
      }),
    ),
  }),
  cost: { typicalSeconds: 0.01 },
  run: async ({ path }) => {
    const names = await readdir(path, { withFileTypes: true });
    const entries = await Promise.all(
      names.map(async (d) => {
        const kind = d.isFile()
          ? "file"
          : d.isDirectory()
            ? "directory"
            : "other";
        const bytes =
          kind === "file" ? (await stat(join(path, d.name))).size : null;
        return { name: d.name, kind, bytes } as const;
      }),
    );
    return {
      path,
      entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

async function walk(root: string, glob: RegExp, out: string[]): Promise<void> {
  for (const d of await readdir(root, { withFileTypes: true })) {
    const full = join(root, d.name);
    if (d.isDirectory()) {
      if (d.name === "node_modules" || d.name === ".git") continue;
      await walk(full, glob, out);
    } else if (d.isFile() && glob.test(d.name)) out.push(full);
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
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
  run: async ({ root, pattern, glob, ignoreCase, maxMatches }) => {
    const re = new RegExp(pattern, ignoreCase ? "i" : "");
    const files: string[] = [];
    await walk(resolve(root), globToRegExp(glob), files);
    const matches: { file: string; line: number; text: string }[] = [];
    let truncated = false;
    for (const file of files.sort()) {
      const lines = (await fsReadFile(file, "utf8")).split("\n");
      for (const [i, text] of lines.entries()) {
        if (!re.test(text)) continue;
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
        matches.push({
          file: relative(resolve(root), file),
          line: i + 1,
          text,
        });
      }
      if (truncated) break;
    }
    return { root, matches, truncated };
  },
});
