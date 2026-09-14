# Handoff: noscope after round 2; the design conversation toward round 3

Refreshed 2026-09-14 19:05 CDT by session noscope-rerun [da49a0] (transcript
home-laptop:~/.claude/projects/-Users-mauriaparker-Documents-Projects-noscope/e947bb82-bb8d-47c6-9f63-6e01e0b15c6f.jsonl).
Read this whole file before doing anything. It is long on purpose: Mauria ran out of Fable
tokens until Wednesday 2026-09-16 in the middle of a design conversation, and the successor
must be able to continue that conversation as if it had been in the room. Sections 4 and 5
are that conversation. Sections 1 to 3 and 6 to 9 are the build state and the mechanics.

**First actions, in order:** (1) `/warp-pin title <the name this session was launched
with>`. (2) Read this file, then `DESIGN.md` in full, then `docs/first-incident.md` from
"## Second run" to the end. (3) Nothing is pending from background agents. Two commits are
unpushed and need Mauria's yes: this handoff on noscope main, and the quipu commits
(c0511ba, ffe6137 and the put-down knot) in `~/Documents/Projects/my-quipu`. (4) Do not
start building anything in section 5 without her go-ahead; the conversation ended at a
proposal, not a ruling to build.

## 1. GOAL

Round 2 of `BUILD-PLAN.md` is complete: R2-1 to R2-8 merged as PRs 20 to 27. The work in
front of the project is a round 3 whose shape Mauria was working out in conversation on
2026-09-14 (section 4): an Incident Commander who is not her, session-backed units, a
persistent planner, and a rework of what claims and verification are for. The next
deliverable is a design note for Roughdraft review that states that shape, preceded by two
mechanism checks (section 5, step 1). Nothing in round 3 is built.

## 2. WHAT NOSCOPE IS (the settled design; DESIGN.md is the contract)

An agent runtime with the Incident Command System (ICS) as its primitive. Vocabulary, all
ICS's own except claim, fought over and not to be reopened: incident (any objective Mauria
asks to have pursued, not necessarily something wrong), unit (a box in the tree that owns a
slice of the problem; root `<id>-command`), task (one assignment, owned by one unit, bound
to one capability), capability (the assignable thing: deterministic ones like grep, read,
check_path, git_history produce verified claims; session-backed ones like investigate,
interpret, reproduce run as headless Claude Code sessions and produce asserted claims),
equipment (the primitive a capability uses, never assigned directly; kinds: function,
provider built-in tool, external such as an MCP server or a provider integration), claim
(subject, predicate, object, status asserted or verified or rejected, basis observed or
inferred, confidence, evidence, provenance), action plan (units to create or close, tasks,
cancellations, claims to verify, questions, grant requests, capability requests, SOPs,
incident status, the situation, rationale), situation (what changed, hypothesis, proven
claim ids, inferred links each with what settles it, claims to keep in view), planner (the
Planning Section; one Opus 5 call per cycle, stateless, fed the incident file rendered in
ten sections), validator (13 rules, approves or rejects a plan whole), provider (Claude
Code), SOP (a saved unit configuration; designed, not built), grant (Mauria's permission for
a capability that writes; none needed yet, everything is read-only), budget, incident file
(the one place command keeps state; `incident show` prints it). Mauria is the Agency
Administrator. The planner's four channels when it lacks something: a task, a grant
request, a capability request (answered with `incident provide`), a question (answered with
`incident answer`); any of the last three blocks the incident. The cycle (`incident step`):
observe, plan, validate, apply, dispatch, verify, record, stop.

Stack: TypeScript, Node 24, pnpm, zod 4, better-sqlite3, biome, vitest, knip, CI runs `pnpm
check`. Repo https://github.com/kudzuweb/noscope (private).

## 3. STATE

Origin main is PR 27's squash commit 66ea828. Local main has handoff commits on top,
unpushed. Clean. `pnpm check` exit 0. `dist/` rebuilt from that commit. No worktrees or
feature branches; origin has only `main`.

