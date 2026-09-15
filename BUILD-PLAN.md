# noscope v0 build plan

Derived from `DESIGN.md` at commit 4d5f68a and `docs/architecture.html`. Fifteen PRs, each
mergeable on its own, the CLI working after every one; round 2, from the first incident's
audit, and round 3, the Incident Commander and units with leaders, follow at the end. Every PR targets `main`. The design
document is the contract; where this plan and it disagree, the design wins and this plan
gets fixed.

## Order and shape

| PR | Title | Depends on | Delivers, in one line |
|---|---|---|---|
| 1 | Skeleton | none | A pnpm TypeScript package with biome, vitest, knip, CI, and a `noscope` binary that prints help. |
| 2 | Contracts | 1 | Every zod schema from the design in `src/models.ts`, with JSON Schema export tested. |
| 3 | Store | 2 | `better-sqlite3` with the six tables, a transaction helper that writes the event with every change, and the replay test. |
| 4 | Incident commands | 3 | `incident create`, `show`, `events`: an incident with its root unit exists and prints as an incident file. |
| 5 | Equipment | 2 | The equipment registry and the seven function equipment items, tested against fixtures. |
| 6 | Deterministic capabilities | 3, 5 | The capability registry, `check_path`, `read`, `grep`, `git_history`, and the verifier's verified-claim path. |
| 7 | Claude Code provider | 2 | The provider interface, the Claude Code renderer with the isolation flags, result parsing, and a stub binary for tests. |
| 8 | Session capabilities | 6, 7 | The preamble, `investigate`, `interpret`, the `insufficient` outcome, and the verifier's asserted-claim path. |
| 9 | Planner | 4, 7 | Incident file rendered in stable order, one provider call with the action plan schema, `plan.proposed`. |
| 10 | Validator | 9 | Every rule from Step 5, one test each, `plan.rejected` fed back next cycle. |
| 11 | Apply and tree | 10 | The tree changes shape with its events; `incident tree`. |
| 12 | Dispatch and step | 8, 11 | Ready tasks run in sequence under time bounds with usage recorded; `incident step` runs one full cycle. |
| 13 | Blocking channels | 12 | Questions for a human and capability requests block the incident; `incident answer` resumes it. |
| 14 | Run to completion | 13 | `incident run` with a cycle cap; `satisfied` and `failed` earned per the rules. |
| 15 | First incident | 14 | The Roughdraft scroll-after-delete investigation run end to end, prompts tuned, acceptance checklist signed. |

PRs 5, 6, 7 and 8 can run in parallel with 4, 9, 10 and 11 once 2 and 3 are in. Everything
after v0 is listed at the end and is not in this plan.

## The PRs

### PR 1: Skeleton

Scope: `package.json` (pnpm, `"type": "module"`, `bin: { noscope }`), `tsconfig.json`
targeting Node 24, biome and knip configs copied in shape from roughdraftplus, vitest, a
GitHub Actions workflow running lint, typecheck and test, `src/cli.ts` with `--help` and
`--version`, README updated with install and run.

Acceptance: `pnpm install && pnpm build && ./bin/noscope.mjs --help` prints the command list
from Step 7, every command a registered stub that names what delivers it; CI is green on the PR.

### PR 2: Contracts

Scope: `src/models.ts` with zod schemas for Incident, Unit, Task, Claim, Event, Grant,
Budget, Cost, ActionPlan with UnitProposal, UnitClose, TaskProposal, GrantRequest,
CapabilityRequest, SopApplication, SessionResult with `outcome`, `needed` and its kinds,
and the provider-and-model pair. Status enums exactly as the design's tables name them.

Acceptance: a test converts ActionPlan and SessionResult to JSON Schema with
`z.toJSONSchema` and asserts the draft-2020-12 output has no unrepresentable types; a test
parses a hand-written action plan and rejects one with an unknown status.

### PR 3: Store

Scope: `src/store.ts` opening `better-sqlite3` in WAL mode, creating the six tables from
Step 2 with their columns, including `budget_json`, `questions_json`,
`capability_requests_json`, `provider`, `model`, `instructions` and the `grants` table with
`scope` and `per_task`; a `transact(fn)` helper that takes the state change and the event in
one transaction and assigns the event sequence; typed read functions for each table.

Acceptance: the replay test from acceptance criterion 7: after a scripted set of changes,
replaying the events table reproduces every current-state table.

### PR 4: Incident commands

Scope: `noscope incident create "<objective>" [--constraint ...] [--priority ...] [--budget ...]`
creating the incident and its root unit `command` with `incident.created` and
`unit.created`; `incident show` printing the incident file as the design lists it;
`incident events` printing the log. Budget defaults to unlimited.

Acceptance: criterion 1. `show` on a fresh incident prints the objective, the root unit,
no claims, no tasks, no questions, no grants, and the registered capabilities.

### PR 5: Equipment

Scope: `src/equipment/registry.ts` with `defineEquipment` (name, input and output schemas,
`cost`, `run`); `filesystem.ts` (`read_file`, `list_directory`, `grep_files`), `git.ts`
(`git_status`, `git_log`, `git_diff`), `shell.ts` (`run_readonly` over the allowlist `ls`,
`cat`, `head`, `tail`, `wc`, `find`, `stat`), `builtin.ts` naming the provider built-in
tools and the Bash allowlist shape.

Acceptance: each function equipment item has a test against a fixture directory and a
fixture git repo; `run_readonly` rejects a command off the allowlist.

### PR 6: Deterministic capabilities

