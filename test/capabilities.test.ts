import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getCapability,
  listCapabilities,
  runDeterministic,
} from "../src/capabilities/index.js";
import { defineCapability } from "../src/capabilities/registry.js";
import { EXIT, run } from "../src/cli.js";
import type { Task } from "../src/models.js";
import { now, Store } from "../src/store.js";
import { recordClaims } from "../src/verifier.js";

const tree = resolve("test/fixtures/tree");
const ctx = { taskId: "t1", incidentId: "i1", cwd: tree };

describe("deterministic capabilities", () => {
  it("registers the four v0 deterministic capabilities as read-only producers of verified claims", () => {
    const names = listCapabilities()
      .filter((c) => c.kind === "deterministic")
      .map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["check_path", "git_history", "grep", "read"]),
    );
    for (const c of listCapabilities()) {
      expect(c.effect).toBe("read_only");
      if (c.kind === "deterministic")
        expect(c.produces).toBe("verified_claims");
      else expect(c.produces).toBe("asserted_claims");
    }
  });

  it("check_path states existence as a claim either way", async () => {
    const yes = await runDeterministic(
      "check_path",
      { path: join(tree, "a.txt") },
      ctx,
    );
    expect(yes.output).toMatchObject({ exists: true, kind: "file" });
    expect(yes.claims).toMatchObject([
      { predicate: "exists", object: true, confidence: 1 },
      { predicate: "is_a", object: "file", confidence: 1 },
    ]);
    const no = await runDeterministic(
      "check_path",
      { path: join(tree, "nope.txt") },
      ctx,
    );
    expect(no.output).toMatchObject({ exists: false, kind: "missing" });
    expect(no.claims).toMatchObject([{ predicate: "exists", object: false }]);
    expect(no.claims).toHaveLength(1);
  });

  it("grep records one claim per match and a verified absence when there is none", async () => {
    const hits = await runDeterministic(
      "grep",
      { root: tree, pattern: "delete" },
      ctx,
    );
    const at = `${join(tree, "a.txt")}:2`;
    expect(hits.claims).toEqual([
      {
        subject: at,
        predicate: "matches",
        object: { pattern: "delete", text: "the delete handler lives here" },
        confidence: 1,
        evidence: [at],
      },
    ]);
    const none = await runDeterministic(
      "grep",
      { root: tree, pattern: "zzz-not-here", glob: "*.md" },
      ctx,
    );
    expect(none.claims).toEqual([
      {
        subject: tree,
        predicate: "has_no_match_for",
        object: {
          pattern: "zzz-not-here",
          glob: "*.md",
          ignoreCase: false,
          exclude: ["node_modules", ".git"],
        },
        confidence: 1,
        evidence: [tree],
      },
    ]);
    expect(none.inputs).toEqual({
      root: tree,
      pattern: "zzz-not-here",
      glob: "*.md",
      ignoreCase: false,
      exclude: ["node_modules", ".git"],
      maxMatches: 500,
    });
  });

  it("relative path inputs resolve against the incident's cwd, never the process cwd", async () => {
    const yes = await runDeterministic("check_path", { path: "a.txt" }, ctx);
    expect(yes.output).toMatchObject({ exists: true, kind: "file" });
    expect(yes.claims[0]?.subject).toBe(join(tree, "a.txt"));
    expect(yes.inputs).toEqual({ path: join(tree, "a.txt") });
    const hits = await runDeterministic(
      "grep",
      { root: "sub", pattern: "nothing" },
      ctx,
    );
    expect(hits.claims.map((c) => c.subject)).toEqual([
      `${join(tree, "sub", "b.md")}:1`,
    ]);
  });

  it("read and git_history produce facts with evidence", async () => {
    const r = await runDeterministic(
      "read",
      { path: join(tree, "sub", "b.md") },
      ctx,
    );
    expect(r.claims[0]).toMatchObject({
      predicate: "content",
      object: { text: "nothing to see\n", truncated: false },
    });
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
    });
    expect(h.claims.map((c) => [c.predicate, c.subject])).toEqual([
      ["on_branch", dir],
      ["working_tree_changes", dir],
      ["recent_commits", dir],
    ]);
    expect(h.claims[1]?.object).toEqual([
      { status: "??", path: "y", from: null },
    ]);
  });

  it("refuses a capability that declares unknown equipment or a built-in for deterministic use", () => {
    expect(() =>
      defineCapability({
        name: "bad1",
        description: "x",
        equipment: ["not_a_thing"],
        input: z.object({}),
        output: z.object({}),
        effect: "read_only",
        run: async () => ({ output: {}, claims: [] }),
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
        run: async () => ({ output: {}, claims: [] }),
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
  });

  it("the verifier records a deterministic capability's claims as verified with capability and inputs as provenance", async () => {
    const store = new Store(":memory:");
    const at = now();
    store.createIncident(
      {
        id: "i1",
        objective: "o",
        constraints: [],
        priorities: [],
        budget: {},
        questions: [],
        capabilityRequests: [],
        status: "open",
        createdAt: at,
        updatedAt: at,
      },
      "cli",
    );
    store.createUnit(
      {
        id: "u",
        incidentId: "i1",
        parentId: null,
        objective: "command",
        leader: { provider: "claude-code", model: "claude-haiku-4-5" },
        equipment: [],
        bashAllowlist: [],
        sessionId: null,
        status: "active",
        createdAt: at,
        closedAt: null,
      },
      "runtime",
    );
    const task: Task = {
      id: "t1",
      incidentId: "i1",
      unitId: "u",
      capability: "grep",
      objective: "find delete",
      inputs: { root: tree, pattern: "delete" },
      expectedOutput: "",
      completionCriteria: [],
      evidenceRequired: [],
      dependsOn: [],
      evidenceFrom: { claims: [], tasks: [] },
      provider: null,
      model: null,
      instructions: "",
      budget: {},
      strikeTeam: [],
      status: "running",
      result: null,
      createdAt: at,
      completedAt: null,
    };
    store.createTask(task, "planner");
    const capability = getCapability("grep");
    if (capability === undefined) throw new Error("grep is registered");
    const result = await runDeterministic("grep", task.inputs, {
      taskId: task.id,
      incidentId: task.incidentId,
      cwd: tree,
    });
    const claims = recordClaims(store, task, capability, result.claims, {
      inputs: result.inputs,
    });
    expect(claims).toHaveLength(1);
    const stored = store.listClaims("i1");
    expect(stored[0]).toMatchObject({
      status: "verified",
      basis: "observed",
      subject: `${join(tree, "a.txt")}:2`,
      provenance: {
        capability: "grep",
        taskId: "t1",
        inputs: {
          root: tree,
          pattern: "delete",
          glob: "*",
          ignoreCase: false,
          exclude: ["node_modules", ".git"],
          maxMatches: 500,
        },
      },
    });
    expect(stored[0]?.provenance.sessionId).toBeUndefined();
    expect(store.listEvents("i1").map((e) => e.type)).toContain(
      "claim.verified",
    );
    expect(() =>
      recordClaims(store, task, capability, result.claims, { sessionId: "s" }),
    ).toThrow(/inputs that ran/);
    const read = getCapability("read");
    if (read === undefined) throw new Error("read is registered");
    expect(() =>
      recordClaims(store, task, read, result.claims, { inputs: {} }),
    ).toThrow(/ran grep, not read/);
    store.close();
  });

  it("incident show lists the registered capabilities", async () => {
    const db = `${mkdtempSync(join(tmpdir(), "noscope-cli-"))}/db.sqlite`;
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: () => {} };
    await run(["incident", "create", "x"], {
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
