import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  type Context,
  EXIT,
  helpText,
  run,
  VERSION,
} from "../src/cli.js";

function ctx() {
  const out: string[] = [];
  const err: string[] = [];
  const context: Context = {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    cwd: process.cwd(),
    env: {},
  };
  return { context, out, err };
}

describe("noscope cli", () => {
  it("prints help with every command in the design's list when given no arguments", async () => {
    const c = ctx();
    expect(await run([], c.context)).toBe(EXIT.ok);
    const text = c.out.join("\n");
    for (const command of COMMANDS) {
      expect(text).toContain(`noscope ${command.usage}`);
    }
    expect(text).toBe(helpText());
  });

  it("treats --help anywhere, help, incident alone and incident help as help", async () => {
    for (const argv of [
      ["--help"],
      ["-h"],
      ["help"],
      ["incident"],
      ["incident", "help"],
      ["incident", "--help"],
      ["incident", "step", "--help"],
    ]) {
      const c = ctx();
      expect(await run(argv, c.context)).toBe(EXIT.ok);
      expect(c.out.join("\n")).toBe(helpText());
    }
  });

  it("prints the version from package.json for --version, -v and -V", async () => {
    for (const flag of ["--version", "-v", "-V"]) {
      const c = ctx();
      expect(await run([flag], c.context)).toBe(EXIT.ok);
      expect(c.out).toEqual([VERSION]);
    }
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("names what delivers a known but unimplemented command and exits 3", async () => {
    const c = ctx();
    expect(await run(["incident", "sop", "7", "code-review"], c.context)).toBe(
      EXIT.notYetImplemented,
    );
    expect(c.err[0]).toBe(
      "noscope incident sop: not yet implemented, arrives after v0",
    );
    const top = ctx();
    expect(await run(["grant", "standing", "send_email"], top.context)).toBe(
      EXIT.notYetImplemented,
    );
    expect(top.err[0]).toContain("arrives after v0");
  });

  it("dispatches to a handler when a command has one", async () => {
    const command = COMMANDS.find((c) => c.name === "show");
    if (command === undefined) throw new Error("show is registered");
    const seen: string[][] = [];
    const original = command.handler;
    command.handler = async (positionals) => {
      seen.push([...positionals]);
      return EXIT.ok;
    };
    try {
      const c = ctx();
      expect(await run(["incident", "show", "42"], c.context)).toBe(EXIT.ok);
      expect(seen).toEqual([["42"]]);
    } finally {
      command.handler = original;
    }
  });

  it("rejects an unknown command with help on stderr and exit 2", async () => {
    for (const argv of [["incident", "frobnicate"], ["nope"]]) {
      const c = ctx();
      expect(await run(argv, c.context)).toBe(EXIT.usage);
      expect(c.err[0]).toContain("unknown command");
      expect(c.err.join("\n")).toContain("Usage:");
    }
  });
});
