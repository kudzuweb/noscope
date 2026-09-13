import { describe, expect, it } from "vitest";
import { helpText, INCIDENT_COMMANDS, run, VERSION } from "../src/cli.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    lines: { out, err },
  };
}

describe("noscope cli", () => {
  it("prints help with every incident command when given no arguments", async () => {
    const io = capture();
    expect(await run([], io)).toBe(0);
    const text = io.lines.out.join("\n");
    for (const command of INCIDENT_COMMANDS) {
      expect(text).toContain(`noscope incident ${command.name}`);
    }
    expect(text).toBe(helpText());
  });

  it("prints the version", async () => {
    const io = capture();
    expect(await run(["--version"], io)).toBe(0);
    expect(io.lines.out).toEqual([VERSION]);
  });

  it("names the PR that delivers a known but unimplemented command", async () => {
    const io = capture();
    expect(await run(["incident", "step", "7"], io)).toBe(3);
    expect(io.lines.err[0]).toContain("not yet implemented");
    expect(io.lines.err[0]).toContain("PR 12");
  });

  it("rejects an unknown incident command with help on stderr", async () => {
    const io = capture();
    expect(await run(["incident", "frobnicate"], io)).toBe(2);
    expect(io.lines.err[0]).toContain("unknown command");
    expect(io.lines.err.join("\n")).toContain("Usage:");
  });

  it("rejects an unknown top-level command", async () => {
    const io = capture();
    expect(await run(["nope"], io)).toBe(2);
  });
});
