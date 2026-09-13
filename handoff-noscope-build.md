# Handoff: noscope, the audit's follow-ups merged; the planner-input ruling is next

Refreshed 2026-09-13 10:15 CDT by session noscope-audit [3d5895] (transcript
home-laptop:~/.claude/projects/-Users-mauriaparker-Documents-Projects-noscope/8207d276-eb0c-4c6a-86a2-86f3d0fdede1.jsonl),
which took over from the build session at 09:36 and shipped PRs 17, 18 and 19. Read this
whole file before doing anything.

**First actions, in order:** (1) `/warp-pin title noscope-audit`, or whatever name the
session was launched with. (2) Nothing is pending from background agents: every reviewer
finished and every report was applied before merge. No message to any prior session is
needed; the build session (`Handoff noscope build [6ed359]`) has stopped.

## 1. GOAL

Refine noscope from the first incident's audit before using it on roughdraft, quipu and the
codebase scan. The audit's three follow-ups are built (§3). Mauria's two mid-turn asks on
2026-09-13 were answered: keep transcripts (done, PR 18) and whether the planner needs the
whole incident file each cycle (answered, §4; her ruling is pending).

## 2. WHAT NOSCOPE IS (the settled design; DESIGN.md is the contract)

An agent runtime with the Incident Command System as its primitive. Vocabulary, all ICS's
own except claim, fought over and not to be reopened: incident, unit (root `<id>-command`),
task, capability (deterministic ones produce verified claims, session-backed ones asserted),
equipment (the primitive, never assigned), claim (subject, predicate, object, status,
confidence, evidence, provenance), action plan, planner (Planning Section; one Opus 5 call
per cycle), validator (12 rules, Step 5), provider (Claude Code first; Codex untested),
SOP, grant, budget, incident file. Mauria is the Agency Administrator. The cycle
(`incident step`): observe, plan, validate, apply, dispatch, verify, record, stop. Four
channels for what the planner lacks: a task, a grant request, a capability request, a
question for a human (`incident answer` reopens).

Stack: TypeScript, Node 24, pnpm, zod 4, better-sqlite3, biome, vitest, knip, CI runs `pnpm
check`. Repo https://github.com/kudzuweb/noscope (private).

## 3. STATE

Main is `00e5304`, clean, no branches, all pushed except this handoff commit. `pnpm check`
exit 0, 121 tests, one skipped (the live Haiku test, `NOSCOPE_LIVE=1`). Merged today:

| PR | What | Review outcome |
|---|---|---|
| #17 usage split and cost | `Usage` carries `uncachedInputTokens`, `cacheWriteTokens`, `cacheReadTokens`, optional `costUsd` (the provider's `total_cost_usd`, list price even on subscription); `sumUsage` carries a cost only when every `task.usage` has one; `incident show` prints "task cost", which excludes the planner like the spend beside it. | A summed cost that undercounted a session failed before its envelope; the cost line reading as the whole incident's. Both applied. |
| #19 incident review | `noscope incident review <id>` (`src/review.ts`, handler in `src/commands/incident.ts`): per cycle the verdict, rejections, planner usage and session id, every run with model, split, seconds, cost, outcome, claims, session id; runs that failed before starting; questions; totals by role and model; cost recorded or bounded at list rates (0.1x reads, 2x writes since Claude Code uses the one-hour cache). `plan.proposed` records the planner's model. On incident 001 it reproduces the audit table exactly; cost $6.37 to $40.15. | A NUL byte made the file binary to git; outcome events name their task inside the mutation, so the old "completed" default hid a lookup miss. Both applied. |
| #18 transcripts | `--no-session-persistence` dropped from `CLAUDE_CODE_ISOLATION_FLAGS`; transcripts land at `~/.claude/projects/<cwd with slashes as dashes>/<session id>.jsonl`; `task.completed` now carries the session id (the one behavior change beyond the flag). DESIGN.md Step 3 and Reference rows, architecture page, build record updated. | `task.completed` lacked the id; three stale "five flags" mentions. Applied. |

