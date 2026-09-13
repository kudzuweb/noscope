import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bashAllowlist,
  isBuiltinTool,
  listEquipment,
  runEquipment,
} from "../src/equipment/index.js";

const tree = resolve("test/fixtures/tree");

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "noscope-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "First commit");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git("commit", "-q", "-am", "Second commit");
  writeFileSync(join(dir, "b.txt"), "new\n");
  return dir;
}

describe("equipment", () => {
  it("registers the seven function equipment items with cost facts", () => {
    expect(listEquipment().map((e) => e.name)).toEqual([
      "git_diff",
      "git_log",
      "git_status",
      "grep_files",
      "list_directory",
      "read_file",
      "run_readonly",
    ]);
    for (const e of listEquipment())
      expect(e.cost.typicalSeconds).toBeGreaterThan(0);
  });

  it("reads a file and reports truncation", async () => {
    const full = (await runEquipment("read_file", {
      path: join(tree, "a.txt"),
    })) as { text: string; truncated: boolean; bytes: number };
    expect(full.text).toContain("delete handler");
    expect(full.truncated).toBe(false);
    const cut = (await runEquipment("read_file", {
      path: join(tree, "a.txt"),
      maxBytes: 5,
    })) as { text: string; truncated: boolean };
    expect(cut.text).toBe("alpha");
    expect(cut.truncated).toBe(true);
  });

  it("lists a directory with kinds and sizes", async () => {
    const out = (await runEquipment("list_directory", { path: tree })) as {
      entries: { name: string; kind: string; bytes: number | null }[];
    };
    expect(out.entries).toEqual([
      { name: "a.txt", kind: "file", bytes: 42 },
      { name: "sub", kind: "directory", bytes: null },
    ]);
  });

  it("greps recursively with file, line and text, honoring glob and case", async () => {
    const out = (await runEquipment("grep_files", {
      root: tree,
      pattern: "delete|nothing",
    })) as { matches: { file: string; line: number; text: string }[] };
    expect(out.matches).toEqual([
      { file: "a.txt", line: 2, text: "the delete handler lives here" },
      { file: "sub/b.md", line: 1, text: "nothing to see" },
    ]);
    const md = (await runEquipment("grep_files", {
      root: tree,
      pattern: "NOTHING",
      glob: "*.md",
      ignoreCase: true,
    })) as { matches: unknown[] };
    expect(md.matches).toHaveLength(1);
  });

  it("validates inputs against the equipment's schema", async () => {
    await expect(runEquipment("grep_files", { root: tree })).rejects.toThrow();
    await expect(runEquipment("no_such_equipment", {})).rejects.toThrow(
      /no equipment/,
    );
  });

  it("runs only allowlisted read-only commands", async () => {
    const out = (await runEquipment("run_readonly", {
      command: "wc",
      args: ["-l", "a.txt"],
      cwd: tree,
    })) as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toMatch(/^3 a\.txt$/);
    await expect(
      runEquipment("run_readonly", {
        command: "rm",
        args: ["-rf", "/"],
        cwd: tree,
      }),
    ).rejects.toThrow();
    const failing = (await runEquipment("run_readonly", {
      command: "cat",
      args: ["missing.txt"],
      cwd: tree,
    })) as { exitCode: number; failure: null };
    expect(failing.exitCode).not.toBe(0);
    expect(failing.failure).toBeNull();
  });

  it("refuses the find primaries that write, and names a timeout or an overflow", async () => {
    await expect(
      runEquipment("run_readonly", {
        command: "find",
        args: [".", "-name", "a.txt", "-delete"],
        cwd: tree,
      }),
    ).rejects.toThrow(/not read-only/);
    await expect(
      runEquipment("run_readonly", {
        command: "find",
        args: [".", "-exec", "touch", "x", ";"],
        cwd: tree,
      }),
    ).rejects.toThrow(/not read-only/);
    const slow = (await runEquipment("run_readonly", {
      command: "tail",
      args: ["-f", "a.txt"],
      cwd: tree,
      timeoutSeconds: 0.2,
    })) as { exitCode: number | null; failure: string; stderr: string };
    expect(slow.failure).toBe("timeout");
    expect(slow.exitCode).toBeNull();
    expect(slow.stderr).toMatch(/killed after 0.2s/);
    const big = (await runEquipment("run_readonly", {
      command: "cat",
      args: ["a.txt"],
      cwd: tree,
      maxBytes: 10,
    })) as { failure: string; stdout: string };
    expect(big.failure).toBe("output_too_large");
    expect(big.stdout.length).toBeLessThanOrEqual(10);
    await expect(
      runEquipment("run_readonly", {
        command: "ls",
        cwd: join(tree, "nope"),
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("reads git status, log and diff from a fixture repository", async () => {
    const repo = fixtureRepo();
    const status = (await runEquipment("git_status", { cwd: repo })) as {
      branch: string;
      changes: { status: string; path: string }[];
    };
    expect(status.branch).toBe("main");
    expect(status.changes).toEqual([
      { status: "??", path: "b.txt", from: null },
    ]);
    const log = (await runEquipment("git_log", { cwd: repo, limit: 5 })) as {
      commits: { subject: string; hash: string }[];
    };
    expect(log.commits.map((c) => c.subject)).toEqual([
      "Second commit",
      "First commit",
    ]);
    expect(log.commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    const diff = (await runEquipment("git_diff", {
      cwd: repo,
      from: "HEAD~1",
      to: "HEAD",
    })) as { diff: string; truncated: boolean };
    expect(diff.diff).toContain("+two");
    expect(diff.truncated).toBe(false);
  });

  it("git_status names the branch on an unborn or detached HEAD and reads renames and quoted paths", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "noscope-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: fresh, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    const unborn = (await runEquipment("git_status", { cwd: fresh })) as {
      branch: string;
      detached: boolean;
    };
    expect(unborn).toMatchObject({ branch: "main", detached: false });
    writeFileSync(join(fresh, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "First");
    git("mv", "a.txt", "renamed.txt");
    writeFileSync(join(fresh, "caf\u00e9 space.txt"), "x\n");
    git("checkout", "-q", "--detach");
    const detached = (await runEquipment("git_status", { cwd: fresh })) as {
      branch: string;
      detached: boolean;
      changes: { status: string; path: string; from: string | null }[];
    };
    expect(detached).toMatchObject({ branch: "HEAD", detached: true });
    expect(detached.changes).toEqual([
      { status: "R", path: "renamed.txt", from: "a.txt" },
      { status: "??", path: "caf\u00e9 space.txt", from: null },
    ]);
  });

  it("git_diff and git_log refuse option-shaped revisions and paths, and git_diff caps by bytes", async () => {
    const repo = fixtureRepo();
    await expect(
      runEquipment("git_diff", { cwd: repo, from: "--output=/tmp/x" }),
    ).rejects.toThrow(/cannot start with -/);
    await expect(
      runEquipment("git_log", { cwd: repo, path: "--all" }),
    ).rejects.toThrow(/cannot start with -/);
    writeFileSync(join(repo, "a.txt"), "\u00e9\u00e9\u00e9\u00e9\n");
    const cut = (await runEquipment("git_diff", {
      cwd: repo,
      maxBytes: 40,
    })) as { diff: string; truncated: boolean };
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.diff)).toBeLessThanOrEqual(40);
    const whole = (await runEquipment("git_diff", { cwd: repo })) as {
      diff: string;
      truncated: boolean;
    };
    expect(whole.truncated).toBe(false);
    expect(whole.diff).toContain("+\u00e9\u00e9\u00e9\u00e9");
  });

  it("names the provider built-in tools and renders the Bash allowlist", () => {
    expect(isBuiltinTool("Grep")).toBe(true);
    expect(isBuiltinTool("Write")).toBe(false);
    expect(isBuiltinTool("grep_files")).toBe(false);
    expect(bashAllowlist(["ls", "cat"])).toEqual(["Bash(ls *)", "Bash(cat *)"]);
    expect(bashAllowlist()).toHaveLength(7);
  });
});