The two live runs, both of the same objective ("why does Roughdraft scroll to the bottom
comment after a comment is deleted, and which code path is responsible"), both against
roughdraftplus at commit 6a996e8, both read-only:

| Run | Database | Result |
|---|---|---|
| 001, 2026-09-13, before round 2 | `~/.noscope/first-incident.sqlite` | Satisfied on cycle 12, planner input 1.09M tokens, one question to Mauria at cycle 9 that falsified the working explanation; the answer was found by a cycle 10 investigation and stayed inferred. Written up in `docs/first-incident.md`. |
| 002, 2026-09-14, after round 2 | `~/.noscope/second-run.sqlite` (read only with the current build; older builds cannot parse `capability.answered`) | Satisfied on cycle 8, same code path (`PageCard.tsx:1884`, a bare `focus()` whose Tiptap default scrolls the caret into view; the caret sits at the document end because the mount-time `setContent` maps it there and rail clicks never move it), planner input 265k tokens, $16.20 at list rates, no question about the bug: five Playwright `reproduce` sessions settled the step code cannot prove. Scratch document and screenshots in `~/.noscope/second-run/`. Written up under "## Second run" in `docs/first-incident.md`, which also lists what the run found in the runtime. |

Three runtime fixes rode on PR 27: the brief renderer for reproduce results (rendered
`undefined: undefined`), `incident provide` (a capability request had no way back to
`open`), and Playwright's MCP server starting inside its output directory (named
screenshots had landed in the roughdraftplus tree). A reviewer caught that the plan schema
had inherited the request's `answer` field; fixed and pinned by a schema test.

Quipu: `~/Documents/Projects/my-quipu/ics-runtime.md` carries a knot for run 002 (c0511ba)
and the session-backed units ruling in its Head (ffe6137); a put-down knot was requested
at 19:05. Papercut pc-7e69f7: a stale `dist/` ran the first, discarded attempt of run 002.

## 4. THE DESIGN CONVERSATION OF 2026-09-14, IN ORDER

Everything here is what Mauria and this session worked through between 14:40 and 18:56
CDT. Each item says whether it is her ruling, her lean, or the session's proposal. Rulings
are hers alone; the mapping to vocabulary and mechanism is the session's and can be argued.

### 4.1 The measure that started it

Run 002 saved tokens (265k against 1.09M planner input) but took longer (63 minutes
against 53), and the difference was the five reproduce sessions at about four minutes each.
Each was a fresh headless session with its own fresh Playwright browser (`--isolated`), so
each re-did the same setup: load the page, dig the Tiptap editor out of React's fiber tree,
install a `requestAnimationFrame` wrapper, a `scrollTop` setter trap, focus listeners and
scroll wrappers, then run the steps that were actually the point. Verified from the task
inputs and the first session's transcript (19 `browser_evaluate` calls). Mauria: "it
sounds like we need to introduce a way to reuse sessions that are doing the same thing".

### 4.2 Ruling: units come in two kinds (16:16 CDT)

The session first proposed a `continues: <task>` field to resume a prior task's session.
Mauria reframed it: "what if using sessions primarily as resources is thinking about the
problem wrong? maybe sessions should be able to be units, like how command is a unit?"
The session agreed that is more faithful to ICS (a session is a crew with a leader that
holds state and takes successive assignments, not a truck). She ruled:

| Ruled | Detail |
|---|---|
| Units come in two kinds | A unit is deterministic-only, or session-backed when its tasks share setup and starting fresh would waste time and tokens. |
| A session-backed unit's session lives with the unit | Created with the unit, holding its purpose and equipment (a browser, the read-only tools), taking each task as an assignment in order, demobilized when the unit closes. |
| The log records per task either way | The same events (`task.started`, `task.completed` or `task.insufficient`, `task.usage`) and the same claim provenance per assignment, whether the tasks ran in one session or several. `incident review` must still cost each task on its own. Her words: "the logging should capture the same data even if it's occurring inside a single session instead of subsequent sessions". |

This is recorded in the quipu Head (ffe6137). Mechanisms verified that day: Claude Code
has `--resume <session-id>`; Playwright MCP 0.0.80 has `--port` (shared server over SSE),
`--user-data-dir` (persistent profile instead of `--isolated`), and `--cdp-endpoint`.
Unverified and needed: that a resumed headless call takes its own `--json-schema` and
returns one structured result per call, and that it reports usage for that call alone.

### 4.3 The planner: her proposal is one persistent session shown the full file each cycle

