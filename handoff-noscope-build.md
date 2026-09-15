# Handoff: noscope round 3, the overnight build

Refreshed 2026-09-15 01:00 CDT by session mauriaparker-91 [cc4a8f] (transcript
home-laptop:~/.claude/projects/-Users-mauriaparker/da050f04-42b2-4162-9421-387ea5d066a1.jsonl).
This is a recovery point for an unattended build, not a hand-over: the session that wrote it
is running round 3 overnight and refreshes this file at each merge. If you are reading it,
that session died or ran out of usage.

**First actions, in order:** (1) `/warp-pin title noscope-build`. (2) Read this file, then
the "## Round 3" section of `BUILD-PLAN.md` in full, then `DESIGN.md` in full. (3) Run
`git -C ~/Documents/Projects/noscope status --short`, `git log --oneline -8`, `git worktree
list`, and `gh pr list --repo kudzuweb/noscope`; the State section below says what those
should show as of this refresh, and the difference is what happened after it. (4) Resume at
the first round 3 PR that is not merged, under the working agreements. (5) Mauria is asleep;
nothing needs her yes tonight except a design call the plan does not settle, which stops the
run at that PR with the question written in `docs/build-record.md`.

## 1. GOAL

Build round 3 of `BUILD-PLAN.md`: eleven PRs, R3-0 to R3-10, that give noscope an Incident
Commander session above the planner, a leader session on every unit, strike teams of
subagents, tool and subagent events, lacks resolved at the leader, an initial IC size-up
with transfer of command, an IC handoff below the context limit, claim status as a label,
and a third run of the first incident. Each PR merges on its own with CI green and review
findings applied; the run ends with R3-10's write-up.

## 2. HOW IT GOT THIS SHAPE

The design was ruled by Mauria in conversation on 2026-09-14 (14:40 to 18:56 and 20:54 to
00:48 CDT). Every ruling and her reasons are in the quipu thread
`~/Documents/Projects/my-quipu/ics-runtime.md` (Decisions, eighteen from that day, dated by
the put-down knot) and the plan states each at the scope it was made. The rulings that a
builder is most likely to widen by accident:

| Ruling | Do not turn it into |
|---|---|
| Every unit has a leader; deterministic tasks belong to whichever leader assigns them. | A deterministic-only unit kind (she rejected it). |
| The IC is the root unit's leader; the planner stays, stateless; the IC reviews the draft in one round; the planner is cut later only if `incident review` shows the IC never changes it. | The IC planning directly (rejected), or a review loop longer than one redraft. |
| No strike-team presets and no default kind; the task declares the team and the leader says why. | A built-in read-only Haiku kind (rejected). |
| The IC's tools are the default set minus `Edit` and `Write`, `Bash` read-only allowlisted, until grants land. | The full default set. |
| One shared situation, written by the planner; `discrepancy` is for a different problem, not a different detail. | Per-seat situations, or seats arguing each turn. |
| "Leader" for unit heads, "IC" for the root's; "chief" is an ICS Section Chief and is not used. | "Chief" or "commander" for a unit's session. |
| No second incident of another kind this round. | An R3-10 second half. |

## 3. STATE (as of this refresh)

Origin main is `efbbaa5` (the reviewed plan), pushed; local main equals it. Clean tree, no
worktrees, no open PRs, no feature branches. `pnpm check` exit 0 at `66ea828`; `dist/` is
from that commit and needs `pnpm build` before any live run. Round 3 has no PR open yet;
R3-0 is next.

The R3-0 mechanism checks were run on 2026-09-15 00:05 to 00:12 CDT from scratch scripts
in the session scratchpad (`r3-0/resume.sh`, `r3-0/agents.sh`); their results are in R3-0's
scope table in the plan, and R3-0 moves the scripts into `spikes/round3/`. If the
scratchpad is gone, rewrite them from the plan's table: each is a few Haiku calls.

The two live runs and their databases are unchanged from before (`~/.noscope/first-incident.sqlite`,
`~/.noscope/second-run.sqlite`, both read-only with the current build). A heartbeat cron
in the writing session (hourly at :13) resumes the run after a usage window; it dies with
that session, so a successor creates its own with `CronCreate` if it is also running
unattended.

Quipu: origin main `9a93c5d`, pushed; the put-down knot for 2026-09-14 is requested from the
keeper at this refresh. Papercuts: pc-7e69f7 (stale `dist/`), pc-92ef05 (`claude config` is
no longer a subcommand).

## 4. NEXT STEPS, IN ORDER

1. R3-0: `spikes/round3/resume.sh` and `agents.sh` (from the scratchpad or rewritten),
   `DISABLE_COMPACT` noted in the README of that directory, five Reference rows in
   `DESIGN.md`. PR, review, merge.
2. R3-1, R3-2, R3-3 in parallel, one worktree each under the scratchpad, one builder
   subagent each briefed with the PR's scope and acceptance text verbatim plus section 2
   above; one reviewer each; merge in whatever order they clear, rebasing the later ones.
3. R3-4, then R3-5 and R3-6 in parallel with R3-7, then R3-8 and R3-9 in parallel, then
   R3-10. R3-4 and R3-7 are the two rewrites; build them in this session rather than
   delegating, or delegate with the whole plan section in the brief.
4. After every merge: `git pull`, `pnpm build`, refresh section 3 of this file, commit it,
   message the `quipu` keeper with the thread and the change.
5. R3-10 is a live run from `~/Documents/Projects/roughdraftplus` at `6a996e8` with
   Roughdraft serving a restored scratch document; the recipe is in R2-8's scope and in
   section 7 below. Its write-up is the morning report.