Scope: `src/capabilities/registry.ts` with `defineCapability` (name, description,
equipment, input, output, effect, produces, cost, optional session);
`deterministic.ts` with `check_path`, `read`, `grep`, `git_history` calling equipment
in-process; `src/verifier.ts` turning a deterministic result into `verified` claims with the
capability and inputs as provenance, writing `claim.verified`.

Acceptance: running `grep` against the fixture produces verified claims whose provenance
names the capability and inputs; `incident show` lists the four capabilities.

### PR 7: Claude Code provider

Scope: `src/providers/base.ts` with the provider interface (a session request in, a
SessionResult plus usage and session id out) and the fixed preamble text from the design,
including the ICS orientation, the term mapping and the four kinds of lack;
`claude-code.ts` rendering the request onto `claude -p` with `--model`,
`--system-prompt`, `--tools`, `--allowedTools`, `--json-schema`, `--add-dir`, and the five
isolation flags, running it, parsing `structured_output` and the usage fields;
`test/stub-claude` as a stub binary that echoes a canned result, so tests need no network.

Acceptance: a test renders the exact argument list for a sample capability and task and
compares it to the flags the design verified; a test runs the stub and gets a parsed
SessionResult; one opt-in live smoke test (`NOSCOPE_LIVE=1`) runs a Haiku session and
asserts `outcome` is present.

### PR 8: Session capabilities

Scope: `src/capabilities/investigate.ts` with `investigate` (equipment `Read`, `Grep`,
`Glob`, `Bash` under the read-only allowlist) and `interpret` (no equipment), both with
their role prompts and output schemas carrying `outcome`; the task brief rendered as the
user message with the owning unit's purpose line; the verifier's asserted-claim path and
the `task.insufficient` event.

Acceptance: with the stub provider, an `investigate` task produces asserted claims with the
session id as provenance; an `interpret` task whose stub answers `insufficient` produces no
claims and one `task.insufficient` event carrying `needed` with kinds.

### PR 9: Planner

Scope: `src/planner.ts` rendering the incident file into the nine labeled input sections in
the design's order, calling the provider with the ActionPlan JSON schema, writing
`plan.proposed` with the rationale.

Acceptance: a snapshot test of the rendered input for a fixture incident; with the stub
provider returning a fixed plan, `plan.proposed` is written with that plan.

### PR 10: Validator

Scope: `src/validator.ts` with every rule in Step 5 as a named function: capabilities
exist, units exist, no cycles, no duplicates, inputs validate, span of control, effect
policy, budget respected, dependencies resolve, closing is clean, status is earned, model
known. A rejected plan writes `plan.rejected` with the rule name, and the next planner
input carries it.

Acceptance: one test per rule, each with a plan that fails only that rule; a plan that
passes every rule returns unchanged.

### PR 11: Apply and tree

Scope: `src/runtime.ts` applying an approved plan in one transaction: units created and
closed, tasks created and cancelled, each with its event, then `plan.applied`;
`src/tree.ts` rendering the unit tree with task marks; `noscope incident tree`.

Acceptance: criteria 2, 4 and 5 with the stub provider: a plan creating a unit and a task
applies; a later plan closing the unit shows it closed in `tree` and `events`; a plan
giving one unit eight children is rejected and a regrouped plan passes.

### PR 12: Dispatch and step

Scope: `src/dispatcher.ts` computing ready tasks, running them one after another, enforcing
the task's time bound, writing `task.started`, the result event and `task.usage`; the
budget check against `cost` and usage; `noscope incident step` wiring observe, plan,
validate, apply, dispatch, verify, record and printing what happened.

Acceptance: criterion 3 with the stub provider: after one `step`, tasks ran and their claims
appear with the right status; a task over its time bound fails with `task.failed`.

### PR 13: Blocking channels

Scope: `questionsForHuman` and `capabilityRequests` in an applied plan set the incident to
`blocked` and write `question.asked` or `capability.requested`; `incident show` prints
them; `noscope incident answer <id> "<text>"` writes `question.answered`, stores the answer
where the planner input reads it, and returns the incident to `open`.

Acceptance: criterion 8 with the stub provider: an `interpret` task answering
`insufficient` leads the next `step` to a plan that creates the task supplying what was
needed; a plan with a question blocks the incident and `answer` unblocks it.

### PR 14: Run to completion

Scope: `noscope incident run <id> [--max-cycles N]` repeating `step` until the incident
leaves `open` or the cap is hit; `satisfied` earned only per the status rule; `failed`
recorded with the planner's rationale.

Acceptance: criterion 6 with a scripted stub: the incident reaches `satisfied` with a
verified claim; the cap stops a runaway loop.

### PR 15: First incident

Scope: run `noscope incident create "Determine why Roughdraft scrolls to the bottom comment
after a comment is deleted, instead of staying where the deleted comment was, and identify
the code path responsible, in ~/Documents/Projects/roughdraftplus"` against the live Claude
Code provider, one `step` at a time; tune the preamble, the role prompts and the planner
input until the tree changes shape as the design describes; record the run's events and
tree in `docs/first-incident.md`.

Acceptance: all eight criteria observed on the live run and checked off in
`docs/first-incident.md` with the event log excerpts that show each.

## Conventions

