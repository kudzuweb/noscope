# Handoff: noscope round 4, the build in progress

Refreshed 2026-09-15 15:33 CDT by session noscope-round4 [f7cb98], mid-build, nine of
thirteen merged. Written by the successor session; the relay session mauriaparker-91 has stopped.

**First actions, in order:** (1) `/warp-pin title noscope-round4-<n>`. (2) Read this file,
then `BUILD-PLAN.md` "## Round 4" in full (rows R4-10 to R4-12 are new; the fourth run is now R4-13), then the round 4
entries at the end of `docs/build-record.md`. (3) Run `git -C ~/Documents/Projects/noscope
status --short`, `git log --oneline -5`, `git worktree list`, `gh pr list --repo
kudzuweb/noscope`. (4) Spawn your own `quipu` keeper per the quipu instructions and a
heartbeat cron; the agents named in section 3 belong to the session that wrote this and
cannot take your messages, so spawn fresh builders, briefing each with the builder brief
and its plan block or review report. (5) Continue the build as section 4 says. Mauria's
authority to push and merge stands for the round ("go for it. authority stands", 11:10 CDT;
"you have permission to merge for this build", 12:46 CDT).

## 1. GOAL

Build round 4 of `BUILD-PLAN.md` (thirteen PRs, R4-1 to R4-13; the fourth run is R4-13): the IC reviews a unit's work and
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

Origin main is `5a225a0` (R4-5, #48), pushed; local main equals it; `dist/` built from it.
Merged this round, in order: R4-8 (#40), R4-1 (#41), R4-6 (#42), R4-7 (#43), R4-9 (#44),
R4-2 (#45), R4-3 (#46), R4-4 (#47), R4-5 (#48, 15:15). Nine of thirteen. Open: none on
GitHub. Building:

| Row | Branch, worktree | State |
|---|---|---|
| R4-10 Unit types: the form, the filled form, the protocol | `pr-unit-types`, `scratchpad/wt-r4-10` | Builder `build-r4-10` running since 15:16 on the round's structural PR (the IC as its own type, `src/units/` registry, every `parentId === null` guard out of the dispatcher). On its report: push, open the PR, two reviewers, fixes, merge. |

Rulings by the orchestrator in review, shown to Mauria and not reversed: a plan cannot close
a unit whose revise is undelivered (R4-3); the IC can drop a reassignment on a later turn
(`dropReassignments`) and a `failed` plan owes no taker (R4-4).

Rulings since the 11:50 refresh, all Mauria's, 2026-09-15:

| Ruling | Where it lands |
|---|---|
| 12:31 to 13:11: the IC is not a special case of the led unit. A unit is a type plus a config: the type is the form (the fields a kind of unit fills) plus the protocol (how it uses what is in the box, its own module); the config is the filled form. `base` is today's led unit, `ic` the root; a config keeps its type's protocol; recurring configs are saved and deployed by name (ICS resource typing is the planner outfitting a unit; a saved config is its product). Both before the fourth run: "I want the missteps re: the IC fully rectified before the next test." | `BUILD-PLAN.md` rows R4-10 (unit types) and R4-11 (saved unit configs), depending on R4-5, R4-7, R4-9; "type" and "config" are the plan's words, not names the code must use. |
| 12:44: round 4's built PRs are not reoriented; they merge as built. | Done for 42, 43, 44. |
| 12:46: merge permission granted for this build, after the auto-mode classifier refused `gh pr merge` as "Merge Without Review". | `gh pr merge` runs without a prompt now. |
| Decided by this session at 12:25, shown to Mauria, not reversed: a root task refused twice ends as its `task.failed` with `refusals` under "tasks under command"; command files no report. | Merged in #43; becomes the `ic` protocol's definition under R4-10. |
| Open, asked 13:28: whether to record each session call's rendered prompt as a `call.made` event so what a seat received lives in the database rather than only in Claude Code's transcript. | Not a blocker; add a row if she says yes. |

The builder brief (`scratchpad/builder-brief.md`) carries these rulings. Agents in this
session: builders `build-r4-6`, `build-r4-7`, `build-r4-9`, `build-r4-2`, `build-r4-3`,
`build-r4-4` and reviewers `review43-rebase`, `review44-rebase`, `review45-rebase`,
`review46-correctness`, `review47-correctness`, `review48-correctness`, builders `build-r4-5`
(idle, hold context), `build-r4-10` (running), `quipu` (the keeper; last write 1da1f81). Heartbeat cron `53cbb702` hourly at :23.

Not started: R4-11, R4-12, in that order after R4-10; R4-13 (the fourth run) last. The one worktree lives under
this session's scratchpad `/private/tmp/claude-501/-Users-mauriaparker-Documents-Projects-noscope/5c3f3ef0-a43b-4a43-b0d5-afcbc0e7673c/scratchpad/`;
a successor recreates any it needs with `git worktree add -b <branch> <path> origin/<branch>`
and `pnpm install --frozen-lockfile`.

## 4. NEXT STEPS, IN ORDER

1. R4-10: on `build-r4-10`'s report, verify `pnpm check`, push, open the PR (body = plan block,
   deviations, From the review), spawn two reviewers, reconcile, fixes through the builder,
   fill the body, CI, `gh pr merge N --squash --delete-branch --match-head-commit <sha>`,
   pull, `pnpm build`.
2. Spawn builders for R4-11, R4-12 in order, one at a time, each on a
   fresh worktree from main (`git worktree add -b <branch> <path> origin/main`), briefed with
   the builder brief plus its plan block; review each by a subagent; merge. Before R4-5's
   brief, confirm the brief's situation sentence (already updated). R4-10 and R4-11 get two
   reviewers each (a rewrite).
3. R4-13: restore `~/.noscope/second-run/document.md` from `document.pristine.md`; from
   `~/Documents/Projects/roughdraftplus` (at `6a996e8`) with `NOSCOPE_DB=~/.noscope/fourth-run.sqlite`,
   `incident create` with run 003's objective, constraints and priority, the IC on Opus 5
   with the R4-7 fallback; step by hand, detached, one cycle at a time (the runner pattern is
   `~/.noscope/third-run/step.sh`); write "## Fourth run" in `docs/first-incident.md` with
   the measures beside runs 001 to 003, the verdicts by kind, what each revise or reassign
   cost and found, and the cycle wall time beside summed task seconds; a build-record entry
   for R4-13; message `quipu` with the thread and the change.
4. After every merge: refresh section 3 of this file, commit, push; message `quipu`.

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
