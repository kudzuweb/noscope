# Handoff: noscope round 4, the build in progress

Refreshed 2026-09-15 11:50 CDT by session mauriaparker-91 [cc4a8f] (transcript
home-laptop:~/.claude/projects/-Users-mauriaparker/da050f04-42b2-4162-9421-387ea5d066a1.jsonl),
at 75 percent of its context, mid-build. The successor is named `noscope-round4` and is you.

**First actions, in order:** (1) `/warp-pin title noscope-round4`. (2) `SendMessage` to
`mauriaparker-91` saying "noscope-round4 is up, send the pending results here". That session
stays alive as the relay until the four agents below have delivered. (3) Read this file, then
`BUILD-PLAN.md` "## Round 4" in full, then the round 4 entries at the end of
`docs/build-record.md` (R4-8, R4-1). (4) Run `git -C ~/Documents/Projects/noscope status
--short`, `git log --oneline -5`, `git worktree list`, `gh pr list --repo kudzuweb/noscope`.
(5) Continue the build as section 4 says. Mauria is awake and reads this session; her
authority to push and merge stands for the round ("go for it. authority stands", 11:10 CDT).

## 1. GOAL

Build round 4 of `BUILD-PLAN.md` (ten PRs, R4-1 to R4-10): the IC reviews a unit's work and
answers each report with accepted, revise or reassign; the IC owns the situation; session work
leaves `command`; refusals fall back to Opus 4.8 once and then go to judgment; the size-up is
scoped to the incident kind; parallel dispatch; then the fourth live run and its write-up.

## 2. HOW IT GOT THIS SHAPE

Round 3 (eleven PRs plus two run-forced fixes, PRs 28 to 39) was built overnight by this
session and run as run 003 ($4.86, three IC turns, same code path as runs 001 and 002);
write-ups in `docs/first-incident.md` "## Third run" and `docs/instructions-only-run.md`. Round
4 came from Mauria's morning rulings on 2026-09-15 (08:22 to 11:09 CDT), recorded in the quipu
thread `~/Documents/Projects/my-quipu/ics-runtime.md` and reviewed into the plan in Roughdraft:

| Ruling, her words where they matter | Where it lands |
|---|---|
| "the IC should definitely be reviewing a unit's work when it comes in! it needs to assess whether that unit is done, whether to send it back to that unit for revision, or whether a different unit would do a better job with instructions based on what the first unit found/didn't find" | R4-1 (the work behind the report), R4-2 (verdicts), R4-3 (revise), R4-4 (reassign) |
| "i want the IC to own it once it starts making the updates to it" (the situation) | R4-5 |
| "it should fallback to opus 4.8 actually"; "the retry for the fallback should be deterministic but if that also fails refusal should go back to the IC for it to apply judgment on how to proceed" | R4-7 |
| The planner after round 4 drafts only the tactics, as a suggestion for the IC ("so now the planner just makes plans to suggest to the IC right?", yes) | R4-5's role text |
| Deterministic tasks belong to whichever leader assigns them, command included (2026-09-14) | R4-6 keeps the IC's deterministic assignments, moved onto the command turn |
| The repository is public since 08:33 (for her use at work); `CLAUDE.md` at the root orients any Claude | Nothing personal in fixtures or docs |

## 3. STATE (as of this refresh)

