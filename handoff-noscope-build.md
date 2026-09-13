# Handoff: noscope, v0 built and first incident run; the audit is next

Refreshed 2026-09-13 09:50 CDT by session mauriaparker-97 [22585b] (transcript
home-laptop:~/.claude/projects/-Users-mauriaparker/8befa8f7-a5b0-4c68-a2ba-73ed4aa7199f.jsonl),
which took over from the design session at 00:23 and built PRs 6 through 15. Read this whole
file before doing anything.

**First actions, in order:** (1) `/warp-pin title noscope-audit`, the name this session was
launched with. (2) One `SendMessage` to `mauriaparker-97 [22585b]` saying "noscope-audit is up,
send the pending results here". Nothing is pending from background agents (every reviewer
finished and every report was applied), so that message is only the readiness signal.

## 1. GOAL

Audit the first incident's run and decide, with Mauria, what to build from it before using
noscope on roughdraft, quipu and the codebase scan. Mauria's questions (09:32): what models
were used for what, tokens and cost, were all the steps necessary, was the reasoning sound,
does ICS have a post-mortem protocol. The answer was given (digest in §4); a proposal is
waiting for her go-ahead (§5).

## 2. WHAT NOSCOPE IS (the settled design; DESIGN.md is the contract)

An agent runtime with the Incident Command System as its primitive. Vocabulary, all ICS's
own except claim, fought over and not to be reopened: incident (anything asked for), unit
(a box in the incident's temporary tree; root is `<id>-command`), task (owned by one unit,
bound to one capability), capability (declared equipment plus, when judgment is needed, a
session; deterministic ones produce verified claims, session-backed ones asserted), equipment
(the primitive, never assigned), claim (subject, predicate, object, status asserted or
verified or rejected, confidence, evidence, provenance), action plan, planner (Planning
Section; one Opus 5 call per cycle), validator (12 rules, Step 5), provider (Claude Code
first; Codex untested), SOP, grant, budget (after v0 mostly), incident file. Mauria is the
Agency Administrator. The cycle (`incident step`): observe, plan, validate, apply, dispatch,
verify, record, stop. Four channels for what the planner lacks: a task, a grant request, a
capability request, a question for a human (`incident answer` reopens).

Stack: TypeScript, Node 24, pnpm, zod 4, better-sqlite3, biome, vitest, knip, CI runs `pnpm
check`. Repo https://github.com/kudzuweb/noscope (private).

## 3. STATE