| Rule | Detail |
|---|---|
| One PR per row, targeting `main`, no stacking. | Each PR leaves the CLI working: a command not built yet is a registered stub that names what delivers it and exits 3, per the exit-code table in the design's Step 7. |
| Tests run with no network. | Every provider call in tests goes through the stub binary; the one live test is opt-in behind `NOSCOPE_LIVE=1`. |
| Commit messages are sentence-case descriptions, as in roughdraftplus. | No emoji, no attribution footers. |
| Docs travel with the change. | A PR that changes a command, a flag, a table or a schema updates `DESIGN.md`, `docs/architecture.html` and the README in the same PR. |
| Lint, typecheck and test in CI on every PR. | biome, `tsc --noEmit`, vitest, knip. |

## After v0, not in this plan

SOPs and `incident sop`; grants and `incident grant`, `grant standing`, `--per-task`; the
MCP equipment server and external MCP servers as equipment (round 2 brings in the first
external server, a browser, in R2-7); the Codex provider; parallel
dispatch; the Situation Unit as a session (round 3 gives its change report to the runtime); cross-incident priorities; auto-whitelisting of grants.
The schema slots for grants, SOP applications and capability requests are created in PR 2
and PR 3 so none of these needs a migration.

## Open questions

| Question | Blocks |
|---|---|
| Whether PR 15's tuning of prompts should feed back into `DESIGN.md` as rulings or stay in `docs/first-incident.md` as findings. | Only how PR 15 is written up. Default: findings, with any ruling Mauria makes moved into the design. |

## Round 2: from the first incident's audit

Derived from `docs/first-incident.md`, the `incident review 001` report, and the analysis
of 2026-09-13 that re-rendered every cycle's planner input from the event log (the method:
replay the log up to each `plan.proposed` into a fresh store and call
`renderPlannerInput`). Eight PRs in dependency order, each mergeable on its own; the last
one reruns the first incident and measures the round. Numbered R2-1 to R2-8 here; the
build record maps each to its GitHub number. The conventions above apply.

| PR | Title | Depends on | Delivers, in one line |
|---|---|---|---|
| R2-1 | Claim basis and the confidence scale | none | Every claim says whether it was observed or inferred, and sessions are told what a confidence number means. |
| R2-2 | The situation carried in the plan | R2-1 | The planner writes a structured situation each cycle and reads its last one back; inferred links name what settles them; a keep list names the claims to hold in view; every session brief carries it (R2-5). |
| R2-3 | What the planner reads | R2-2 | Match claims shown once, then only if the situation names them; session results shown in full. |
| R2-4 | Task refs | none | A plan can chain new tasks on each other, so a chain runs in one cycle. |
| R2-5 | Evidence by reference | R2-4 | A task names the claims and results it needs and the runtime attaches them; the planner stops copying evidence. |
| R2-6 | Roles and rules | R2-1, R2-2, R2-5 | The prompt text: interpret looks for alternatives, investigate names what would settle an inference, the planner asks or reproduces as soon as a link leaves the repository. |
| R2-7 | Browser capability | R2-1 | `reproduce`: a session with a browser that settles a claim about runtime behavior by observing it. |
| R2-8 | Second run of the first incident | R2-3, R2-6, R2-7 | The same objective rerun live with everything above, measured with `incident review` beside run 001. |

R2-4 and R2-5 can run in parallel with R2-1 to R2-3. R2-7 can start once R2-1 is in.

### R2-1: Claim basis and the confidence scale

Scope: `Claim` and the session output claim schema in `src/models.ts` gain `basis:
"observed" | "inferred"`, required. The verifier writes `observed` on every deterministic
claim and requires the field on every session claim. The session preamble in
`src/providers/base.ts` defines the scale next to the field: observed in code or in
output, 0.9 to 1; inferred from code, at most 0.7; runtime behavior not reproduced, at
most 0.5. Planner input section 3 shows the basis on each asserted claim. `incident
review` counts inferred claims per task. DESIGN.md Vocabulary (claim) and Step 6 follow.

Acceptance: the models test rejects a session claim without a basis; the verifier test
shows a grep claim entering with `observed`; the planner snapshot shows the basis; the
preamble test pins the three scale lines.

### R2-2: The situation carried in the plan

Scope: `ActionPlan` gains `situation`: `changed` (what changed since the last cycle, one
paragraph), `hypothesis` (the current explanation, one paragraph), `proven` (the verified
claims that bear on the hypothesis, each as its id and one line), `inferred` (entries of
claim id plus `settledBy`: a task ref or id in this plan, a question id in this plan, or
the word `reproduce` with a task ref), and `keep` (claim ids to hold in view next cycle).
`rationale` stays and becomes "why this plan", one paragraph. The planner input gains
section 10, "Situation from the last cycle", rendering the last applied plan's situation
verbatim, or "(none)" on the first cycle; it goes last because the provider caches the
unchanged front of a prompt and this section changes every cycle. Two validator rules:
"Inferred links are worked" (every `inferred` entry's `settledBy` names a task in this
plan, an open task, or a question this plan raises) and, under "Dependencies resolve",
every claim id in `proven`, `inferred` and `keep` names an existing claim. `plan.proposed`
and `plan.applied` carry the situation; `incident show` prints the last situation under
decisions.

Acceptance: validator tests for both rules, accept and reject; a planner test that a
situation applied in cycle 1 renders in cycle 2's section 10 and that cycle 1 shows
"(none)"; the snapshot test updated; the stub plans in `test/run.test.ts` carry a
situation.

### R2-3: What the planner reads

