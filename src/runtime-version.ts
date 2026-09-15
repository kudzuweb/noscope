import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The runtime tag (R4-12): the noscope commit a process was built from, stamped on every
 * event it writes so a briefing can be re-rendered later by checking that commit out and
 * replaying the events before the call (DESIGN.md Step 2). The build bakes it into
 * `dist/runtime-version.json` beside this module's compiled file; a process running from
 * source, or from a `dist/` written without the file, is `unknown`.
 */
const FILE = "runtime-version.json";
const UNKNOWN = "unknown";

function git(cwd: string, args: readonly string[]): string | null {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (ran.error !== undefined || ran.status !== 0) return null;
  return ran.stdout.trim();
}

/**
 * The commit `cwd`'s checkout is at, `-dirty` when a tracked file differs from it, and
 * `unknown` when there is no git or no checkout.
 */
export function describeRuntime(cwd: string): string {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (head === null || head === "") return UNKNOWN;
  const changed = git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  return changed === null || changed === "" ? head : `${head}-dirty`;
}

/** Writes the tag of `checkout` into `dir`'s version file and returns it. */
export function writeRuntimeVersion(dir: string, checkout: string): string {
  const runtime = describeRuntime(checkout);
  writeFileSync(
    new URL(FILE, pathToFileURL(`${dir}/`)),
    `${JSON.stringify({ runtime })}\n`,
  );
  return runtime;
}

/** The tag in `dir`'s version file, or `unknown` when there is none or it is empty. */
export function readRuntime(dir: URL): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL(FILE, dir), "utf8"),
    );
    const runtime =
      typeof parsed === "object" && parsed !== null && "runtime" in parsed
        ? parsed.runtime
        : undefined;
    return typeof runtime === "string" && runtime !== "" ? runtime : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/** The tag of this process: what the build baked beside this module. */
export const RUNTIME: string = readRuntime(new URL("./", import.meta.url));

// `pnpm build` runs this module after `tsc` (`node dist/runtime-version.js`): it writes
// the checkout's tag beside itself, the checkout being the directory above `dist/`.
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const here = fileURLToPath(new URL("./", import.meta.url));
  const checkout = fileURLToPath(new URL("../", import.meta.url));
  console.log(`runtime ${writeRuntimeVersion(here, checkout)}`);
}