Today the planner is a fresh headless call every cycle with no memory; its whole input is
the incident file re-rendered from the database in ten sections (verified in
`src/planner.ts`, `renderPlannerInput`): 1 command picture (objective, constraints,
priorities, budget, grants, questions, capability requests), 2 verified claims, 3 asserted
claims, 4 unit tree, 5 tasks completed since the last cycle, 6 tasks that came back
insufficient since the last cycle, 7 open tasks, 8 capabilities and models with input
fields, 9 the validator's rules and last cycle's rejection reasons, 10 the situation it
wrote last cycle. The situation exists because the planner has no other memory. Because a
stateless planner cannot be sent only what changed, the file's size is paid every cycle;
R2-3's grep collapse (claims with a summarizing predicate render in full only the cycle
after they land, then one line per task unless kept) is the mitigation, and it is why run
002's planner input dropped from 58k on cycle 2 to 28k on cycle 3.

Mauria asked why the planner is stateless. The session gave the v0 reasons (the file is
the one source of truth; no hidden drift; trivial crash recovery; caching) and said they
are real but not decisive, and that her logging rule undercuts the strongest one. She then
proposed, and this is her lean, not yet a ruling: "instead of starting a fresh planner
each time, we just show the same session the updated incident file each round? if we
really needed to know if what a planner believed differed from it the transcripts exist,
but reminding it of where we are each time should be sufficient". The session's
comparison, which she accepted as the tradeoff:

| Dimension | Fresh call each cycle (today) | One session, full file each cycle (her proposal) |
|---|---|---|
| Input per call | The file: 8k to 58k in run 002, 265k over the run. | The whole transcript plus the new file: about four times the input summed over the run, almost all cache reads. |
| Output per call | Each plan re-establishes the whole picture: 13k to 15k output tokens for the big plans. | Plausibly shorter plans; the session's inference, unmeasured; output is the expensive token. |
| Drift | Impossible except through the situation. | Possible in the transcript, corrected every round by the re-shown file, which is the authoritative state. |
| Compaction | Not applicable. | Claude Code compacts long sessions and drops detail; re-showing the full file makes that survivable. This is why full-file-each-round beats a delta feed. |
| Crash recovery | Nothing to resume. | Store the session id (already recorded per plan) and resume; if lost, start fresh with the full file. |
| The record | Situation per plan. | Unchanged: the situation stays required every plan. |

Mechanism still unverified: the same two resume checks as 4.2.

### 4.4 ICS mapping of command, and what incident command needs to know

Mauria: "the planner plus some deterministic code are basically incident command, right?"
Yes. The session's table (ICS doctrine from training, not re-checked against the FEMA
text; the noscope column verified from code):

| Command needs | ICS | noscope today | Gap |
|---|---|---|---|
| The objective | The IC sets it. | Set at `create`, rendered every cycle. | None. |
| Priorities | The IC sets them; every tactical choice is made against them. | `priorities` exists on the incident; both runs left it empty; no rule reads it. | Priorities drive nothing. |
| Protocols | SOPs, safety rules, delegation. | The 13 rules, SOPs (designed, unbuilt), grants, effect policy. | None. |
| Resource status | The Resources Unit's board. | Section 8, open tasks, budget. | None in substance. |
| The situation and what changed | The Situation Unit maintains the picture and briefs command each period on what changed. | The planner writes `situation.changed` itself; sections 5 and 6 already list what completed or came back insufficient since last cycle, but nothing rolls up claims landed, answers arrived, or spend as one change report. | Bookkeeping done by judgment. |
| Continuity of command | The IC persists across operational periods; replacing one is a transfer of command, a deliberate event with a full briefing. | A fresh planner every cycle: a transfer of command every period. | Her proposal in 4.3 fixes this, and ICS agrees with her. |
| The plan | The Incident Action Plan. | The action plan. | None. |
| Adjusting deployment | Re-task, release, reassign. | `cancelTasks`, `closeUnits`, and session-backed units. | Covered by 4.2. |

### 4.5 Who writes the plan in ICS, and the Planning P order

Mauria asked whether the IC writes the action plan. No: the IC sets objectives, priorities
and strategy and approves the IAP; the Planning Section assembles it and Operations
supplies the tactics. The Planning P, as doctrine from training: incident and notification;
initial response and size-up by the first-arriving IC; incident briefing (ICS 201);
objectives meeting where the IC sets the period's objectives and priorities; command and
general staff meeting; tactics meeting (Operations with Planning, Safety, Logistics);
planning meeting; IAP preparation and IC approval; operations briefing; execute and assess;
back to the objectives meeting for the next period.