Incident 001 (the roughdraft scroll defect) is unchanged on
`NOSCOPE_DB=~/.noscope/first-incident.sqlite`; its events predate the split and cost, and
its sessions left no transcripts. The next live incident will have both.

Quipu: `~/Documents/Projects/my-quipu/ics-runtime.md` has a knot for this stretch (10:12)
and a new open item for the planner-input ruling; `roughdraft.md` carries the defect's
cause. Papercut logged: `gh pr checks --watch` right after a push reports the previous
run's pass.

## 4. THE PLANNER-INPUT ANALYSIS (delivered 10:15; Mauria's ruling pending)

Method, verified: every cycle's planner input of incident 001 re-rendered by replaying the
event log up to each `plan.proposed` into a fresh store and calling `renderPlannerInput`
(script `scratchpad/planner-input.mjs`, gone with the session; twelve lines of code to
rewrite). Sections measured in characters; claims cited by each cycle's rationale and plan
counted by id prefix and by file:line subject.

| Finding | Number |
|---|---|
| The verified-claims section is most of the prompt from cycle 3 on. | 151k to 185k of 172k to 263k chars (60 to 88 percent). |
| Almost all of that section is grep-match claims. | 391 of 404 verified claims, 181k of 185k chars at cycle 12. |
| The planner rarely cites match claims after the cycle that produced them. | 24 of 391 ever cited; at most 20 in one cycle (cycle 5), usually 2 to 14 file:line subjects. |
| The planner does cite old claims. | Cited claims were up to 10 cycles old; in cycle 5, 24 of 29 cited were from two or more cycles back. |
| Distinct claims cited over the whole run. | 81 of 471. |
| Planner output is long and restates the case each cycle. | 2.6k to 13.3k output tokens per call; the 13.3k call took 155 s. |

Conclusion given to Mauria: the planner already runs fresh each cycle (a new session; only
the incident file carries over), so "a summary of the previous cycle" would drop the
cross-cycle citations it relies on. The fit is to change what a grep claim carries: after
the cycle that produced them, collapse match claims to a per-task summary (files, counts,
a pointer), keeping every non-match claim in full. That removes roughly two thirds of the
prompt with no loss on the evidence the planner cited. This is the "what a claim carries"
item already on the revisit list. Prompt observations, also for her ruling: ask the human
as soon as a link is unprovable from the repository (the planner spent cycles 6 to 9 on one
a browser could have settled); verify the link whose failure changes the conclusion;
rationale should say what changed and why this plan, not restate the case.

## 5. NEXT STEP, IN ORDER

1. Mauria's ruling on §4: the claim-carrying change and the prompt lines. Build what she
   takes as PRs on main (`pr-<slug>`, direct-subagent review, merge on green; merge
   permission was extended to these follow-ups at 09:42 and covers "all three" pieces;
   ask whether it extends further).
2. The session-backed `review` capability (third piece of the audit proposal): answers the
   four AAR questions from the log; first use of noscope on itself. Design with her; the
   deterministic report is its input.
3. Her scheduled revisit: Opus as planner and the Step 5 rules accepted "for now";
   promotion needing a looser notion of "established"; planner tokens versus budget; two
   validator design calls (closing a unit whose child still runs a task; two tasks that fit
   the budget singly but not together). All on the quipu thread's open items.
4. Then noscope on roughdraft, quipu, the scan.

## 6. WORKING AGREEMENTS (standing; do not re-ask)

- One PR at a time on `pr-<slug>` targeting main, no stacking on GitHub. Use a separate
  `git worktree` when reviewer subagents are probing the main tree, and tell them not to
  switch branches. "Merge as you go": merge after CI green and review findings applied.
- Every PR: commit; review by direct subagents (spawn `general-purpose` agents named
  `review<N>-<angle>` with the design context in the brief; findings are secondhand until
  reconciled; their final reports do not arrive as notifications, so read
  `~/.claude/projects/-Users-mauriaparker-Documents-Projects-noscope/<session>/subagents/agent-a<name>-*.jsonl`
  and take the last assistant text); push; `gh pr create` with body = plan step text
  verbatim then "## Deviations, with reasons" (and "## From the review" after); build-record
  entry on the branch; CI; `gh pr merge N --squash --delete-branch`; `git pull --ff-only`.
