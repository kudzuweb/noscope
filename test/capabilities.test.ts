import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  listCapabilities,
  runDeterministic,
} from "../src/capabilities/index.js";
import { defineCapability } from "../src/capabilities/registry.js";
import { EXIT, run } from "../src/cli.js";
import { measureEvidence } from "../src/evidence.js";

const tree = resolve("test/fixtures/tree");
const ctx = { taskId: "t1", incidentId: "i1", cwd: tree };

describe("deterministic capabilities", () => {
  it("registers the four v0 deterministic capabilities as read-only producers of evidence, and the session ones of claims (R5-1)", () => {
    const names = listCapabilities()
      .filter((c) => c.kind === "deterministic")
      .map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["check_path", "git_history", "grep", "read"]),
    );
    for (const c of listCapabilities()) {
      expect(c.effect).toBe("read_only");
      if (c.kind === "deterministic") expect(c.produces).toBe("evidence");
      else expect(c.produces).toBe("claims");
    }
  });

  it("check_path returns existence as evidence either way, measured as what the path is", async () => {
    const yes = await runDeterministic(
      "check_path",
      { path: join(tree, "a.txt") },
      ctx,
    );
    expect(yes.output).toMatchObject({ exists: true, kind: "file" });
    expect(measureEvidence("check_path", yes.output)).toBe("exists, a file");
    const no = await runDeterministic(
      "check_path",
      { path: join(tree, "nope.txt") },
      ctx,
    );
    expect(no.output).toMatchObject({ exists: false, kind: "missing" });
    expect(measureEvidence("check_path", no.output)).toBe("does not exist");
    expect(Object.keys(no)).toEqual(["output", "inputs"]);
  });

  it("grep returns its matches as evidence, measured as matches in files, and the absence of any as no matches", async () => {
    const hits = await runDeterministic(
      "grep",
      { root: tree, pattern: "delete" },
      ctx,
    );
    expect(hits.output).toEqual({
      root: tree,
      matches: [
        { file: "a.txt", line: 2, text: "the delete handler lives here" },
      ],
      truncated: false,
    });
    expect(measureEvidence("grep", hits.output)).toBe("1 match in 1 file");
    const none = await runDeterministic(
      "grep",
      { root: tree, pattern: "zzz-not-here", glob: "*.md" },
      ctx,
    );
    expect(none.output).toEqual({ root: tree, matches: [], truncated: false });
    expect(measureEvidence("grep", none.output)).toBe("no matches");
    expect(none.inputs).toEqual({
      root: tree,
      pattern: "zzz-not-here",
      glob: "*.md",
      ignoreCase: false,
      exclude: ["node_modules", ".git"],
      maxMatches: 500,
    });
    expect(
      measureEvidence("grep", {
        root: tree,
        matches: [
          { file: "a", line: 1, text: "" },
          { file: "a", line: 2, text: "" },
          { file: "b", line: 1, text: "" },
        ],
        truncated: true,
      }),
    ).toBe("3 matches in 2 files, truncated");
  });

  it("relative path inputs resolve against the incident's cwd, never the process cwd", async () => {
    const yes = await runDeterministic("check_path", { path: "a.txt" }, ctx);
    expect(yes.output).toMatchObject({
      exists: true,
      kind: "file",
      path: join(tree, "a.txt"),
    });
    expect(yes.inputs).toEqual({ path: join(tree, "a.txt") });
    const hits = await runDeterministic(
      "grep",
      { root: "sub", pattern: "nothing" },
      ctx,
    );
    expect(hits.output).toMatchObject({
      root: join(tree, "sub"),
      matches: [{ file: "b.md", line: 1 }],
    });
  });

  it("read and git_history return their output as evidence, measured in lines and in commits", async () => {
    const r = await runDeterministic(
      "read",
      { path: join(tree, "sub", "b.md") },
      ctx,
    );
    expect(r.output).toMatchObject({
      text: "nothing to see\n",
      truncated: false,
    });
    expect(measureEvidence("read", r.output)).toBe("2 lines");
    const dir = mkdtempSync(join(tmpdir(), "noscope-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "x"), "1\n");
    git("add", "x");
    git("commit", "-q", "-m", "Only commit");
    writeFileSync(join(dir, "y"), "2\n");
    const h = await runDeterministic("git_history", { cwd: dir }, ctx);
    expect(h.output).toMatchObject({
      branch: "main",
      detached: false,
      changes: [{ status: "??", path: "y", from: null }],
      commits: [{ subject: "Only commit" }],
    });
    expect(measureEvidence("git_history", h.output)).toBe(
      "1 commit, 1 working-tree change, on main",
    );
  });

  it("measures a result its capability's schema no longer fits, or from a capability the registry lacks, as lines of JSON", () => {
    expect(measureEvidence("grep", { not: "a grep output" })).toBe(
      "3 line(s) of JSON",
    );
    expect(measureEvidence("gone", null)).toBe("0 line(s) of JSON");
    expect(measureEvidence("investigate", { outcome: "answered" })).toBe(
      "3 line(s) of JSON",
    );
  });

  it("refuses a capability that declares unknown equipment or a built-in for deterministic use, or a run with no measure", () => {
    expect(() =>
      defineCapability({
        name: "bad1",
        description: "x",
        equipment: ["not_a_thing"],
        input: z.object({}),
        output: z.object({}),
        effect: "read_only",
        run: async () => ({}),
        measure: () => "nothing",
      }),
    ).toThrow(/unknown equipment/);
    expect(() =>
      defineCapability({
        name: "bad2",
        description: "x",
        equipment: ["Read"],
        input: z.object({}),
        output: z.object({}),
        effect: "read_only",
        run: async () => ({}),
        measure: () => "nothing",
      }),
    ).toThrow(/exists only inside a session/);
    expect(() =>
      // @ts-expect-error a capability with neither a run nor a session is not a capability
      defineCapability({
        name: "bad3",
        description: "x",
        equipment: [],
        input: z.object({}),
        output: z.object({}),
        effect: "read_only",
      }),
    ).toThrow(/exactly one/);
    expect(() =>
      // @ts-expect-error a deterministic capability says how its output is counted
      defineCapability({
        name: "bad4",
        description: "x",
        equipment: [],
        input: z.object({}),
        output: z.object({}),
        effect: "read_only",
        run: async () => ({}),
      }),
    ).toThrow(/measure/);
  });

  it("incident show lists the registered capabilities", async () => {
    const db = `${mkdtempSync(join(tmpdir(), "noscope-cli-"))}/db.sqlite`;
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: () => {} };
    await run(["incident", "create", "--no-size-up", "x"], {
      io,
      cwd: tree,
      env: { NOSCOPE_DB: db },
    });
    expect(
      await run(["incident", "show", "001"], {
        io,
        cwd: tree,
        env: { NOSCOPE_DB: db },
      }),
    ).toBe(EXIT.ok);
    const text = out.join("\n");
    expect(text).toContain("capabilities registered:");
    expect(text).toContain("  - grep: ");
    expect(text).toContain("[deterministic, read_only]");
  });
});