Mapped onto noscope: `create` is notification; there is no size-up step (run 002's cycle
1 mixed size-up with tactics); no objectives meeting (the objective from `create` is reused
verbatim every cycle and priorities stay empty); the planner call is the tactics and
planning meetings together; the validator is approval by rules only; the dispatcher is the
operations briefing. Today the model holds three seats at once: Operations (tasks, units),
Planning (assembling the plan, the situation), and two IC decisions (declaring the
objective met via `incidentStatus`, and escalating to the Agency Administrator via
questions, grant and capability requests). The run-002 example of the missing IC: cycles 6
and 7 ($4.63) chased secondary links after the primary path was closed on cycle 6,
because nothing told the planner what the period was for or when enough was enough.

### 4.6 Ruling: "we need an IC" (16:45 CDT)

Mauria: "okay, i want our system to have an IC who isn't me" and, after the Planning P,
"okay yeah, we need an IC". What was worked out about the IC, her leans plus the session's
mapping, none of it yet written as design:

| Aspect | What was said |
|---|---|
| Seat | The IC holds step 4 (set the operational period's objectives and priorities from the incident objective, the constraints and the current situation; decide whether the incident objective is met) and step 8 (judge the plan against those period objectives before the validator's rule check). The planner holds tactics and assembly. The runtime holds the deterministic half of size-up, the briefing, dispatch and assessment. |
| Persistence | The IC is a persistent Claude session, briefed each cycle with the full file, like the planner in 4.3. Starting a new one is an explicit transfer of command, recorded as an event. |
| Size-up | Mauria: "i don't know if size up should be an SOP necessarily? the IC should be able to look at the incident and decide what info it needs then find out. it's a claude session, it has tools. it can figure out what recon it needs to do and do it before talking to the planner, no?" Yes, and ICS agrees: the first-arriving IC does size-up personally. The propose-then-validate boundary governs the action plan, not reading. The IC's recon is bounded by a time and token budget like any session work. |
| How the IC finds things out | Mauria: "can't the IC ask for deterministic verification of whatever necessary so it passes on as much truth to the planner as can be ascertained?" The session's answer, which she accepted as reasonable: the IC's tools for looking at the world are the deterministic capabilities themselves (grep, read, check_path, git_history), exposed to its session as tools by the runtime, most likely as an MCP server noscope serves, since sessions already take MCP servers as equipment. A grep the IC runs is a task the runtime executes and records, so its claims land verified by construction and the log has it (her logging rule). The IC keeps judgment for itself: its interpretations enter the record asserted, basis inferred, with `evidence` naming the claim ids they rest on. Questions only a human can answer go to Mauria before objectives are set if the objectives depend on them. |
| The IC's first cycle | The runtime records what it can gather without judgment (registered capabilities and equipment, budget, whether the cwd is a git repository and its state, whether any URL a constraint names answers). The IC reads that, runs whatever recon it decides it needs, asserts its interpretation, states the first period's objectives and priorities. The planner then plans against a file that is mostly verified facts plus objectives and priorities, not a bare objective. |
| A caution for the IC's role text | From run 001: a session that can read is tempted to keep reading instead of deciding. The IC's size-up is for what it needs to set objectives; digging is what it assigns. |
| Priorities | Become an input to decisions: the incident gets priorities at creation as a matter of course (run 002 should have had "settling by observation over reading"); a planner rule that the rationale names the priority that chose between plans; a validator line against contradicting a priority is a later step. |

### 4.7 The verifier, promotion, and what verification actually did

Mauria wanted to understand the verifier. Verified from `src/verifier.ts`: (1) a
deterministic task's claims enter verified with the capability and the exact inputs as
provenance; (2) a session's claims enter asserted with the session id and the basis the
session gave; an `insufficient` result records no claims and a `task.insufficient` event
naming what was needed; (3) promotion: after every deterministic task, every asserted
claim whose subject, predicate and object exactly equal a just-verified claim is promoted.
There is no operation that verifies a named claim: `claimsToVerify` in the plan is checked
by the validator for existence, printed, recorded, and nothing acts on it; DESIGN.md Step
6 says the planner asks for verification through it, so design and code disagree.
Promotion never fired in either run (0 promoted of 404 and 162 verified), because a
session phrases a fact as a sentence and a grep as a pattern and a matched line.

