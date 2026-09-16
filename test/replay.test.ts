import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";
import { renderPlannerInput } from "../src/planner.js";
import { claudeCodeProvider } from "../src/providers/index.js";
import { Store } from "../src/store.js";

// Run 004's record (docs/first-incident.md "## Fourth run"), written before R5-1, holds
// 216 claims: 162 written by four deterministic tasks and 54 asserted by sessions. The
// incident file rendered from it lists the 54 claims and one evidence line per completed
// deterministic task, and review counts both. The record is not in the repository:
// NOSCOPE_REPLAY_DB names a copy of it (never the original, which a migration would write
// to), and the test copies that copy again before opening it.
const source = process.env.NOSCOPE_REPLAY_DB;

describe("replay of run 004's record (R5-1)", () => {
  it.skipIf(source === undefined)(
    "renders the incident file with 54 claims and four evidence lines, and review counts them",
    async () => {
      if (source === undefined) throw new Error("NOSCOPE_REPLAY_DB is set");
      const dir = mkdtempSync(join(tmpdir(), "noscope-replay-"));
      const db = join(dir, "replay.sqlite");
      copyFileSync(source, db);
      const store = new Store(db);
      const incident = store.getIncident("001");
      if (incident === undefined) throw new Error("run 004 is incident 001");
      const claims = store.listClaims("001");
      expect(claims.filter((c) => c.status === "verified")).toHaveLength(162);
      expect(claims.filter((c) => c.status === "asserted")).toHaveLength(54);
      const file = renderPlannerInput(store, incident, [
        claudeCodeProvider("claude"),
      ]);
      store.close();
      const section = file.slice(
        file.indexOf("## 2. Claims and evidence"),
        file.indexOf("## 3. Unit tree"),
      );
      const claimLines = section
        .slice(0, section.indexOf("evidence, each attached"))
        .split("\n")
        .filter((l) => l.startsWith("  - "));
      const evidenceLines = section
        .slice(section.indexOf("evidence, each attached"))
        .split("\n")
        .filter((l) => l.startsWith("  - "));
      expect(claimLines).toHaveLength(54);
      expect(claimLines.every((l) => l.includes("(asserted, "))).toBe(true);
      expect(evidenceLines.map((l) => l.slice(0, l.indexOf(" (")))).toEqual([
        "  - 001-t01",
        "  - 001-t02",
        "  - 001-t03",
        "  - 001-t08",
      ]);
      expect(evidenceLines[0]).toMatch(/: 74 matches in \d+ files$/);
      expect(evidenceLines[1]).toMatch(/: 80 matches in \d+ files$/);
      expect(evidenceLines[2]).toMatch(
        /: 10 commits, \d+ working-tree changes?, on \S+$/,
      );
      expect(evidenceLines[3]).toMatch(/: 5 matches in \d+ files?$/);
      const out: string[] = [];
      const ctx = {
        io: { out: (l: string) => out.push(l), err: () => {} },
        cwd: dir,
        env: { NOSCOPE_DB: db },
      };
      expect(await run(["incident", "review", "001"], ctx)).toBe(EXIT.ok);
      expect(out).toContain(
        "claims: 54 from sessions, 44 observed, 10 inferred, 0 rejected; evidence: 4 deterministic result(s)",
      );
      expect(
        out.filter((l) => / \(deterministic\): .* evidence /.test(l)),
      ).toHaveLength(4);
    },
  );

  // Run 004's size-up asked its two questions at `create` (seat initial_ic), before
  // R5-8 made them proposals; the file and the review say so rather than "not yet
  // ruled on".
  it.skipIf(source === undefined)(
    "show and review say the briefing's questions were asked at create by the initial IC, before R5-8",
    async () => {
      if (source === undefined) throw new Error("NOSCOPE_REPLAY_DB is set");
      const dir = mkdtempSync(join(tmpdir(), "noscope-replay-"));
      const db = join(dir, "replay.sqlite");
      copyFileSync(source, db);
      const out: string[] = [];
      const ctx = {
        io: { out: (l: string) => out.push(l), err: () => {} },
        cwd: dir,
        env: { NOSCOPE_DB: db },
      };
      expect(await run(["incident", "show", "001"], ctx)).toBe(EXIT.ok);
      const proposed = out.indexOf(
        "questions the briefing proposed for Mauria, as the IC ruled:",
      );
      expect(proposed).toBeGreaterThan(-1);
      expect(out[proposed + 1]).toMatch(
        /^ {2}- 1\. .*\?: asked at create by the initial IC, before R5-8, as 001-q01$/,
      );
      expect(out[proposed + 2]).toMatch(
        /^ {2}- 2\. .*\?: asked at create by the initial IC, before R5-8, as 001-q02$/,
      );
      out.length = 0;
      expect(await run(["incident", "review", "001"], ctx)).toBe(EXIT.ok);
      expect(
        out.filter((l) =>
          /^ {2}question proposed \d: .*: asked at create by the initial IC, before R5-8, as 001-q0\d$/.test(
            l,
          ),
        ),
      ).toHaveLength(2);
      expect(out).toContain(
        "briefing questions: 2 proposed, 0 accepted and asked, 0 discarded, 0 answered by the IC, 2 asked at create by the initial IC (before R5-8)",
      );
    },
  );
});