Scope: in `renderPlannerInput`, a claim from a capability whose definition declares
`summarize: true` (grep, in v0) appears in full only in the cycle after it lands;
afterwards it appears only if the last situation's `proven` or `keep` names it, and the
rest of its task's claims collapse to one line per task: the pattern, the match count, and
the files with counts. Section 5 shows each completed task's result in full (summary and
observations for a session, the deterministic result as now) instead of clipped at 200
characters; the clip stays on inputs. DESIGN.md Step 4 (the nine sections, now ten) and
the planner input description follow.

Acceptance: a test on synthetic events where a grep's claims appear in full in cycle 2,
collapse in cycle 3, and one kept claim stays; a test that a session's summary and
observations reach section 5 unclipped; the snapshot updated. Recorded in the PR: the
planner input of incident 001 re-rendered under the new rendering, cycle by cycle, beside
the analysis's figures (1.09M planner input tokens as run; 427k when match claims no later
plan cited are dropped).

### R2-4: Task refs

Scope: `TaskProposal` gains optional `ref`, the same shape as a unit ref. `dependsOn` may
name a ref of a task created in the same plan. The validator resolves refs under "No
cycles" (a ref is used once, is not an existing task id, does not start with the incident
id, and the new tasks' dependency graph is acyclic) and "Dependencies resolve".
`applyPlan` assigns ids in plan order and rewrites `dependsOn` refs to ids before creating
tasks. The dispatcher is unchanged: a dependent becomes ready when its dependency
completes and runs in the same pass. The planner prompt says a chain of tasks belongs in
one plan. DESIGN.md Step 4 and Step 5 follow.

Acceptance: validator tests for a valid chain, a cycle among new tasks, an unknown ref, a
ref colliding with an existing id; a runtime test that ids are assigned and dependsOn
rewritten; a run test where a plan with grep then interpret chained on it completes both
in one cycle.

### R2-5: Evidence by reference

Scope: `TaskProposal` and `Task` gain `evidenceFrom`: `claims` (claim ids) and `tasks`
(task ids, or refs in this plan, which `applyPlan` rewrites to ids as it does for
`dependsOn`). The planner fills it from the ids its input shows in sections 2, 3 and 5 and
from the refs in the same plan. At dispatch the runtime renders the named claims (subject,
predicate, object, basis, confidence, evidence) and the named tasks' results (summary and
observations, or the deterministic result) into the brief after the task's own inputs. The
interpret capability's `evidence` input becomes optional; the validator requires one of
`evidence` or `evidenceFrom` on an interpret task ("Inputs validate"). The brief opens
with the incident objective, then the last situation's hypothesis and its proven list
(R2-2), so every session on the incident starts from what the incident currently believes
and has established. The planner rules say: name evidence by id, do not copy it. DESIGN.md
Step 3 (task fields, the brief) and Step 5 follow.

Acceptance: a dispatcher test that a brief carries the referenced claims and a referenced
task's summary; a validator test for interpret with neither; a brief snapshot; the run
test from R2-4 extended so the chained interpret reads the grep's claims by reference and
its inputs carry no copied evidence.

### R2-6: Roles and rules

Scope, prompt text only, in `src/planner.ts`, `src/providers/base.ts` and
`src/capabilities/investigate.ts`: the interpret role asks for the strongest alternative
explanation and what would falsify the leading one; the investigate role requires, for
every inferred claim, the runtime observation or file that would settle it, in the claim's
evidence; the planner prompt says a brief to interpret carries the question and the
evidence and never the conclusion, that a link that cannot be established from the
repository is settled by reproducing it (R2-7) or by a question for the human in the same
plan, never by more reading, and that `rationale` says why this plan and nothing the
situation already says. The rules list in section 9 gains the two rules from R2-2.
`docs/first-incident.md` gets a short section naming each prompt change and the cycle of
run 001 that motivated it.

Acceptance: snapshot tests updated; a reviewer subagent reads every brief-shaped example
in the prompts for leading language before merge. The measure is R2-8.

### R2-7: Browser capability