Origin main is `9b0b863`, pushed; local main equals it; `dist/` built from it. Merged this
round: R4-8 (#40, the size-up scoped to the kind), R4-1 (#41, the work behind the report).
Open, all built, all under review or fixes:

| PR | Branch, worktree | State |
|---|---|---|
| #42 R4-6 Session work leaves command | `pr-session-work-leaves-command`, `scratchpad/wt-r4-6` | Built with the correction (assignTasks on CommandTurn, deterministic only); reviewer `review42-correctness` running. Merge first. |
| #43 R4-7 Refusals: category and Opus 4.8 fallback | `pr-refusal-fallback`, `scratchpad/wt-r4-7` | Built; reviewer `review43-correctness` running. Merge second, rebased over 42. |
| #44 R4-9 Parallel dispatch | `pr-parallel-dispatch`, `scratchpad/wt-r4-9` | Built (dispatcher rewrite); reviewer `review44-dispatch` running. Merge third, rebased over 42 and 43; expect dispatcher conflicts. |
| #45 R4-2 Report verdicts | `pr-report-verdicts`, `scratchpad/wt-r4-2` | Approved by `review45-correctness`; builder `build-r4-2` applying three small fixes (revise-plus-closeUnits refused; a comment on the close invariant; `report <id>` in review's line). At its rebase after 42 and 43: drop command's-own-report handling (the root files no report after R4-6), three-way union on CommandRuleName, asPlan as a function of assignTasks, IC_ROLE paragraph merged, EventType 46, rerun the stub test. Merge fourth. |

Results that arrived at the relay after this refresh (digests; full reports at the paths):

- PR 42 (R4-6) review, `review42-correctness`, request changes; report
  `scratchpad/review42-report.md`. (1) Validator gap, verified by a scratch run:
  `commandAsPlan.createTasks` is `[]`, so "Status is earned" never sees `assignTasks` and a
  `satisfied` turn with a grep passes, leaving the incident satisfied with a ready task; fix
  `createTasks: turn.assignTasks`, drop the duplicate "Units exist" pass at validator.ts:930,
  test it. (2) and (3) Root task results render unclipped and an insufficient one reads as
  "completed: {json}"; on the rebase over R4-1 build the "tasks under command" block from
  R4-1's `tasksCreated`, `describeEnding` and `clipBlock`, which also removes the `tasks`
  parameter colliding with R4-1's `workChars`. (4) A root task with `dependsOn` on a unit's
  task waits a cycle; fix the schema text and IC_ROLE. (5) Guard the `resumed` branch with
  `unit.parentId !== null` for a legacy waiting root. (6) "warned last cycle" repeats after a
  rejected plan; narrow or note. (7) DESIGN.md Step 5 to match IC_ROLE on assignTasks as the
  retrievable-fact path. (8) Rebase hazards: PR 45 (CommandRuleName union, `asPlan` rename,
  duplicate `IC_ACTOR`: R4-2 declares its own in runtime.ts while R4-6 imports the export from
  leader.ts); PR 43 (its root branch in `leaderTurn` is unreachable after R4-6's throw, and it
  files a runtime `unit.reported` on the root for a task refused twice, which contradicts
  "command files no report": decide to list that refusal under "tasks under command" as a
  failure); PR 44 (both root insertions must be re-placed in the rewritten `pass()`).
- PR 44 (R4-9) review, `review44-dispatch`, not mergeable as is; full report
  `scratchpad/review44-report.md` (the message truncated at finding 3). The concurrency
  machinery is sound (no read-modify-write across an await; every write in a synchronous
  batch). Two high findings: (1) the budget stop now fires on reserved rather than spent
  budget (`spent + held + need > budget`, dispatcher.ts:839-846) and `incident run` treats
  it as terminal; fix: keep round 3's stop test on spend and use the reservation only to
  defer a start until the next landing, with a landing notifier; test two units that fit one
  at a time by spend but not by reservation, both run, `stopped` null. (2) A task that lands
  after its unit reported is dropped whenever the unit has a runnable task next pass (the
  owed-turn path is skipped and the cutoff moves past the unheard ending); fix: compute the
  unheard endings once at the top of `pass` and render them before the cause in the first
  turn of the pass ("Since your last turn these tasks also ended:"), dropping `owed()`'s
  special case; test t-fast, t-slow, t-dep. (3) Rebase collisions with PRs 42 and 43 in
  `dispatch`/`runOne`: read the report's finding 3 in full for where each root insertion and
  the refusal early-return must land in the rewritten `pass()`.
- `build-r4-2` applied PR 45's three fixes (commit 819d1de, pushed); it waits for the word
  to rebase after 42 and 43.
- PR 43 (R4-7) review, `review43-correctness`, fix required; full report
  `scratchpad/review43-report.md`. Sound on its base (the snake_case stream claim re-checked
  against the binary); blocking only on the rebase: GitHub marks it conflicting, and
  test/refusal.test.ts:766 asserts a change-report line R4-1 changed on main (`- <unit>,
  report <id>: ...`). Non-blocking: (2) an assistant frame with stop_reason refusal alone
  should not mark a successful call refused; use stop_details for the category only and set
  the refusal from the system line or the envelope. (3) `incident answer` while the IC is
  held must target the refusal question (the last `question.asked` with `icRefusals`), not
  the oldest open one. (4) A task refused inside its leader's session should release that
  session with `refused: <category>` in `runTask`. (5) `spent.set` keeps only the last
  `task.usage` per task; accumulate so a retried task's refused call counts in the unit's
  share. (6) Name `task.failed`'s field `refusals` like the other events. (7) Docs: #43 in
  the header; the blocking step exits 0 (5 is the next step); DESIGN.md:665 should say a seat
  already on the fallback model blocks on its first refusal. (8) Hazards: PR 42 makes the
  `isRoot` branches in `fileRefusal`/`refusedTwice` dead; PR 44 rewrites the dispatcher, so
  whichever lands second ports the task-refusal return and the `runTask`/`runOne` changes.

All four pending results have now reached the relay; nothing is outstanding from agents.
- PR 45 (R4-2) review: approved, seven non-blocking; the fix list already went to
  `build-r4-2` (see the table above).

Not started: R4-3 (revise), R4-4 (reassign), R4-5 (the IC owns the situation), in that order
after R4-2; R4-10 (the fourth run) last. The worktrees live under the scratchpad
`/private/tmp/claude-501/-Users-mauriaparker/da050f04-42b2-4162-9421-387ea5d066a1/scratchpad/`
and belong to the relaying session's lifetime; a successor recreates any it needs with
`git worktree add -b <branch> <path> origin/<branch>` and `pnpm install --frozen-lockfile`.

The shared builder brief is `scratchpad/builder-brief.md` (round 3 rules plus a Round 4
section); if the scratchpad is gone, its substance is section 5 below plus the rulings above.

Heartbeat cron `2ba4d482` (hourly at :17) lives in the relaying session and dies with it;
create your own with `CronCreate` if you run unattended.

## 4. NEXT STEPS, IN ORDER

1. Receive the four pending results (the relay forwards them): reviews of 42, 43, 44 and
   build-r4-2's fix report. For each review: reconcile, send the fix list to the builder
   (agents `build-r4-6`, `build-r4-7`, `build-r4-9` exist and hold context; message them by
   name), push, update the PR body's "## From the review", wait for CI on the head SHA,
   squash-merge with branch deletion, pull, `pnpm build`, remove the worktree.
2. Merge order 42, 43, 44, 45, each rebased onto main by its builder (tell it what main
   has), with a second short review when a rebase changed logic (as done for R3-6 and R3-9).
3. After 45: spawn builders for R4-3, R4-4, R4-5 in order (each on main, one at a time, the
   plan block plus the rulings as the brief), review, merge.
4. R4-10: restore `~/.noscope/second-run/document.md` from `document.pristine.md`; from
   `~/Documents/Projects/roughdraftplus` (at `6a996e8`) with `NOSCOPE_DB=~/.noscope/fourth-run.sqlite`,
   `incident create` with run 003's objective, constraints and priority, the IC on Opus 5
   with the R4-7 fallback; step by hand, detached, one cycle at a time (the runner pattern is
   `~/.noscope/third-run/step.sh`); write "## Fourth run" in `docs/first-incident.md` with
   the measures beside runs 001 to 003, the verdicts by kind, what each revise or reassign
   cost and found, and the cycle wall time beside summed task seconds; a build-record entry
   for R4-10; message the quipu keeper (`quipu`, resident) with the thread and the change.
5. After every merge: refresh section 3 of this file, commit, push; message `quipu`.

## 5. WORKING AGREEMENTS (standing)

- Mauria's push and merge authority stands for round 4. Pushes of main and merges need no
  further yes. Every PR is reviewed by a subagent before merge; findings are secondhand
  until reconciled; two reviewers for a rewrite.
- One PR per plan row on its branch targeting main; a worktree per branch; reviewers work
  read-only in the worktree; builders never push or open PRs. PR body = the plan block
  verbatim, "## Deviations, with reasons", "## From the review". Build-record entry on the
  branch headed `## R4-N: <title> (#PR, merged 2026-09-15)`, the number filled at review.
- Docs travel with the change (DESIGN.md, docs/architecture.html, README, CLAUDE.md, the
  build record). Never `git add -A`. Never commit in the same command as an edit (this
  session broke that twice tonight and committed conflict markers once; the fix was an
  amend). Sentence-case commits, no emoji, no attribution. Read `pnpm check`'s exit code.
- Chat with Mauria: provenance labels, answer first, tables for parallel items, no
  em-dashes, plain full sentences; restate in full when returning to a topic.

## 6. ANCHORS

- Repo `~/Documents/Projects/noscope`, public at https://github.com/kudzuweb/noscope;
  `pnpm check`; `./bin/noscope.mjs --help`; `NOSCOPE_DB`, `NOSCOPE_CLAUDE_BIN`,
  `NOSCOPE_IC_HANDOFF_TOKENS`, `NOSCOPE_REPORT_WORK_CHARS`, `NOSCOPE_PARALLEL` (R4-9),
  `NOSCOPE_IC_FALLBACK_MODEL` (R4-7); tests use `test/stub-claude`; `NOSCOPE_LIVE=1` runs
  the live tests.
- The plan: `BUILD-PLAN.md` "## Round 4" (line 630 onward at `9b0b863`). The contract:
  `DESIGN.md`. Records: `docs/build-record.md`, `docs/first-incident.md`,
  `docs/instructions-only-run.md`.
- Code map after round 3: `src/ic.ts` (IC seat: briefing, change report, command and review
  turns, transfers, handoff), `src/leader.ts` (role texts, leader turns, holdsCapability),
  `src/dispatcher.ts` (the pass), `src/runtime.ts` (applyPlan, applyCommand, answerRequest),
  `src/validator.ts` (plan rules, command rules, leader rules), `src/planner.ts` (the ten
  sections, rules text), `src/size-up.ts` (initial IC), `src/strike-team.ts`, `src/activity.ts`
  (tool.called, subagent.ran), `src/providers/claude-code.ts` (stream-json, refusals,
  contextTokens), `src/store.ts` (schema version 6, mutations, replay), `src/review.ts`.
- Run databases: `~/.noscope/first-incident.sqlite`, `second-run.sqlite`, `third-run.sqlite`
  (incidents 001 refused, 002 satisfied). Scratch document and pristine copy under
  `~/.noscope/second-run/`. Roughdraft serves it at
  `http://localhost:7373/?path=%2FUsers%2Fmauriaparker%2F.noscope%2Fsecond-run%2Fdocument.md`.
- Quipu thread `~/Documents/Projects/my-quipu/ics-runtime.md`; keeper agent `quipu`
  (resident in the relaying session; a successor spawns its own per the quipu instructions).
  Papercuts: pc-7e69f7, pc-92ef05, pc-4aa4d5.

## 7. GOTCHAS

- A PR that conflicts with main after another merge reports no checks; a CI wait loop then
  spins forever. Check `gh pr view N --json mergeable` before waiting, and rebase first.
- Rebases between PRs that touch `docs/build-record.md` always conflict at the tail: keep
  every entry in merge order with the PR's own last. Never let a `git add` follow a failed
  resolution script in the same command.
- Facts verified on Claude Code 2.1.272 (DESIGN.md Reference): the structured-output API
  refuses a top-level oneOf (every turn schema is one strict object); systemPrompt is ignored
  on resume; a resumed call is budgeted at the whole context at cache-write rates;
  `Usage.contextTokens` is the last assistant message's context; Opus 5 refused the IC's
  resumed turns (category `reasoning_extraction`) while Sonnet 5 did not; the stream spells
  the refusal keys snake_case and the transcript camelCase (R4-7); the Bash allowlist is a
  floor in print mode; `--strict-mcp-config` is an isolation flag.
- biome reflows; exact-string edits miss; `exactOptionalPropertyTypes` is on; knip fails on
  unused exports; the Write tool is blocked on files containing exec followed by a paren.
- `timeout` is not on this machine; a foreground `sleep` is refused; poll with an `until`
  loop in a background command. `roughdraft open` blocks; run it in the background.
- Subagent reports arrive truncated at 16k; ask for the rest by `SendMessage`. And every
  agent's final text is repeated in the harness's idle notice, so brief agents to send the
  report by `SendMessage` and end with the single line `report sent`; otherwise every report
  lands twice (about 75k tokens of copies over round 3's night).