- Docs travel with the change (DESIGN.md, docs/architecture.html, README, build record).
  Never `git add -A`. Never commit in the same command as an edit. Sentence-case commit
  messages, no emoji, no attribution.
- Chat: provenance labels, answer first, tables for parallel items, no em-dashes.
- Quipu: write Head edits directly with exact anchors; `git pull --ff-only` first.
- Pushes of main need her yes; she gave it for the last handoff commit, not standing.

## 7. ANCHORS

- Repo `~/Documents/Projects/noscope`; `pnpm check`; `./bin/noscope.mjs --help`;
  `NOSCOPE_DB=<file>`, `NOSCOPE_CLAUDE_BIN=<binary>`; tests use `test/stub-claude`
  (`NOSCOPE_STUB_PLAN`/`NOSCOPE_STUB_PLANS`, `NOSCOPE_STUB_OUTPUT`, `NOSCOPE_STUB_COUNTER`,
  `NOSCOPE_STUB_LOG`, `NOSCOPE_STUB_FAIL`); the stub envelope carries `total_cost_usd: 0.0123`.
- Live incident: `cd ~/Documents/Projects/roughdraftplus && NOSCOPE_DB=~/.noscope/first-incident.sqlite ~/Documents/Projects/noscope/bin/noscope.mjs incident review 001` (also `show`, `tree`, `events`).
- Code map: `src/cli.ts` (command table), `src/context.ts` (EXIT codes), `src/models.ts`
  (`Usage` with the split), `src/store.ts` (`sumUsage`, `replay`), `src/review.ts`
  (`renderReview`, list rates dated 2026-06-24), `src/planner.ts` (`PLANNER_SYSTEM_PROMPT`,
  `PLANNER_RULES`, `renderPlannerInput`, records `model` on `plan.proposed`),
  `src/validator.ts`, `src/runtime.ts`, `src/dispatcher.ts` (session id on `task.completed`),
  `src/verifier.ts`, `src/capabilities/*`, `src/providers/claude-code.ts` (four isolation
  flags; `parseClaudeCodeResult` fills the split and cost); tests in `test/`.
- Docs: `DESIGN.md`, `BUILD-PLAN.md`, `docs/build-record.md` (entries through PR 19),
  `docs/first-incident.md`, `docs/architecture.html`, README.
- Pricing source: the `claude-api` skill's model table (cached 2026-06-24) and the Claude
  Code envelope (`usage.cache_creation.ephemeral_1h_input_tokens`, `costBasis: "list"`).

## 8. GOTCHAS

- biome reflows code after `lint:fix`; exact-string edits on TS miss; rewrite small files
  whole or anchor loosely. `exactOptionalPropertyTypes` is on. knip fails on unused exports.
  `pnpm check | grep` hides the exit code.
- A literal NUL byte appeared inside a template string in a freshly written TS file
  (`src/review.ts`, first commit of PR 19; cause not verified, the file was written whole
  with the Write tool); git then treats the file as binary. Check with `od -c | grep '\\0'`
  before committing a new TS file.
- `gh pr checks --watch` right after a push can report the previous run's pass; confirm
  `gh pr view --json headRefOid` matches HEAD and a run exists for it before watching.
- Outcome events (`task.completed`, `task.failed`) name their task inside
  `payload.mutation.taskId`, not at the payload's top level; `task.usage` and
  `task.insufficient` name it at the top.
- The planner input's snapshot test (`test/planner.test.ts`) pins sections 8 and 9 text;
  update with `pnpm vitest run test/planner.test.ts -u` and read the diff.
- Old claims in incident 001 have UUID ids; new ones are `001-cNNN`.
- Open questions: how far merge permission extends; what a claim should carry (the §4
  ruling); how promotion should match.