Scope: the first external MCP servers as equipment, a new equipment kind `mcp_server`
declared with a launch command and passed to the session with `--mcp-config` and
`--strict-mcp-config`; the config file's shape is the one `spikes/mcp-tools-filter/run.sh`
uses. Two classes of browser equipment are declared: headless, `@playwright/mcp` (on npm,
0.0.80 on 2026-09-13; launch command per the package's README, checked when built); and
visible, Claude in Chrome (Claude Code's own Chrome integration, which drives Mauria's
Chrome through its extension; how a `claude -p` session reaches it is established from
`claude --help` and the Claude Code docs), with the Codex equivalent added when it exists.
R2-7 records for each whether a `claude -p` session can reach it in DESIGN.md's Reference
table, and `reproduce` takes a `browser` input naming which one.

A session-backed capability `reproduce`: inputs `url`, `steps` (what to do, in order) and
`observe` (what to look for); role text: perform the steps, report what was observed as
observed claims, never infer; output schema with the observations and a screenshot path
per step. Registered `read_only`: browsing a running app can change its data (reproducing
this bug deletes a comment), so an incident that uses `reproduce` names a scratch copy of
the app's data in a constraint; grants stay after v0. The session preamble's equipment
list and DESIGN.md Step 3 (equipment kinds, the after-v0 note) follow.

Acceptance: the capability registered and validated like the others; each browser's launch
tested by an opt-in live test (`NOSCOPE_LIVE=1`) that opens a static page from
`test/fixtures` and returns an observed claim about its title, with whether a headless
session could reach each browser recorded; the stub path covers the rest.

### R2-8: Second run of the first incident

Scope: before the run, Mauria starts Roughdraft on a scratch copy of a document with
comments (`roughdraft start`, then `roughdraft open <copy>`) and gives its URL. `noscope
incident create` with the objective of run 001 plus two constraints (the app runs at that
URL on a scratch copy of the document, which `reproduce` may change; the repository is
read only), stepped live with everything above; `incident review 002` recorded beside 001
in `docs/first-incident.md` under a "Second run" section, with the cycle count, planner
input, cost, and how the step code cannot prove was settled.

Acceptance: the run reaches `satisfied` with the same code path named. The measures are
reported beside run 001 with no thresholds: the measure is what it took to reach the right
answer. The report also says how run 002 settled the one step code cannot prove, where the
editor's selection rests before a deletion; run 001 settled it by a question to Mauria at
cycle 9, and run 002 has `reproduce` for it.

## Round 3: the Incident Commander and units with leaders

Derived from run 002's measures in `docs/first-incident.md` and the design conversation of
2026-09-14, afternoon and evening, whose rulings are recorded in the quipu thread
`ics-runtime.md` and summarized in `handoff-noscope-build.md`. R3-0's checks ran on
2026-09-15; the results are in its scope. Eleven PRs in dependency order, each mergeable
on its own, the CLI working after every one; the last reruns the first incident. Numbered
R3-0 to R3-10 here; the build record maps each to its GitHub number. The conventions above
apply. DESIGN.md is updated by each PR for what it changes, and the design wins where this
plan disagrees with it.

What round 3 builds, in one paragraph. Every unit has a leader: a session created with the
unit that holds its objective, runs its tasks in order, and reports against that
objective. The root unit's leader is the Incident Commander, a persistent session that
sets each operational period's objectives and priorities, reviews the planner's draft
against them, reads the units' reports, and closes or reorganizes. The planner stays as it
is, stateless and fed the full file. The runtime is the Planning Section's bookkeeping: it
briefs the IC at the top of each cycle, checks the plan's shape, dispatches, and records.
An initial IC on a cheap model sizes the incident up and hands command over with a
briefing. Leaders deploy strike teams of subagents, and every tool call and subagent run
lands in the event log. Claim status stops gating anything.

| PR | Title | Depends on | Delivers, in one line |
|---|---|---|---|
| R3-0 | Mechanism checks | none | The five spikes the round rests on, landed under `spikes/round3/` with their results in DESIGN.md's Reference table. |
| R3-1 | Tool and subagent events | none | Every tool call a session makes, and every subagent it spawns, is an event filed under the task in flight. |
| R3-2 | Status is a label | none | Promotion and `claimsToVerify` go; `proven` and `satisfied` key on basis `observed`; status says where a claim came from and gates nothing. |
| R3-3 | Persistent sessions | R3-0 | The provider can resume a session for one more structured call, with that call's own usage. |
| R3-4 | Unit leaders | R3-1, R3-3 | A unit has a leader session that runs its tasks and reports against its objective; the preamble and role texts say what a leader is. |
| R3-5 | Strike teams | R3-4 | A task declares the subagent team a leader may send; the runtime provides it and logs every member. |
| R3-6 | Lacks resolve at the leader | R3-4 | A leader resolves a retrievable fact itself and sends the rest up as resource requests; a unit waits, the incident does not block. |
| R3-7 | The IC above the planner | R3-2, R3-4 | The IC sets period objectives and priorities, reviews the plan in one round, reads reports, and ends a period early on a change of picture. |
| R3-8 | Initial IC and transfer of command | R3-7 | `create` runs a cheap size-up that writes the incident briefing and names the IC's model; command transfers with a recorded event. |
| R3-9 | IC handoff at the context threshold | R3-7 | The IC is never compacted: the runtime hands off to a fresh session below the limit, as a transfer of command. |
| R3-10 | Third run | all | The first incident rerun with everything above, measured with `incident review` beside runs 001 and 002. |

R3-1, R3-2 and R3-3 can run in parallel once R3-0 is in. R3-5 and R3-6 can run in parallel
with R3-7. R3-8 and R3-9 can run in parallel.

### R3-0: Mechanism checks

Scope: the scripts run on 2026-09-15 land under `spikes/round3/` in the form of
`spikes/mcp-tools-filter/run.sh`, and DESIGN.md's Reference table gains one row per
result. The results, each from a live Haiku call on Claude Code 2.1.272 unless noted:

| Check | Result |
|---|---|
| A call resumed with `--resume <id>` accepts its own `--json-schema` and returns one structured result for that call. | Passes: three calls on one session with three schemas returned three structured outputs, and the session remembered across them. |
| A resumed call reports usage for that call alone. | Passes: `num_turns` was 2 on every call and cache writes grew by one turn each time. Cache reads were 0 on every call, consistent with the schema changing per call; R3-3 confirms cache reads with a fixed schema. |
| Auto-compaction can be turned off for a headless session. | Passes, from the docs (`code.claude.com/docs/en/model-config`): `DISABLE_COMPACT` in the environment disables it, and the session errors at the context limit instead. `--autocompact <tokens>` sets the window when compaction is wanted. |
| The parent envelope accounts for subagent usage. | `total_cost_usd` includes the subagents (the `modelUsage` entries sum to it); `modelUsage` lists each model; `subagent_stats` counts spawned, completed, failed and by type. Each subagent's transcript under `<session>/subagents/` carries its own per-message usage and a `.meta.json` with the `toolUseId` of the `Agent` call that spawned it. |
| `--agents <json>` is honored on a `--resume` call. | Passes: a session started without agents, resumed with a `pinger` kind, spawned it. |

Acceptance: the scripts run from their directory and print the results above; the
Reference rows cite the date and the Claude Code version.

### R3-1: Tool and subagent events

Scope: `src/providers/claude-code.ts` runs every session with `--output-format
stream-json` and reads the stream: each `tool_use` block and the `tool_result` that
answers it (matched on `tool_use_id`) become one `tool.called` event carrying the session
id, the unit, the task in flight, the tool name, the full input, the result clipped at a
size cap with the transcript path as the full record, `is_error`, and the duration between
the two timestamps. The final `result` message is parsed as the envelope is today. When
the envelope's `subagent_stats.spawned` is nonzero, the provider reads each transcript
under `~/.claude/projects/<dir>/<session id>/subagents/` and writes one `subagent.ran`
event per member: agent id, type from its `.meta.json`, model, the `toolUseId` that links
it to its `tool.called`, its usage summed from its assistant messages, and its own tool
calls as nested `tool.called` events. Usage on `task.usage` stays the envelope's figures;
a subagent's usage is a breakdown, never added. `incident review` shows tool calls and
subagents per task. Two event types added to `EventType` and to DESIGN.md Step 2; Step 6
says what the log holds per session.

Acceptance: a provider test on a recorded stream (a fixture captured from a real Haiku
session with one Bash call and one subagent) produces the expected `tool.called` and
`subagent.ran` events with the link between them; a test that a clipped result names the
transcript; the stub binary emits stream-json so every existing test still passes.

### R3-2: Status is a label

Scope: `promoteMatching` and the `claim.verified` promotion path go from
`src/verifier.ts`; `claimsToVerify` goes from `ActionPlan`, from `applyPlan`, from the
validator's "Dependencies resolve" line and from `step`'s output. The "Inferred links are
worked" rule accepts in `proven` any claim whose basis is `observed`, whichever task
observed it; "Status is earned" requires at least one observed claim for `satisfied`
rather than a verified one. Planner input sections 2 and 3 become one section, claims,
each line showing its status and basis; the planner prompt says status names the source
(deterministic equipment or a session) and basis says whether it was seen. The store
migration is a no-op on rows. DESIGN.md Vocabulary (claim), Step 4, Step 5 and Step 6
follow; the sentence "only deterministic verification promotes it" goes.

Acceptance: validator tests that a `proven` entry naming an observed session claim passes
and an inferred one fails; a `satisfied` plan with observed claims and no verified ones
passes; the models test rejects a plan with `claimsToVerify`; the planner snapshot
updated; a verifier test that a matching deterministic claim no longer changes an asserted
claim's status.

### R3-3: Persistent sessions

Scope: `SessionRequest` gains optional `resume: string` (a session id); the Claude Code
renderer adds `--resume <id>` when it is set and never sets `--no-session-persistence`.
`SessionOutcome` is unchanged: one structured result and one usage record per call, which
R3-0 established. The provider passes `DISABLE_COMPACT=1` in every session's environment,
so compaction never rewrites a session the runtime is resuming. A live test behind
`NOSCOPE_LIVE=1` runs two calls on one session with the same schema and asserts the second
call's cache reads are nonzero (the open observation in R3-0). DESIGN.md Step 3 (session
fields) and the Speed section's last sentence follow.

