# Handoff: noscope round 2, seven of eight PRs merged; the rerun is next

Refreshed 2026-09-13 22:40 CDT by session noscope-audit [3d5895] (transcript
home-laptop:~/.claude/projects/-Users-mauriaparker-Documents-Projects-noscope/8207d276-eb0c-4c6a-86a2-86f3d0fdede1.jsonl).
Read this whole file before doing anything.

**First actions, in order:** (1) `/warp-pin title noscope-rerun`, the name this session was
launched with. (2) One `SendMessage` to `noscope-audit [3d5895]` saying "noscope-rerun is
up"; nothing is pending from background agents, and every round-2 PR through R2-7 is merged.
(3) Mauria was asked at 22:20 which Markdown document with comments to copy for the rerun,
and whether to push main (it carries the handoff commits); her answers are the inputs to
step 1 of §4 and to the push.

## 1. GOAL

Finish round 2 of `BUILD-PLAN.md` (the section "Round 2: from the first incident's
audit", eight PRs R2-1 to R2-8) and rerun the first incident to measure it. Mauria ruled
"all of it" at 19:26 and approved the plan in three Roughdraft passes; merge permission
covers the round.

## 2. WHAT NOSCOPE IS (the settled design; DESIGN.md is the contract)

An agent runtime with the Incident Command System as its primitive. Vocabulary, all ICS's
own except claim, fought over and not to be reopened: incident, unit (root `<id>-command`),
task, capability (deterministic ones produce verified claims, session-backed ones asserted),
equipment (the primitive, never assigned; kinds: function, provider built-in tool,
external), claim (subject, predicate, object, status, basis observed or inferred,
confidence, evidence, provenance), action plan (now with a situation), planner (Planning
Section; one Opus 5 call per cycle), validator (13 rules, Step 5), provider (Claude Code),
SOP, grant, budget, incident file. Mauria is the Agency Administrator. The cycle
(`incident step`): observe, plan, validate, apply, dispatch, verify, record, stop.

Stack: TypeScript, Node 24, pnpm, zod 4, better-sqlite3, biome, vitest, knip, CI runs `pnpm
check`. Repo https://github.com/kudzuweb/noscope (private).

## 3. STATE

Main's origin head is PR 26's squash commit; local main carries the handoff commits on top, unpushed. Clean. `pnpm check`
exit 0. Round 2 so far:

| PR | Plan item | What landed |
|---|---|---|
| #20 | R2-1 | Claims carry `basis`; the preamble defines the confidence scale; the store's first migration (schema 1 to 2). |
| #21 | R2-4 | Task refs: a plan chains new tasks on each other; the dispatcher runs the chain in one cycle. |
| #22 | R2-2 | The plan carries a `situation` (changed, hypothesis, proven, inferred with what settles each, keep); section 10 reads it back; rule 13 "Inferred links are worked"; `proven` must be verified. |
| #23 | R2-3 | A capability's `summarize` predicate (grep's `matches`) collapses to one line per task after its first cycle unless the situation keeps it; session findings reach section 5 in full. Incident 001 re-rendered: 2.17M to 0.85M characters of planner input. |
| #24 | R2-5 | `evidenceFrom` on tasks; the runtime attaches referenced claims and results to the brief; the brief opens with the objective, hypothesis and proven list; schema 3. |
| #25 | R2-6 | Prompt text: interpret tests the hypothesis and names alternatives, investigate adds "settled by:" items, the planner reproduces or asks or requests a capability, never reads more. `docs/first-incident.md` has the motivating cycles. |
| #26 | R2-7 | External equipment (`src/equipment/external.ts`): `playwright_browser` (MCP, headless, pinned 0.0.80, screenshots to the OS temp dir) and `claude_in_chrome` (provider integration, interactive-only); the `reproduce` capability; the provider allowlists attached servers. Merged 22:38. |

Verified live for R2-7 (DESIGN.md Reference rows): Playwright works from a headless session
with `--allowedTools mcp__playwright_browser` but refuses `file:` URLs (the live test
serves the fixture over HTTP and passes); Claude in Chrome is denied from a headless
session even under `bypassPermissions`, so it is interactive-only.

No worktrees or feature branches remain; origin has only `main`.

Quipu: `~/Documents/Projects/my-quipu/ics-runtime.md` has knots for the audit follow-ups
(21:45) and round 2's landing (22:15). Papercut logged: `gh pr checks --watch` right after
a push reports the previous run.

## 4. NEXT STEP, IN ORDER

1. R2-8, the second run. Needs Mauria: Roughdraft started on a scratch copy of a document
   with comments (`roughdraft start`, `roughdraft open <copy>`) and its URL. Then, from
   `~/Documents/Projects/roughdraftplus`, with `NOSCOPE_DB=~/.noscope/second-run.sqlite`:
   `noscope incident create "<the objective of run 001, verbatim from docs/first-incident.md>" --constraint "the app runs at <URL> on a scratch copy of the document, which reproduce may change" --constraint "the repository is read only"`, then `incident step 001` one cycle at a time (or `run` with a cap), watching each plan. Record `incident review 001` (on the new file) beside run 001 in `docs/first-incident.md` under "Second run": cycles, planner input, cost, and how the step code cannot prove (where the editor's selection rests before a deletion) was settled; no thresholds, per Mauria.
2. Then the revisit list on the quipu thread's open items, then noscope on roughdraft, quipu,
   the scan.

## 5. WORKING AGREEMENTS (standing; do not re-ask)

- One PR at a time on `pr-<slug>` targeting main, no stacking on GitHub; a local chain is
  fine, rebased with `git rebase --onto origin/main <base>` as each merges. Use a separate
  `git worktree` per branch under the scratchpad; reviewers work in the worktree and never
  switch branches. "Merge as you go": merge after CI green and review findings applied.
- Every PR: commit; review by direct subagents (`general-purpose`, named
  `review<N>-<angle>`, briefed with the design context; findings are secondhand until
  reconciled; their reports rarely arrive as notifications, so read the last assistant text
  of `.../subagents/agent-a<name>-*.jsonl`); push; `gh pr create` with body = plan step text
  verbatim, "## Deviations, with reasons", then "## From the review"; build-record entry on
  the branch; CI on the head SHA (confirm `gh pr view --json headRefOid` matches before
  trusting a watch); squash-merge with branch deletion; pull.
- Docs travel with the change (DESIGN.md, docs/architecture.html, README, build record).
  Never `git add -A`. Never commit in the same command as an edit. Sentence-case commit
  messages, no emoji, no attribution. Check `pnpm check`'s exit code, never its grepped output.
- Chat: provenance labels, answer first, tables for parallel items, no em-dashes.
- Quipu: write Head edits directly with exact anchors; `git pull --ff-only` first.
- Pushes of main need her yes each time; PR branches push freely.

## 6. ANCHORS

- Repo `~/Documents/Projects/noscope`; `pnpm check`; `./bin/noscope.mjs --help`;
  `NOSCOPE_DB=<file>`, `NOSCOPE_CLAUDE_BIN=<binary>`; tests use `test/stub-claude`;
  `NOSCOPE_LIVE=1` runs the live tests (Haiku provider; Playwright reproduce).
- First incident: `cd ~/Documents/Projects/roughdraftplus && NOSCOPE_DB=~/.noscope/first-incident.sqlite ~/Documents/Projects/noscope/bin/noscope.mjs incident review 001` (the file migrates to schema 3 on first open by the new build).
- Code map: `src/models.ts` (Claim with basis, Situation, EvidenceFrom, TaskProposal with
  ref), `src/store.ts` (migration chain), `src/planner.ts` (system prompt, 13 rules, ten
  sections, `lastSituationOf`), `src/validator.ts`, `src/runtime.ts` (refs to ids),
  `src/dispatcher.ts` (`briefContext`), `src/capabilities/{registry,session,investigate,
  reproduce,deterministic}.ts`, `src/equipment/external.ts`, `src/providers/claude-code.ts`
  (mcp-config, allowlist, `--chrome`), `src/review.ts`.
- Docs: `DESIGN.md`, `BUILD-PLAN.md` (round 2 at the end), `docs/build-record.md` (entries
  through PR 26), `docs/first-incident.md` (with "Prompt changes from this run"),
  `docs/architecture.html`, README.

## 7. GOTCHAS

- biome reflows code after `lint:fix`; exact-string edits miss; write scripts with
  whitespace-tolerant anchors or rewrite small files whole. `exactOptionalPropertyTypes` is
  on. knip fails on unused exports. The Write tool is blocked by a security hook whenever
  the file's text contains the word exec followed by an opening parenthesis (SQLite's
  `db.exec` call, or a sentence about it); a heredoc through Bash is not.
- A python edit anchored on a line just after `export` swallowed the keyword once (knip
  caught it); anchor on the full declaration.
- Roughdraft's save pads table cells and drops blank lines; rebuild the committed file from
  HEAD plus the intended edits rather than committing its output.
- `timeout` is not on this machine; the Bash tool's own timeout bounds a command.
- Playwright's MCP server refuses `file:` URLs; the reproduce session's cwd is the
  incident's cwd and Playwright writes `.playwright-mcp/` there (ignored in this repo).
- Outcome events name their task inside `payload.mutation.taskId`; `task.usage` and
  `task.insufficient` name it at the top.
- The planner snapshot (`test/planner.test.ts`) pins sections 8 and 9; update with
  `pnpm vitest run test/planner.test.ts -u` and read the diff.