The session proposed a replacement, "a session states a checkable fact in checkable form"
(a `check` field on a claim proposal naming the capability, inputs and expected triple; the
verifier runs it and marks the claim verified or rejected), and she asked how. Then she
asked whether any of the verifying had ever corrected a course. Answer: no. In run 001 the
correction came from her answer; in run 002 from the cycle 1 investigate and reproduce
contradicting the opening hypothesis; validator rejections corrected shape, not direction;
no claim was ever rejected and no verified claim ever contradicted an asserted one.

### 4.8 The claims audit (run 18:39 to 18:45 CDT)

To find out whether a check mechanism would ever fire, the 107 asserted claims across both
runs that name a file and line (65 from run 001, 42 from run 002; the other 44 in run 002
are browser observations) were audited by four subagents against roughdraftplus at 6a996e8
and the installed Tiptap 3.22.4 and ProseMirror sources. Reconciled result:

| Verdict | Count | Detail |
|---|---|---|
| True | 74 | The file at the line says what the claim says. |
| Judgment only | 30 | Runtime or interpretation; every embedded line fact true. |
| Partly | 3 | A line range covering one setter where the claim said three (001-c226); a block cited one line off (001-c146, scrollIntoView.ts 17-19 is 18-20); an "only condition" missing a second branch at focus.ts:73 (run 001 c382). |
| False | 1 fact, in three run-001 claims | "The rail's path to `focusComment` is dead." It is not: `DocumentReviewRail.tsx:527` calls `onFocusComment(primaryCommentId)` on a collapsed-thread click, wired at `PageCard.tsx:2219`; also `DocumentReviewRail.tsx:829-836` and `DocumentCommentRail.tsx:204`. |
| Run 002 false facts | 0 | |

The twist: a check would have caught the false fact (a grep for `onFocusComment(` finds
the call), but catching it would not have corrected the course. Run 001 held two
contradictory beliefs, that the path was dead and that the selection rests on the
last-clicked comment's anchor (which needs the path live); rejecting the false fact would
have strengthened the second belief, the one Mauria's answer falsified. The truth was a
third thing only run 002's observation found: the path is live, `focusComment` runs on a
card click, and it still never moves the selection because `findCommentRange` returns
false for non-text nodes at `PageCard.tsx:260` and so returns null for every real
document. One auditor, reading the code today, drew run 001's wrong inference again; it
is superseded by run 002's observed claims (t13: clicks on c1, c2, c3 left the selection
at 14696 of 14697; t17: the traversal made 44 callbacks on block nodes and none on text).

### 4.9 Her conclusion on checks and claims, and where status gates today

Mauria: "okay, so we do not actually need deterministic check machinery, it is
unnecessary. why do we even have the claims mechanism?" The session's answer, which she
did not dispute:

| Part of a claim | Verdict from the runs |
|---|---|
| The claim as an addressable unit of record with an id | Earned its keep: `evidenceFrom` by reference, the situation's lists, the closing rationale's citations, the grep collapse all depend on it. |
| Provenance | Earned its keep; the audit was possible because of it. |
| Basis (observed or inferred) and confidence | Earned its keep: run 002's planner tracked every inferred link and sent a reproduce to settle each; this is what drove the run to observation. |
| Status (verified against asserted) | Did little: sessions were right about code 74 of 75 times; promotion never fired. Keep as a label of source kind; stop using it as a gate. |
| Deterministic checks | Unnecessary now. |

She asked how status is a gate right now. Verified from `src/validator.ts`: (1) the
"Inferred links are worked" rule requires every claim in `situation.proven` to have status
verified, so only deterministic runs can be "proven" and a reproduce observation never
can; in run 002 every `proven` list held grep claims only, and the observations that
settled the case sat in `keep` all run; (2) "Status is earned" requires at least one
verified claim for `satisfied`, weak in practice, but it says an incident settled entirely
by observation could not close; (3) `claimsToVerify` ids must be asserted, trivial. Beyond
the validator, status only shapes presentation: sections 2 and 3 split by it, and the
planner saw reproduce observations in the "asserted" section with "observed" beside them.