Acceptance: a renderer test that `resume` produces the flag and its absence does not; the
stub binary honors `--resume` by echoing the id back as `session_id`; the live test.

### R3-4: Unit leaders

Scope: a unit has a leader. `UnitProposal` and `Unit` gain `leader`: `provider` and
`model` (required), and the unit's `equipment` and `bashAllowlist` declared the way a
capability declares them, read-only until grants exist; `Unit` also gains `sessionId`
(null until the leader first runs) and `objective` replaces `purpose` (the migration
copies it). The root unit is created with a leader too, whose model is fixed to Opus 5
until R3-8 routes it; the leader machinery is the same for the root as for every other
unit, so R3-7 gives the root leader a different schema and nothing else. A leader's
session is created when its unit first has a ready task and demobilized (its id recorded
on `unit.closed`) when the unit closes.

Dispatch, rewritten in `src/dispatcher.ts`: a ready task runs inside its unit's leader
session when the task's model and equipment match the leader's, as one resumed call whose
prompt is the task brief and whose schema is the capability's output schema; it runs in a
session of its own, as today, when they differ, and its result is then rendered into the
leader's next call. Either way the log records `task.started`, `task.completed` or
`task.insufficient`, `task.usage` and the claims per task, so `incident review` costs each
task on its own. A deterministic task runs as today and its result goes to the leader's
next call. A unit runs until its leader reports: after each of its tasks, the leader's
session is resumed with the result and asked for its next move under the `LeaderTurn`
schema: `report` (outcome `met`, `not_met` or `progress`; `changed`, a list of what is now
true that was not, each naming the claims it rests on; `picture_changed: boolean`; and for
`not_met`, `why` and `suggestion`, so the IC, which has more perspective, decides what
happens next), or `continue` when tasks remain. Every turn schema in this round
(`LeaderTurn`, `ActionPlan`, `CommandTurn`, `ReviewTurn`) also carries an optional
`discrepancy`: the seat says that the update it received describes a different problem
from the one it has been working (it believed it was fighting a fire and the update
describes a hurricane), and what differs. The runtime records `picture.discrepancy` and
the IC's next change report opens with it; the role text of every seat bounds it to a real
difference in what the problem is, never a disagreement over a detail, so that the seats
stay on one picture without arguing each turn. `unit.reported` records every report. A
unit with no tasks left and no report is asked for one. Dispatch runs one unit at a time,
in tree order, until every unit with ready tasks has reported or one reports
`picture_changed`.

