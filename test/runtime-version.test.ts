import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeRuntime,
  RUNTIME,
  readRuntime,
  writeRuntimeVersion,
} from "../src/runtime-version.js";

const checkout = join(import.meta.dirname, "..");

function gitOut(args: string[]): string {
  return spawnSync("git", args, {
    cwd: checkout,
    encoding: "utf8",
  }).stdout.trim();
}

describe("the runtime tag (R4-12)", () => {
  it("describes this checkout as its HEAD commit, -dirty when a tracked file differs", () => {
    const head = gitOut(["rev-parse", "HEAD"]);
    const dirty =
      gitOut(["status", "--porcelain", "--untracked-files=no"]) !== "";
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(describeRuntime(checkout)).toBe(dirty ? `${head}-dirty` : head);
  });

  it("is unknown where there is no checkout", () => {
    expect(describeRuntime(join(tmpdir(), "noscope-no-such-checkout"))).toBe(
      "unknown",
    );
  });

  it("the build writes the tag beside the compiled module, and the module reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "noscope-dist-"));
    const written = writeRuntimeVersion(dir, checkout);
    expect(written).toBe(describeRuntime(checkout));
    expect(
      JSON.parse(readFileSync(join(dir, "runtime-version.json"), "utf8")),
    ).toEqual({
      runtime: written,
    });
    expect(readRuntime(pathToFileURL(`${dir}/`))).toBe(written);
  });

  it("reads unknown from a missing, empty or malformed version file, and this process's tag is never empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "noscope-dist-"));
    expect(readRuntime(pathToFileURL(`${dir}/`))).toBe("unknown");
    writeFileSync(join(dir, "runtime-version.json"), '{"runtime":""}');
    expect(readRuntime(pathToFileURL(`${dir}/`))).toBe("unknown");
    writeFileSync(join(dir, "runtime-version.json"), "not json");
    expect(readRuntime(pathToFileURL(`${dir}/`))).toBe("unknown");
    expect(RUNTIME).not.toBe("");
  });
});