The session's proposed change (not ruled): `proven` accepts any claim whose basis is
observed, whichever task observed it; the `satisfied` rule asks for observed claims rather
than verified ones; drop promotion and `claimsToVerify`; status becomes a label of where a
claim came from. Caution the session raised: both runs were code investigations, where a
model reading a file is reliable; an incident whose facts come from the outside world (a
GitHub issue's state, a command's output) may be where machine-observed status earns its
place, so keep the label and build nothing on it until an incident shows the need.

The conversation stopped there, at 18:56, with her out of tokens.

## 5. NEXT STEPS, IN ORDER (proposed; the go-ahead is hers)

1. Two mechanism checks against `claude` itself, read-only: does a headless call resumed
   with `--resume <id>` accept its own `--json-schema` and return one structured result
   for that call; does it report usage for that call alone rather than the cumulative
   conversation. Both the persistent planner and the persistent IC rest on these.
2. A design note for Roughdraft review, on DESIGN.md's terms and in execution order, that
   states: the IC seat (4.6), the persistent planner shown the full file each cycle (4.3),
   session-backed units with per-task logging (4.2), the runtime's deterministic briefing
   at the top of each cycle (4.4), priorities as an input to decisions (4.6), and the claims
   changes (4.9). Each with the validator and dispatcher changes it needs, and each traced
   to the ruling or lean above at the scope it was made; do not widen any of them. Open
   questions listed with what each blocks. Then `roughdraft open` on it.
3. After her rulings on the note, a round 3 section in `BUILD-PLAN.md` in the same form as
   round 2, and the usual PR flow.
4. The revisit items that are not covered by the note: Dependencies resolve rejects
   transitive `dependsOn` chains (run 002 cycle 3); reproduce consumes its fixture
   (deletions persist to the scratch document; the operator restored it); the "a session
   states a checkable fact in checkable form" idea, now judged unnecessary but written up
   in this session's transcript if she changes her mind.
5. Then noscope on roughdraft, quipu, the scan (from the earlier handoff).

## 6. WORKING AGREEMENTS (standing; do not re-ask)

- One PR at a time on `pr-<slug>` targeting main, no stacking on GitHub. Use a separate
  `git worktree` per branch under the scratchpad; reviewers work in the worktree and never
  switch branches. "Merge as you go": merge after CI green and review findings applied.
  Mauria's standing word from 2026-09-13: "feel free to merge when you're sure the PR is
  done and green" (given for the overnight run; confirm it still stands for round 3).
- Every PR: commit; review by direct subagents (`general-purpose`, named
  `review<N>-<angle>`, briefed with the design context; findings are secondhand until
  reconciled; their reports arrive as teammate messages, often truncated, so ask for the
  rest by `SendMessage`); push; `gh pr create` with body = plan step text verbatim, "##
  Deviations, with reasons", then "## From the review"; build-record entry on the branch;
  CI on the head SHA (confirm `gh pr view --json headRefOid` matches); squash-merge with
  branch deletion; pull; `pnpm build` in the checkout.
- Docs travel with the change (DESIGN.md, docs/architecture.html, README, build record).
  Never `git add -A`. Never commit in the same command as an edit. Sentence-case commit
  messages, no emoji, no attribution. Check `pnpm check`'s exit code, never its grepped output.
- Chat: provenance labels (verified, inferred, secondhand), answer first, tables for
  parallel items, no em-dashes, plain full sentences; when she says a paragraph is too
  compressed, rewrite it longer, not shorter.
- Quipu: message the `quipu` keeper with thread and change; spawn one if none runs.
- Pushes of main need her yes each time; PR branches push freely.
- Fan out bulk checks across subagents (the claims audit: four agents, 27 claims each).

## 7. ANCHORS

- Repo `~/Documents/Projects/noscope`; `pnpm check`; `./bin/noscope.mjs --help`;
  `NOSCOPE_DB=<file>`, `NOSCOPE_CLAUDE_BIN=<binary>`; tests use `test/stub-claude`;
  `NOSCOPE_LIVE=1` runs the live tests (Haiku provider; Playwright reproduce).
- A live run: from `~/Documents/Projects/roughdraftplus` with `NOSCOPE_DB` set; `incident
  step <id>` one cycle at a time. A cycle with a reproduce can exceed ten minutes, so run
  it detached (`nohup sh -c '... >> log; echo "exit $?" >> log' & disown`) and watch the
  log with a Monitor; the Bash tool's timeout kills a backgrounded step.