The preamble in `src/providers/base.ts` is rewritten for the seats: what the system is
(the IC sets objectives and priorities, the planner drafts, the IC approves, the validator
checks, units run under their leaders and report); the terms gain Incident Commander,
initial IC, unit leader, situation report, operational period, transfer of command, strike
team, task force and subagent, and "nothing runs as a unit" goes; the session's place is
rendered per seat, and the runtime renders the hierarchy around the session from the tree
at brief time (its unit, its parent, who it reports to, what is below it). The leader role
text: it owns its unit's objective, directs its tasks, reports what changed and not what
it did, files a report the moment an outcome changes the picture, and cannot change the
organization above or beside it. The validator's "Model known" rule covers leaders;
"Closing is clean" covers a leader session's demobilization. `incident tree` shows each
leader's model and last report. DESIGN.md Vocabulary (unit, task), the ICS mapping rows
for Division, Group and Unit and for the Operations Section, Step 3 (the preamble row),
Step 6 and Step 7 follow.

Acceptance: a dispatcher test on the stub that a unit with a grep, an investigate on the
leader's model and an interpret on another model runs the grep in-process, the investigate
as a resumed call on the leader's session, and the interpret in its own session, with
per-task events for all three and one `unit.reported` at the end; a test that a
`picture_changed` report stops the pass before the next unit; the preamble test pins the
seat paragraphs; the planner snapshot updated for leaders in section 4; the replay test
covers the new events.

### R3-5: Strike teams

Scope: `TaskProposal` and `Task` gain optional `strikeTeam`: `kind` (a name), `model`,
`tools` (built-in tool names), `prompt` (the member's system prompt), `count` (how many
the leader intends to send), and `why`. A leader may also request one in its `LeaderTurn`
(`requestStrikeTeam`), which the runtime treats as the same declaration on the task in
flight. The validator checks the model against the provider's list, the tools against
read-only (the effect policy: no `Edit`, `Write` or unallowlisted `Bash` until grants
exist), and the count against the task's budget, and nothing else. The runtime records
`strike_team.defined` and passes the kinds on the leader's next launch or resume with
`--agents <json>` (R3-0, honored on resume) and `Agent` in the session's tools. No preset
kinds exist and no kind is provided by default; the leader chooses the shape and says why,
so the record shows what leaders ask for. `incident review` reports per declared config:
members run, usage, cost, and how many claims cite a member. The preamble's strike-team
line says the leader must choose the kind, model, tools and count when it asks. DESIGN.md
Vocabulary (strike team, task force), the ICS mapping row for Strike Team and Task Force,
Step 4 (the task fields) and Step 5 follow.

Acceptance: validator tests for a team with a writing tool, an unknown model and a count
over budget; a renderer test that a declared team reaches `--agents`; a live test behind
`NOSCOPE_LIVE=1` where a Haiku leader sends two `pinger` members and the log holds
`strike_team.defined`, one `tool.called` for the `Agent` call and two `subagent.ran`
linked to it.

### R3-6: Lacks resolve at the leader

Scope: a leader's `LeaderTurn` may also carry `assignTasks` (task proposals under its own
unit, to capabilities it holds, inside its budget), which `applyPlan` applies under the
same validator rules as a plan's tasks, recorded as `plan.applied` with the leader as
actor; this is how a retrievable fact is resolved without a cycle boundary. A task's
`insufficient` with kind `retrievable_fact` goes to the leader's next call, not to the
planner. The other three kinds, and a leader's own, go up as `resourceRequests` on the
report: `permission`, `missing_means` or `human_knowledge`, each with what and why. A unit
whose report carries a resource request enters the new status `waiting` (`UnitStatus`,
migration adds nothing to rows); its tasks stay pending; dispatch skips it; the report is
`picture_changed`. The incident's `questions` and `capabilityRequests` now name the unit
that raised them; `incident answer` and `incident provide` return that unit to `active`
and return the incident to `open` only if the IC had set it `blocked`. The incident goes
`blocked` only when a plan says so (R3-7 gives the IC that call). `incident show` lists
waiting units with their requests. DESIGN.md Step 4's channel table and Step 7 follow.

Acceptance: a dispatcher test that a `retrievable_fact` insufficiency leads to a
leader-assigned grep and a resumed call, all in one pass; a test that a `human_knowledge`
request puts the unit in `waiting`, stops the pass with `picture_changed`, and that
`incident answer` returns it to `active`; validator tests that a leader cannot assign
under another unit or above its budget.

### R3-7: The IC above the planner