All fifteen build-plan PRs plus a docs PR (#16) are merged; main is `fb17e96`, clean, no
branches. `pnpm check` exit 0, 115 tests. Every PR from 10 on was reviewed by direct
subagents before merge with findings applied and listed in `docs/build-record.md` (the
`/code-review` skill's orchestrator stalls before its verify stage; do not use it).

The first incident (Step 8: why Roughdraft scrolls to the bottom comment after a delete)
ran live on the real Claude Code provider from `~/Documents/Projects/roughdraftplus` on
`NOSCOPE_DB=~/.noscope/first-incident.sqlite`, incident `001`, twelve cycles, 13:33 to
14:27 UTC, ended `satisfied`. Record: `docs/first-incident.md` (answer, cycle table, totals,
the eight criteria, event excerpts). Two tuning changes came out of it and are merged:
planner section 8 shows each capability's input fields (nested shapes, unions, enums,
literals), and claims get positional ids `001-c381` instead of UUIDs. No prompt text changed.

Root cause found (verified from source except two runtime links): `deleteComment` at
`packages/app/src/PageCard.tsx:1884` runs a TipTap chain starting with a bare `focus()`,
whose default scrolls the existing selection into view; the selection rests at the document
end because the mount effect at lines 1421-1422 calls `setContent` (YAML endmatter makes the
JSON differ) and the full-range replace maps the caret to the end; nothing on the delete path
moves it. Fix shape: `focus(undefined, { scrollIntoView: false })` as `focusComment` does at
2054/2065. Recorded on the quipu roughdraft thread. Mauria's answer to the one question
("no, it happens after every deleted comment") falsified the planner's earlier inferred link
(selection on the last-added comment) and produced the document-end finding.

Quipu: `~/Documents/Projects/my-quipu/ics-runtime.md` Head current to 09:27 with a knot for
this stretch; `roughdraft.md` carries the defect's cause. Commit `045c88c` and `aa60f2f`.

## 4. THE AUDIT, AS DELIVERED (09:45; from the event log, verified)

| Role | Model | Calls | Input | Output | Time |
|---|---|---|---|---|---|
| Planner | Opus 5 | 12 | 1.09M | 74k | 15.5 min |
| investigate | Opus 5 | 3 | 2.24M | 86k | 15.9 min |
| investigate | Sonnet 5 | 2 | 0.55M | 20k | 3.2 min |
| interpret | Opus 5 | 2 | 15k | 15k | 2.6 min |
| deterministic | none | 22 | 0 | 0 | 2 s |

Planner input per cycle: 4k, 7k, 91k, 99k, 101k, 103k, 105k, 106k, 111k, 108k, 122k, 130k
(the 291 grep claims of cycle 2 ride in every later prompt). Cost: subscription quota, not
dollars; at API rates (claude-api skill table cached 2026-06-24: Opus 5 $5/$25, Sonnet 5
$2/$10 per MTok, cache reads ~0.1x) roughly $7 to $22; the range is wide because the provider
collapses uncached, cache-write and cache-read tokens into one `inputTokens` and drops
`total_cost_usd` (an audit gap to fix).

Necessity: cycles 1 and 5 wasted on planner-input gaps (fixed); cycle 2's greps too broad;
cycle 3's four `read` tasks redundant with the two Opus traces; cycles 6 and 8 (about 9 min)
chased a link only a browser can prove; cycle 9's question was askable at cycle 3; cycles
10-12 productive. About 14 of 54 minutes avoidable; 15 minutes are planner overhead (78 s per
Opus call). Reasoning: sound at the end; wrong from cycle 6 to 9, holding a false link at
confidence 0.85 while verifying a different one. Lessons: session confidence is not
calibrated; verify the link whose failure changes the conclusion; ask the human as soon as a
link is unprovable from the repository. Promotion by exact triple never fired (0 of many
`claimsToVerify`); planner tokens do not count against the budget.

ICS: the After Action Review (Army origin; what was planned, what happened, why, what to
sustain or improve), hot wash (immediate), After Action Report with Improvement Plan (FEMA,
formal). The ICS-214 Activity Log feeds the AAR; noscope's event log is its ICS-214.
Sources given to Mauria: FEMA ICS forms descriptions PDF, FEMA preptoolkit AAR page,
Wikipedia After-action review and Incident Command System.

## 5. NEXT STEP, IN ORDER

Mauria has not yet answered the proposal. Wait for her ruling on these three, then build
the ones she takes as PRs on `main` (branch `pr-<slug>`, review by direct subagents, merge on
green; standing merge permission covers "this build plan", so ask whether it extends):

1. `noscope incident review <id>`: deterministic AAR from the log (per-cycle plan, verdict,
   tasks, models, tokens, seconds, claims; per-model totals; rejections; questions; cost
   estimate at API rates). Small; the numbers above were computed by
   `/private/tmp/.../scratchpad/audit.cjs`, which is gone with the session, so rewrite it as
   `src/commands/review.ts` or similar, reading `plan.proposed.usage`, `task.usage`,
   `plan.rejected`, tasks' model, claims' provenance.
2. Store the usage split (uncached, cache write, cache read) and the provider's
   `total_cost_usd` on every `task.usage` and `plan.proposed` event: `Usage` in
   `src/models.ts`, `parseClaudeCodeResult` in `src/providers/claude-code.ts` (the envelope
   has `usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
   `output_tokens`, `total_cost_usd`), `sumUsage` in `src/store.ts`; DESIGN.md and the
   models test (`Usage` shape) follow.
3. A session-backed `review` capability answering the four AAR questions from the log.
   First use of noscope on itself; design it with her.

Then her scheduled revisit: Opus as planner and the Step 5 rules accepted "for now";
promotion needing a looser notion of "established" (or the planner proposing the exact
triple); grep's per-match claims (what a claim carries; the `read` claim carries whole file
text too); planner tokens versus budget; two validator design calls (closing a unit whose
child still runs a task passes; two tasks that each fit the budget but together exceed it
pass). All on the quipu thread's open items. Then noscope on roughdraft, quipu, the scan.

## 6. WORKING AGREEMENTS (standing; do not re-ask)

- One PR at a time on `pr-<slug>` targeting main, no stacking on GitHub (a local chain
  rebased with `git rebase --onto` as each merges is fine; use a separate `git worktree`
  when subagents are probing the main tree). "Merge as you go": merge after CI green and
  review findings applied; Mauria granted merge permission for the build plan at 01:11.
- Every PR: commit; review by direct subagents (spawn `general-purpose` agents named
  `review<N>-<angle>` with the design context in the brief, correctness plus conformance
  for large PRs; findings are secondhand until reconciled; their final reports often fail
  to arrive as notifications, so read `~/.claude/projects/-Users-mauriaparker/<session>/subagents/agent-a<name>-*.jsonl`
  or SendMessage "resend"); push; `gh pr create` with body = plan step text verbatim then
  "## Deviations, with reasons"; build-record entry on the branch; CI; `gh pr merge N
  --squash --delete-branch`; `git pull --ff-only`.
- Docs travel with the change (DESIGN.md, docs/architecture.html, README, build record).
  Never `git add -A`. Never commit in the same command as an edit. Sentence-case commit
  messages, no emoji, no attribution.
- Chat: provenance labels, answer first, tables for parallel items, no em-dashes.
- Quipu: write Head edits directly with exact anchors (the keeper invents content,
  papercut pc-e7b9f1); `git pull --ff-only` first.

## 7. ANCHORS

- Repo `~/Documents/Projects/noscope`; `pnpm check`; `./bin/noscope.mjs --help`;
  `NOSCOPE_DB=<file>` and `NOSCOPE_CLAUDE_BIN=<binary>` (tests use `test/stub-claude`, which
  serves `NOSCOPE_STUB_PLAN`/`NOSCOPE_STUB_PLANS` to planner calls and `NOSCOPE_STUB_OUTPUT`
  to sessions, `NOSCOPE_STUB_COUNTER` as the plan index file, `NOSCOPE_STUB_LOG`).
- Live incident: `cd ~/Documents/Projects/roughdraftplus && NOSCOPE_DB=~/.noscope/first-incident.sqlite ~/Documents/Projects/noscope/bin/noscope.mjs incident show 001` (also `tree`, `events`).
- Code map: `src/cli.ts` (command table), `src/context.ts` (EXIT 0 ok, 1 failed outside
  the record, 2 usage, 3 not built, 4 not found, 5 cannot proceed), `src/models.ts`,
  `src/store.ts` (events with mutations, `sumUsage`, `replay`), `src/equipment/*`,
  `src/capabilities/{registry,deterministic,investigate,session}.ts`, `src/verifier.ts`
  (recordClaims with promotion, recordSessionResult), `src/planner.ts` (PLANNER_RULES, the
  nine sections, `describeInputs`), `src/validator.ts` (CHECKS keyed by rule name),
  `src/runtime.ts` (applyPlan), `src/dispatcher.ts`, `src/tree.ts`,
  `src/commands/incident.ts` (create, show, events, tree, step, answer, run; `cycle`),
  `src/providers/{base,claude-code,index}.ts`; tests in `test/`, fixtures in
  `test/fixtures/{tree,models.ts}`.
- Docs: `DESIGN.md`, `BUILD-PLAN.md`, `docs/build-record.md` (one entry per PR),
  `docs/first-incident.md`, `docs/architecture.html`, README.
- Quipu threads: `ics-runtime.md` (open items list the revisit), `roughdraft.md`.
  Papercuts: pc-176e29, pc-490f5c, pc-e7b9f1, pc-d04913.

## 8. GOTCHAS

- biome reflows code after `lint:fix`; exact-string edits on TS miss; rewrite small files
  whole or anchor loosely. `exactOptionalPropertyTypes` is on. knip fails the build on any
  unused export (unexport rather than add entries). Node 24 cannot run `src/*.ts` directly;
  use `dist/`. `pnpm check | grep` hides the exit code.
- A heredoc containing certain characters is refused by the Bash tool ("control
  characters"); use the Write tool for such files.
- The planner input's snapshot test (`test/planner.test.ts`) pins sections 8 and 9 text;
  update with `pnpm vitest run test/planner.test.ts -u` and read the diff.
- Reviewer subagents share the working tree: one checked out a branch under the build; use
  `git worktree add` for parallel work and tell reviewers not to switch branches.
- A session's `budget.seconds` is also the provider's kill bound; a deterministic run past
  a bound is abandoned, not killed.
- Old claims in incident 001 have UUID ids (before the positional-id change); new ones are
  `001-cNNN`.
- Open questions: whether Mauria's merge permission extends past the build plan; what a
  claim should carry (read text, grep matches); how promotion should match.
