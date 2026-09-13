# noscope v0 build plan

Derived from `DESIGN.md` at commit 4d5f68a and `docs/architecture.html`. Fifteen PRs, each
mergeable on its own, the CLI working after every one. Every PR targets `main`. The design
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
MCP equipment server and external MCP servers as equipment; the Codex provider; parallel
dispatch; the Situation Unit; cross-incident priorities; auto-whitelisting of grants.
The schema slots for grants, SOP applications and capability requests are created in PR 2
and PR 3 so none of these needs a migration.

## Open questions

| Question | Blocks |
|---|---|
| Whether PR 15's tuning of prompts should feed back into `DESIGN.md` as rulings or stay in `docs/first-incident.md` as findings. | Only how PR 15 is written up. Default: findings, with any ruling Mauria makes moved into the design. |
