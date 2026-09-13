import { describe, expect, it } from "vitest";
import {
  helpText,
  INCIDENT_COMMANDS,
  run,
  TOP_LEVEL_COMMANDS,
  VERSION,
} from "../src/cli.js";

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
    for (const command of TOP_LEVEL_COMMANDS) {
      expect(text).toContain(`noscope ${command.usage}`);
    }
    expect(text).toBe(helpText());
  });

  it("prints the version for --version, -v and -V", async () => {
    for (const flag of ["--version", "-v", "-V"]) {
      const io = capture();
      expect(await run([flag], io)).toBe(0);
      expect(io.lines.out).toEqual([VERSION]);
    }
  });

  it("names after v0 for commands the design lists beyond v0", async () => {
    const io = capture();
    expect(await run(["incident", "sop", "1", "code-review"], io)).toBe(3);
    expect(io.lines.err[0]).toContain("after v0");
    const top = capture();
    expect(await run(["grant", "standing", "send_email"], top)).toBe(3);
    expect(top.lines.err[0]).toContain("after v0");
  });

  it("names the PR that delivers a known but unimplemented command", async () => {
    const io = capture();
    expect(await run(["incident", "step", "7"], io)).toBe(3);
    expect(io.lines.err[0]).toContain("not yet implemented");
    expect(io.lines.err[0]).toContain("arrives PR 12");
  });

  it("treats incident with no subcommand or --help as help", async () => {
    for (const argv of [
      ["incident"],
      ["incident", "--help"],
      ["incident", "-h"],
    ]) {
      const io = capture();
      expect(await run(argv, io)).toBe(0);
      expect(io.lines.out.join("\n")).toBe(helpText());
    }
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