- Reading a run: `incident review <id>` (per cycle, per task, totals by role and model,
  cost), `incident tree`, `incident show`, `incident events`; task results are in the
  `tasks` table's `result_json` (`sqlite3 <db> "select result_json from tasks where
  id='001-t13'"`); plan payloads are in `plan.proposed` events; session transcripts are
  under `~/.claude/projects/-Users-mauriaparker-Documents-Projects-roughdraftplus/<session id>.jsonl`.
- Code map: `src/models.ts` (Claim, Situation, EvidenceFrom, CapabilityRequest with
  answer, ActionPlan), `src/store.ts` (event log, replay, migrations), `src/planner.ts`
  (system prompt, 13 rules, the ten sections, `lastSituationOf`, grep collapse),
  `src/validator.ts` (the rules; status gates at the "Inferred links are worked" and
  "Status is earned" checks), `src/runtime.ts` (`applyPlan`: blocked on any request),
  `src/dispatcher.ts` (`briefContext`, chains, time bounds), `src/verifier.ts`
  (`recordClaims`, `promoteMatching`, `recordSessionResult`),
  `src/capabilities/{registry,session,investigate,reproduce,deterministic}.ts`
  (`session.ts` renders briefs), `src/equipment/external.ts` (Playwright launch),
  `src/providers/claude-code.ts` (flags, mcp-config, allowlist), `src/commands/incident.ts`
  (`answer`, `provide`, `holdsOn`), `src/review.ts`.
- Docs: `DESIGN.md` (the contract; decisions table at the top, the ICS mapping, the
  channel table "The planner lacks", the CLI table, the Reference rows on Playwright),
  `BUILD-PLAN.md` (round 2 at the end), `docs/build-record.md` (entries through PR 27),
  `docs/first-incident.md` (runs 001 and 002), `docs/architecture.html`, README.
- The audit's per-claim tables are in this session's transcript (four subagent reports,
  2026-09-14 18:41 to 18:45 CDT); the reconciled counts are in 4.8.

## 8. GOTCHAS

- biome reflows code after `lint:fix`; exact-string edits miss; write scripts with
  whitespace-tolerant anchors or rewrite small files whole. `exactOptionalPropertyTypes` is
  on. knip fails on unused exports. The Write tool is blocked by a security hook whenever
  the file's text contains the word exec followed by an opening parenthesis; a heredoc
  through Bash is not.
- A python script that edits several files must read, edit and write each file once; two
  edits that each start from the on-disk original lose the first (it happened here).
- `bin/noscope.mjs` runs `dist/` with no staleness check: `pnpm build` in the checkout
  before any live run, and `find src -name '*.ts' -newer dist/cli.js` to be sure.
- Roughdraft's save pads table cells and drops blank lines; rebuild the committed file from
  HEAD plus the intended edits rather than committing its output.
- `timeout` is not on this machine; a foreground `sleep` is refused by the tool; wait with
  `until <check>; do sleep N; done` in a background command or a Monitor.
- Playwright's MCP server refuses `file:` URLs; it now runs inside its output directory
  under the OS temp dir. Reproduce sessions persist their edits to the document they are
  pointed at, so use a scratch copy and keep a pristine copy to restore from.
- Outcome events name their task inside `payload.mutation.taskId`; `task.usage` and
  `task.insufficient` name it at the top.
- The planner snapshot (`test/planner.test.ts`) pins the rendered sections; update with
  `pnpm vitest run test/planner.test.ts -u` and read the diff.
- The permission classifier refuses `ps` listings of other processes; `pgrep -f
  "noscope.mjs incident step"` is allowed.
- Subagent reports arrive as teammate messages and are often truncated; ask for the rest.

## 9. HOW TO CONTINUE THE CONVERSATION

Mauria thinks in ICS and reasons from doctrine to mechanism; answer in ICS terms first and
map to code second, and say when a doctrine claim is from training rather than checked
against the FEMA text. She rules; the session maps. When she asks "wym" or "explain" or
says something is confusing or too compressed, the fault is compression: restate in full
sentences with the example, and never shorter. Verify every mechanism before offering it as
an option (the `claude --help` and Playwright `--help` checks are the model). Label every
claim verified, inferred or secondhand. When she seems satisfied but has not said "go",
ask whether she is ready rather than starting. The last thing she was told, and agreed
with in substance, is 4.9; the next thing she expects is the design note of section 5,
after she says to write it.