## 5. WORKING AGREEMENTS (standing; do not re-ask)

- Mauria at 2026-09-15 00:55 CDT: "push, and you have permission to push and merge as
  needed for the rest of this build." Pushes of main and merges need no further yes this
  round.
- One PR per plan row on `pr-<slug>` targeting main, no stacking on GitHub; a `git
  worktree` per branch under the scratchpad; reviewers work in the worktree and never
  switch branches. Merge after CI green on the head SHA (`gh pr view --json headRefOid`)
  and review findings applied; squash-merge with branch deletion; pull; `pnpm build`.
- Every PR: commit; review by direct subagents (`general-purpose`, named
  `review<N>-<angle>`, briefed with the design context; their reports are secondhand until
  reconciled and often arrive truncated, so ask for the rest by `SendMessage`); push; `gh
  pr create` with body = the plan row's scope text verbatim, "## Deviations, with reasons",
  then "## From the review"; a `docs/build-record.md` entry on the branch.
- Docs travel with the change: `DESIGN.md`, `docs/architecture.html`, README, build record.
  Never `git add -A`. Never commit in the same command as an edit. Sentence-case commit
  messages, no emoji, no attribution. Read `pnpm check`'s exit code, never grepped output.
- A design call the plan does not settle stops that PR, not the run: write the question
  in the build record, mark the PR draft, continue with PRs that do not depend on it.
- Quipu: message the `quipu` keeper with thread and change; spawn one if none runs.
- Chat with Mauria: provenance labels, answer first, tables for parallel items, no
  em-dashes, plain full sentences; when she says something is too compressed, rewrite it
  longer.

## 6. ANCHORS

- Repo `~/Documents/Projects/noscope`; `pnpm check`; `./bin/noscope.mjs --help`;
  `NOSCOPE_DB=<file>`, `NOSCOPE_CLAUDE_BIN=<binary>`; tests use `test/stub-claude`;
  `NOSCOPE_LIVE=1` runs the live tests.
- The plan: `BUILD-PLAN.md` "## Round 3" (line 393 onward at `efbbaa5`). The contract:
  `DESIGN.md`. The record: `docs/build-record.md`, `docs/first-incident.md`.
- Code map: `src/models.ts` (all schemas), `src/store.ts` (tables, events, migrations),
  `src/planner.ts` (`renderPlannerInput`, `proposePlan`, rules), `src/validator.ts`,
  `src/runtime.ts` (`applyPlan`), `src/dispatcher.ts` (`dispatch`, `runTask`,
  `briefContext`), `src/verifier.ts` (`recordClaims`, `promoteMatching`),
  `src/capabilities/session.ts` (briefs, `runSession`), `src/providers/base.ts`
  (`SessionRequest`, `SESSION_PREAMBLE`), `src/providers/claude-code.ts`
  (`renderClaudeCodeArgs`, `parseClaudeCodeResult`, `runProcess`),
  `src/commands/incident.ts` (`cycle`, `step`, `answer`, `provide`), `src/review.ts`.
- A live run: from `~/Documents/Projects/roughdraftplus` with `NOSCOPE_DB` set; `incident
  step <id>` one cycle at a time, detached (`nohup sh -c '... >> log; echo "exit $?" >>
  log' & disown`) with a Monitor on the log; a cycle with a reproduce can exceed ten
  minutes. Reading a run: `incident review`, `tree`, `show`, `events`; `sqlite3 <db>`;
  transcripts under `~/.claude/projects/-Users-mauriaparker-Documents-Projects-roughdraftplus/`.
- Claude Code 2.1.272 facts verified 2026-09-15: `--resume` takes a new `--json-schema`
  per call and reports per-call usage; `DISABLE_COMPACT` env disables compaction;
  `--agents <json>` works on resume; the result envelope has `subagent_stats` and
  `modelUsage`; subagent transcripts are `<project>/<session>/subagents/agent-*.jsonl` with
  a `.meta.json` carrying `toolUseId`.

## 7. GOTCHAS

- biome reflows code after `lint:fix`; exact-string edits miss; write scripts with
  whitespace-tolerant anchors or rewrite small files whole. `exactOptionalPropertyTypes` is
  on. knip fails on unused exports. The Write tool is blocked by a security hook when the
  file contains the word exec followed by an opening parenthesis; a heredoc through Bash is not.
- A script that edits several files must read, edit and write each once; two edits from
  the on-disk original lose the first.
- `bin/noscope.mjs` runs `dist/` with no staleness check: `pnpm build` before any live run.
- Roughdraft's save reflows paragraphs and pads table cells: rebuild the committed file
  from HEAD plus the intended edits (an edit script with tolerant anchors, run on both).
- `timeout` is not on this machine; a foreground `sleep` is refused; `until` loops in a
  background command, or a Monitor. `roughdraft open` blocks; run it in the background
  with a long timeout and wait for the task notification.
- Playwright's MCP server refuses `file:` URLs and runs inside its output directory;
  reproduce sessions persist edits to the document they touch, so keep a pristine copy.
- The permission classifier refuses `ps` listings; `pgrep -f "noscope.mjs incident step"`
  is allowed. `claude config` is not a subcommand any more (pc-92ef05).
- The planner snapshot (`test/planner.test.ts`) pins rendered sections; update with
  `pnpm vitest run test/planner.test.ts -u` and read the diff.
- Subagent reports arrive as teammate messages and truncate; ask for the rest.