Scope: the IC, the root unit's leader built in R3-4, gets its own two schemas.
`src/planner.ts` keeps `renderPlannerInput` and `proposePlan`; the IC's briefing is
rendered from the same sections and opens with the change report: every `unit.reported`
since the IC last acted, every answer and provided capability, and the spend since then.
The cycle in `step` becomes: (1) the runtime renders the briefing; (2) the IC's session is
resumed with it under the `CommandTurn` schema: `periodObjectives` (the objectives for
this period, from the incident objective, the constraints, the priorities and the
reports), `priorities` (the incident's, restated or revised), `closeUnits`, `answers` to
resource requests it can answer itself, `questionsForHuman`, `capabilityRequests`,
`grantRequests`, `incidentStatus` (`continue`, `blocked`, `satisfied`, `failed`) and
`rationale`; (3) when the status is `continue`, the planner drafts as today, with the
period objectives and priorities rendered into section 1; (4) the IC's session is resumed
with the draft under the `ReviewTurn` schema: `verdict` `approve`, `correct` (with
`corrections`, text the planner redrafts against, once) or `amend` (with the plan as
amended); after a redraft the verdict is `approve` or `amend`; (5) the validator checks
the applied plan's shape as today; (6) apply; (7) dispatch runs units to their reports or
to a `picture_changed` report; (8) stop. `plan.applied` records the verdict, the
corrections and the diff between draft and applied plan; `incident review` reports
verdicts by kind per incident, which is the evidence for cutting the planner if the IC
never changes its draft. `incident create` takes `--priority` as it takes `--constraint`,
and the planner prompt says the rationale names the priority that chose between plans. The
IC role text: it scopes, breaks down, equips and judges; its digging is assigned; a period
ends when units report or the picture changes; it declares `satisfied` when the period
objectives and the incident objective are met by the reports; a unit's `not_met` report,
with its why and suggestion, is information for the IC's decision and never a decision. A
`discrepancy` the IC cannot reconcile from the file becomes a question for Mauria.
`situation` stays the planner's. `incident show` prints the current period's objectives.
DESIGN.md's ICS mapping rows for Incident Commander and Planning Section, the Planning P
row, Vocabulary (cycle, incident file), Step 4 and Step 7 follow; the cycle's definition
in DESIGN.md is rewritten to the eight steps above.

Acceptance: a run test on the stub where cycle 1's IC sets objectives, the planner drafts,
the IC corrects, the planner redrafts, the IC approves, the plan applies and a unit
reports; a test that a `picture_changed` report ends the pass and the next `step` opens
with it in the change report; a test that `amend` applies the amended plan and records the
diff; the models tests for both IC schemas; `review` shows verdict counts; the planner
snapshot shows period objectives in section 1.

### R3-8: Initial IC and transfer of command

Scope: `incident create` runs the size-up: a session on a cheap model (`claude-haiku-4-5`
by default, `--initial-model` to override) with the read-only tool set, given the
objective, constraints, priorities and the runtime's own findings (registered capabilities
and equipment, budget, whether the cwd is a git repository and its state, whether any URL
a constraint names answers), returning the `IncidentBriefing` schema: `kind` (what sort of
incident this is), `dominantProblem`, `obviouslyNeeded` (each with whether a tool checked
it), `initialObjectives`, `initialOrganization` (units sketched, one line each),
`questionsForHuman`, `hazards`, and `incomingCommander` (`provider`, `model`, `why`).
`--ic-model` at `create` overrides the model it names. The briefing is recorded as
`incident.briefed`; the IC's model is set from it; `command.transferred` records the
transfer from the initial IC's session to the IC's, with the briefing as its payload. The
IC's first briefing (R3-7 step 1) carries the incident briefing, and the IC role text's
first instruction is to evaluate it: say what it accepts, rewrites or discards and why,
before setting the first period's objectives; `incident review` reports how much of the
briefing the IC kept. Questions in the briefing block the incident before the IC starts.
DESIGN.md's ICS mapping (a new row for the initial IC and transfer of command), Step 7
(`create`'s flags) and the Model choices table follow.

Acceptance: a `create` test on the stub that records the briefing, sets the IC's model
from it and writes the transfer event; a test that a briefing question leaves the incident
`blocked` with the question recorded; a planner-style snapshot of the IC's first briefing
showing the incident briefing and the evaluation instruction; a live test behind
`NOSCOPE_LIVE=1` that sizes up a fixture repository and returns a `kind`.

### R3-9: IC handoff at the context threshold

Scope: the runtime reads each IC call's whole input context from its usage (the figure
`task.usage` already records) and, when it crosses `NOSCOPE_IC_HANDOFF_TOKENS` (default
120000; the IC runs with compaction disabled since R3-3), runs a handoff before the next
cycle: the outgoing IC's session is resumed once under the `HandoffDocument` schema, whose
instructions are tailored to the seat: the period objectives and priorities and why they
are what they are, every unit's state and what it waits on, the hypothesis and the claims
it rests on, what it set aside and why, and its next intended move. A fresh session is
then created for the root unit, briefed with that document and the full file, and
`command.transferred` records the handoff with the document as payload and the outgoing
and incoming session ids. The IC's first instruction on a handoff is the same evaluation
as R3-8's. `incident review` lists transfers with the context size that triggered each.
DESIGN.md Step 6 and the Reference row on compaction follow.

Acceptance: a run test on the stub where the stub reports a context above the threshold
and the next `step` shows a handoff call, a new session id on the root unit and the
transfer event; a test that below the threshold no handoff happens; the models test for
the document schema.

### R3-10: Third run

Scope: the first incident's objective run a third time from the same roughdraftplus
working directory at commit 6a996e8, with the scratch document restored before the run and
the priority "settling by observation over reading" given at `create`; `incident review
003` recorded beside 001 and 002 in `docs/first-incident.md` under a "Third run" section,
with the same measures plus: the initial IC's briefing and how much of it the IC kept, the
IC's verdicts by kind, units and their reports, strike teams declared and what they cost,
transfers of command, and lacks resolved at a leader against those sent up. A second
incident of another kind waits until this one is satisfactory.

Acceptance: run 003 reaches `satisfied` with the same code path named, and its write-up
answers whether the IC ever changed the planner's draft and whether any unit's
`picture_changed` report changed the period. Every design call the run forces goes on the
revisit list.

