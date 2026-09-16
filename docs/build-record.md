# Build record

One entry per PR, written on the PR's branch before it merges: what was built, why, and
whether it matches `BUILD-PLAN.md` and `DESIGN.md` exactly. Where it does not, the deviation
and its reason are here, and the design or plan was updated in the same PR. The date in a
heading is the merge date the entry was written for; the pull request is the record of
whether and when it merged.

## PR 1: Skeleton (#1, merged 2026-09-12)

Built: a pnpm TypeScript package for Node 24 with biome, vitest, knip and a CI workflow
running `pnpm check`; `bin/noscope.mjs` printing help and version; `src/cli.ts` with one
command table where every command in the design's Step 7 is registered and a command
without a handler is the exit-3 stub; README install section.

Not exactly to spec, with reasons:

- The launcher is `bin/noscope.mjs`, not `bin/noscope`, so biome lints it; an extensionless
  file is skipped.
- The CLI parses with Node's `util.parseArgs` and dispatches through a command table with an
  optional `handler`; the plan did not specify a mechanism. Chosen so `--help` works anywhere
  and later PRs land a command by filling one row.
- Two conventions the plan and design lacked were added to `DESIGN.md` in this PR because
  the code had to pick them: the exit-code table (0, 2, 3, 4, 5) in Step 7 and the SQLite
  path (`$NOSCOPE_DB`, else `~/.noscope/noscope.sqlite`) in Step 2.
- `tsconfig.typecheck.json` exists beside `tsconfig.json` so tests are typechecked without
  being built.
- The spike server under `spikes/` is excluded from lint and knip and kept byte-for-byte as
  it ran, since the design cites it as evidence.

## PR 2: Contracts (#2, merged 2026-09-12)

Built: `src/models.ts` with every schema the design names, `jsonSchemaFor()` for what
providers receive, `zod` 4 as the first runtime dependency, and tests.

Not exactly to spec, with reasons:

- `sessionResult(findings)` is a function returning one object schema with an `outcome`
  field and outcome-dependent rules, not a discriminated union. Two facts from a live check
  against Claude Code 2.1.270 forced this: `--json-schema` rejects a schema carrying a
  `$schema` key, and it forwards the schema as a tool input schema, which must be a
  top-level object, so a union is refused. `jsonSchemaFor()` therefore drops `$schema`
  and throws on a non-object schema. The design's Step 3 sketch now reads
  `sessionResult(InvestigateFindings)`.
- `Claim` gained `evidence: string[]`, because a session's claim proposals carry evidence
  pointers and the stored claim had nowhere to keep them.
- `Grant` ties `incidentId` to `scope`: null exactly when standing.
- `Timestamp` accepts an offset on read; the store writes `toISOString()`.
- `UnitProposal` carries a `ref` so a plan's new tasks can name a unit created in the same
  plan; the design did not say how that reference works.
- `Usage` (tokens and seconds) is a schema so `task.usage` events have a shape.

## PR 3: Store (#3, merged 2026-09-12)

Built: `src/store.ts` on `better-sqlite3` with the six tables, every write a named method
that performs its state change and records its event in one immediate transaction,
`replay()` that rebuilds the tables from the events, contract-parsed reads, and tests
including the replay test of acceptance criterion 7.

Not exactly to spec, with reasons:

- Not a general `transact(fn)`: writes are named methods, and each event's payload carries
  a `mutation` that says exactly what changed. A free-form transaction cannot be replayed
  because the event would not know what the function did. Replay applies the recorded
  mutation and nothing else; the review found that dispatching on event type applied a
  status live and dropped it on replay, and that a missing payload key became the string
  "undefined". The mutation is validated by a zod schema, so replay throws on either.
- Events carry a `scope`, `incident` or `system`, with a CHECK tying it to `incident_id`,
  at Mauria's call: a bare nullable column could not tell an intended system event from a
  bug that forgot its incident. A standing grant's `grant.given` is a system event.
- `UNIQUE (incident_id, sequence)` does not constrain NULLs in SQLite, so the uniqueness is
  an index on `COALESCE(incident_id, '')` and `sequence`.
- Transactions are `immediate`, and `busy_timeout` is 5 s, so a second process writing to
  the same file waits instead of failing on a snapshot conflict.
- Reads go through the contracts (`Incident.parse` and the rest), so a corrupt row or a
  hand-edited payload is caught on the way out, not silently returned.
- `claims` has `evidence_json`, missing from the design's table until now; a claim whose
  object is absent is stored as null rather than failing the NOT NULL constraint.
- `snapshot()` and `resolveDbPath()` were added; `record()` exists for events with no
  state change.


## PR 4: Incident commands (#4, merged 2026-09-13)

Built: `noscope incident create`, `show` and `events` over the store; handlers in
`src/commands/incident.ts` that parse their own flags strictly; `src/context.ts` holding the
shared types and the exit-code table; the incident file rendered with every section the
design lists; tests for acceptance criterion 1 and the exit codes.

Not exactly to spec, with reasons:

- `--budget` is `--budget-tokens N` and `--budget-seconds N`, since a budget has two
  dimensions in the contract.
- Handlers receive the raw arguments after the command words and parse them themselves,
  so `--constraint` repeats and an unknown flag exits 2; the top-level dispatcher knows only
  help and version.
- Incident ids are zero-padded ordinals, `001`, and the root unit is `001-command`.
- "Capabilities registered" prints "(none yet)" until PR 6 lands the registry.
- The store was hardened in this PR from the PR 3 review's final report, which arrived after
  PR 3 merged: updates verify they changed exactly one row, so an event is never recorded for
  a change that did not happen; writes validate their mutation before applying it, so a bad
  status cannot reach a table and poison every later read; `replay()` sorts events itself
  (system first, then per incident by sequence); the file carries a schema version and a
  file from another version is refused with a message rather than failing on the first
  write; `incident.questions` and `incident.capabilityRequests` mutations exist so PR 13 can
  store answers in the table; `batch()` runs several writes as one transaction for PR 11;
  the inserts name their columns; and the two task UPDATEs became one. A claim with no
  object stores null.
- The README's pun line now ends "not even to one-shot", at Mauria's ask.

## PR 5: Equipment (#5, merged 2026-09-13)

Built: `src/equipment/registry.ts` with `defineEquipment` and `runEquipment`, which validates
inputs and outputs against each item's schemas; `read_file`, `list_directory`, `grep_files`,
`git_status`, `git_log`, `git_diff`, `run_readonly` under the read-only allowlist; `builtin.ts`
naming the provider built-in tools and rendering the `Bash(cmd *)` allowlist; tests on a
fixture directory and a fixture git repository built in a temp directory at test time.

Not exactly to spec, with reasons:

- `runEquipment` validates both directions, so a capability cannot pass malformed inputs
  and an item cannot return something off its contract; the plan only named the fields.
- `grep_files` skips `node_modules` and `.git` and caps matches; `read_file` and `git_diff`
  cap bytes, all reported as `truncated`, so a session's task is never flooded.
- `run_readonly` returns the exit code and both streams instead of throwing on a non-zero
  exit; a failed command is itself a reportable fact.
- `src/equipment/index.ts` is the package surface and a knip entry, as `src/models.ts` is.

## PR 6: Deterministic capabilities (#6, merged 2026-09-13)

Built: `src/capabilities/registry.ts` with `defineCapability`, `runDeterministic` and the
`Capability` type; `deterministic.ts` with `check_path`, `read`, `grep`, `git_history`
composing equipment in-process; `src/verifier.ts` recording a deterministic run's claims as
verified with the capability and effective inputs as provenance; `incident show` lists the
registry. The PR 5 review's findings on the merged equipment were fixed here too.

Not exactly to spec, with reasons:

- `Capability` is a discriminated union on `kind` (`deterministic` with `run`, `session`
  with `session`) and `produces` is derived from it, not declared: exactly-one is then a
  compile-time property and the two cannot disagree. The plan listed `produces` as a
  `defineCapability` argument.
- Each capability declares its path input fields (`paths`); `runDeterministic` resolves
  them against the incident's cwd before the run and returns the effective inputs, which
  the verifier stores as provenance. Every claim subject is an absolute path. Written into
  DESIGN.md Step 6.
- `check_path` uses a new `stat_path` equipment (one `lstat` and `stat`, symlinks followed,
  only ENOENT and ENOTDIR read as missing) instead of listing the parent, which mis-answered
  symlinks, case-insensitive names, `/` and any unreadable parent, and stat-ed every sibling.
  The DESIGN.md capability table row changed with it, and the `git_history` row now names
  the equipment it actually uses (`git_status`, `git_log`); it also claims working-tree
  changes, which its description promised.
- Capability input and output schemas are the equipment's own, so defaults are one fact;
  `grep`'s absence claim carries the bounds it ran under (glob, ignoreCase, exclude).
- The store refuses a claim created `rejected`, or `verified` without deterministic
  provenance, and its next-sequence query matches the events index (it scanned the table).
  `incident show` clips a claim's object to 160 characters.
- `runEquipment` accepts the equipment handle and is typed end to end, so capabilities carry
  no hand-written casts; the by-name form stays for the MCP equipment server.
- `src/verifier.ts` is not a knip entry after all: the tests import it, and an entry would
  hide a dead export.
- Fixes to PR 5's equipment, from its review: `run_readonly` refuses the `find` primaries
  that write (`-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`, `-fprint0`,
  `-fprintf`, `-fls`) and reports a timeout or output overflow as `failure` with a null
  exit code rather than exit 1; `git_diff` and `git_log` refuse option-shaped revisions and
  paths and pass `--end-of-options`; `git_status` parses an unborn branch, a detached HEAD,
  renames (`from`) and quoted paths through `-z`; `git_diff` caps by bytes and returns
  `truncated` instead of throwing past 8 MB; every git call has a 60 s timeout; `read_file`
  reads only up to its cap and never ends a cut mid-character; `grep_files` declares its
  skipped directories as an `exclude` input, handles CRLF and trailing newlines, matches
  separator and brace globs through Node's `matchesGlob`, and stops walking once truncated.
  `BUILTIN_TOOLS` is the design's four (`Read`, `Grep`, `Glob`, `Bash`); the writing tools
  arrive with the effect levels that govern them. The command allowlist lives in
  `builtin.ts`, so importing the allowlist no longer registers equipment as a side effect.
- Set aside, for Mauria: `read` puts the whole file text (up to 200 KB) in its claim object
  and `grep` emits one claim per match (up to 500), which the store holds twice (claim and
  event) and every later planner cycle would carry; the fix is a design call about what a
  claim carries (a hash and size, with the text in the task result), so it waits.

## PR 7: Claude Code provider (#7, merged 2026-09-13)

Built: `src/providers/base.ts` with the provider interface (a `SessionRequest` in, a
`SessionOutcome` of structured output, session id and usage out) and `SESSION_PREAMBLE`,
the fixed first part of every session's system prompt; `src/providers/claude-code.ts`
rendering a request onto `claude -p` with `--model`, `--system-prompt`, `--tools`,
`--json-schema`, `--allowedTools`, `--add-dir` and the five isolation flags, running it, and
parsing `structured_output`, `session_id` and the usage fields; `test/stub-claude`, a
stand-in binary that records its arguments and stdin and prints the result envelope; one
live smoke test behind `NOSCOPE_LIVE=1`, run once on 2026-09-13 against Haiku and green.

Not exactly to spec, with reasons:

- The prompt goes to `claude` on stdin, not as the `-p` argument, so a long task brief never
  meets the argv limit; the stub records it from stdin the same way.
- `--allowedTools` is rendered only when the request carries a Bash allowlist, and
  `--add-dir` once per directory; the exact list is pinned by a test.
- Usage `inputTokens` is the whole context (`input_tokens` plus the cache creation and
  cache read counts), since that is what the design's context measurements count; `seconds`
  is `duration_ms`.
- A session that returns `is_error`, a non-success subtype, no session id or no structured
  output is an error the caller sees, never an outcome; PR 8 decides what the task does
  with it.
- The provider's `run` takes the binary path so tests use the stub; the real name is the
  default.
- A session that outlives its timeout gets SIGTERM and, five seconds later, SIGKILL, so a
  child that ignores the first cannot hold the runtime forever (from Mauria's review,
  2026-09-13).

## PR 8: Session capabilities (#8, merged 2026-09-13)

Built: `src/capabilities/investigate.ts` with `investigate` (equipment `Read`, `Grep`,
`Glob`, `Bash` under the read-only allowlist) and `interpret` (no equipment), each with its
role text and a `sessionResult` output schema carrying `outcome`; `src/capabilities/session.ts`
rendering the task brief as the user message with the owning unit's purpose line, building
the provider request from the task's model, and running it through a provider;
`src/providers/index.ts` looking a provider up by the name a task carries; the verifier's
`recordSessionResult`, which records asserted claims with the session id as provenance or,
on `insufficient`, no claims and one `task.insufficient` event carrying `needed`;
`test/fixtures/models.ts`, a shared incident, unit and task fixture for tests.

Not exactly to spec, with reasons:

- The Bash allowlist lives inside the capability's `session` field rather than beside it, as
  the registry already defined `SessionSpec` in PR 6; the design's sketch now shows that.
- A session's timeout is the task's `budget.seconds`, or ten minutes when the task sets
  none; the dispatcher (PR 12) enforces the same bound.
- `runSession` parses the provider's output through the capability's own schema, so an
  `answered` result without findings, or an `insufficient` one naming nothing, is an error
  before the verifier sees it.
- The Claude Code provider now names a missing session cwd rather than surfacing a bare
  ENOENT, which reads as a missing binary.
- Task status changes on a session's result belong to the dispatcher (PR 12); this PR
  records the claims and the event only.

## PR 9: Planner (#9, merged 2026-09-13)

Built: `src/planner.ts` with `renderPlannerInput`, the incident file as the nine labeled
sections in the design's order (command picture; verified claims; asserted claims with
provenance; unit tree; tasks completed since the last cycle summarized against their
contracts with claim pointers; tasks that came back insufficient with what they needed; open
tasks; capabilities with cost facts and every provider's models; the validator's rules with
last cycle's rejection), `PLANNER_SYSTEM_PROMPT`, and `proposePlan`, which calls the provider
with the `ActionPlan` JSON schema, no tools, and records `plan.proposed` with the plan, its
rationale, the session id and usage; a snapshot test of the rendered input for a fixture
incident one cycle in, and a stub-provider test that `plan.proposed` carries the fixed plan.

Not exactly to spec, with reasons:

- "Since the last cycle" is everything after the most recent `plan.applied` event, so the
  first cycle sees everything, each later cycle sees only what its predecessor caused, and a
  retry after a rejected plan sees the same results the rejected plan saw (the review found
  that cutting at `plan.proposed` lost a session's `insufficient` report on retry).
- Task lines in sections 5 and 7 carry the task's inputs, since the duplicate and
  inputs-validate rules the planner is shown key on them.
- `sumUsage` in the store is the one fold over `task.usage` events; the planner and
  `incident show` both read it, so the two views of spend cannot disagree.
- The planner's system prompt replaces the task-session preamble rather than following it:
  the preamble tells a session it is a resource assigned to one task, which the Planning
  Section is not. `SessionRequest` therefore carries the whole `systemPrompt`; the session
  builder composes preamble plus role for task sessions, and the provider renders what it is
  given. The design's session-fields row says so now.
- A provider now lists every model it serves (`Provider.models`), which is section 8 and
  the validator's Model known rule in PR 10; Claude Code's list is the design's nine.
- Per-model cost facts do not exist yet, so section 8 carries each capability's cost facts
  and each provider's model names; a per-model cost table is a later addition.
- The validator rules are stated in `planner.ts` as `PLANNER_RULES`, the text the planner
  reads; PR 10 implements each and imports the list so the two cannot drift.
- An action plan that fails the `ActionPlan` contract is an error and writes no event, so a
  malformed plan never enters the log as proposed.
- Store hardening from Mauria's review of 2026-09-13, in this PR because it is the next to
  merge: every mutation applies under the event's incident, so a created row must belong to
  it and an updated unit, task or claim is matched by id and incident, and a mistaken
  caller can no longer log an event under one incident for a change to another; `incident
  create` writes the incident and its command unit in one transaction. The build record's
  header now says a heading's date is the merge date the entry was written for, since more
  than one PR can be in flight.

## PR 10: Validator (#10, merged 2026-09-13)

Built: `src/validator.ts` with every Step 5 rule as a named check over the plan and the
incident's state (units, tasks, claims, providers, usage), keyed by the rule names the
planner reads; `validatePlan`, which passes the whole plan or rejects it with every failing
rule and its reason; `validationContext`, the state read from the store; `validateAndRecord`,
which writes one `plan.rejected` event per failing rule with `rule` and `reason`, the fields
the planner's section 9 already reads. One test per rule with a plan that fails only that
rule, a passing plan returned unchanged, the widenings below each pinned by reason text,
and the event payloads pinned. The review (three subagents, 2026-09-13) found three bad
plans that passed and two valid plans rejected; all are fixed here and the design's Step 5
table now states each check as applied.

Not exactly to spec, with reasons:

- The rule names are derived from `PLANNER_RULES` (the text before each colon), the checks
  are a record keyed by those names, and the rule list is built from the planner's list in
  its order, so the rules the planner reads and the rules applied cannot drift, at compile
  time.
- A rejected plan writes one event per failing rule rather than one for the first, so the
  planner's next input shows everything wrong with the proposal in one cycle.
- Units exist requires an active unit: a closed unit takes no new task or unit, in this
  plan or a later one; before the review a closed unit accepted new work. It also refuses
  a `closeUnits` entry naming a unit not in the incident.
- No cycles refuses a ref that collides with an existing unit id or is used twice, since
  either makes the tree ambiguous before any cycle could form; a unit that is its own
  parent is a one-node cycle and is rejected here, once.
- No duplicates keys on the inputs as the capability's schema parses them, so a spelled-out
  default is the same task; it compares new tasks against each other; and a task the plan
  cancels does not count, so cancel-and-reissue with the same inputs passes in one cycle.
- Budget respected: a task's budget must fit only where it sets one; a session-backed task
  needs a time bound and, when the incident bounds tokens, a token bound; a deterministic
  task runs no model and needs neither. Before the review every task had to name a token
  budget on a token-bounded incident, which would have rejected every grep.
- Dependencies resolve: a dependency must be completed or still open and not cancelled in
  this plan, so the new task can become ready (a dependency on a failed or cancelled task
  would leave it pending forever); `cancelTasks` must name an open task, once; and
  `claimsToVerify` must name an asserted claim. No other rule owns those references.
- Closing is clean also refuses a unit that is already closed, a unit closed twice in one
  plan, and new tasks or units placed under a unit closed in the same plan.
- Status is earned also refuses `satisfied` while the plan creates tasks.
- Span of control counts active child units and open tasks after the plan's closes and
  cancels, and the limit is `SPAN_OF_CONTROL` (7).
- Model known's reasons name exactly what is missing or misplaced (a provider, a model, or
  both), since the planner reads them.
- Left as design questions for Mauria's revisit after the first incident: closing a unit
  whose child unit still runs a task passes (the rule speaks of the unit's own tasks), and
  two tasks in one plan that each fit the remaining budget but together exceed it pass (the
  rule speaks of a task's budget).
## PR 11: Apply and tree (#11, merged 2026-09-13)

Built: `src/runtime.ts` with `applyPlan`, which applies a validated action plan in one
transaction (units created and closed, tasks created and cancelled, questions and
capability and grant requests recorded, the incident's status set, then `plan.applied`
carrying the ids it made and `claimsToVerify`); `src/tree.ts` rendering the unit tree with
each unit's status and purpose and each task's mark; `noscope incident tree`. Tests cover
the design's acceptance criteria 2, 4 and 5 through the validator and the applier: a plan
creating a unit and a task applies with ready and pending marks; a later plan closes the
unit and `tree` and `events` show it; an eight-child plan is rejected and a regrouped plan
passes; the three blocking channels block the incident, and `satisfied` closes it.

Not exactly to spec, with reasons:

- Ids are positional and readable: units `<incident>-u02` onward (the command unit is
  `<incident>-command`), tasks `<incident>-t01` onward, questions `<incident>-q01` onward,
  so the planner and Mauria can refer to them in a plan or a command without copying UUIDs.
- A new task is `ready` when every dependency is already completed and `pending` otherwise;
  the dispatcher (PR 12) promotes pending tasks as their dependencies finish.
- A new event type, `incident.blocked`, records the status change when a plan asks a
  question, requests a capability or requests a grant; the design's event list has it.
  `satisfied` and `failed` write `incident.closed`, as before.
- The tree also marks `failed` and `cancelled` tasks by those words, beside the design's
  done, running, ready and pending, so a task that ended without finishing is visible.
- `claimsToVerify` is recorded on `plan.applied` and not acted on here; scheduling the
  deterministic check and recording the promotion is the dispatcher's, with the
  claim-verification record Mauria asked for on 2026-09-13 (open item on the thread).
- `applyPlan` trusts the verdict it is handed and does not re-run the validator; the caller
  (`incident step`, PR 12) validates first, as the tests here do.
- From the review (2026-09-13): new units are written parents-first, so a parent named by
  a ref defined later in the same list applies (it failed the foreign key before);
  `applyPlan` reads the incident from the store and refuses one that is not open, so a
  stale caller cannot drop an earlier question or mislabel a status change; the validator
  refuses a bare `blocked` with no question, capability request or grant request (nothing
  could unblock it), a `satisfied` or `failed` plan that raises one (nobody could answer
  it), and a ref that starts with the incident id (it could shadow the id a new unit
  receives); `incident show`, `events` and `tree` exit 2, not 4, when no id is given.

## PR 12: Dispatch and step (#12, merged 2026-09-13)

Built: `src/dispatcher.ts` with `dispatch`, which runs every ready task one after another
under its time bound, promoting a pending task whose dependencies are complete with
`task.ready`, writing `task.started`, then the claims, the result with `task.completed` and
`task.usage` in one transaction, or `task.failed` with the reason and the usage the run
still spent, and stopping with `budget.exceeded` when the incident's budget has no room for
the next task; claim promotion in the verifier, so a deterministic result that matches an
asserted claim on subject, predicate and object promotes it with a `claim.verified` event
recording the task, its effective inputs and the matching claim; `noscope incident step`,
wiring observe and plan, validate, apply, dispatch, verify and record, printing the proposed
plan, the verdict, what changed, what ran and any budget stop; `getProvider` reads
`NOSCOPE_CLAUDE_BIN` so tests run the whole cycle on the stub. Tests: criterion 3 (tasks
run and their claims appear verified or asserted), a task over its time bound fails with
`task.failed`, a task whose dependency completes in the same pass runs in that pass with a
`task.ready` event, the budget stop, a failed session keeping its usage, promotion of a
matching asserted claim, and one full `step` on the stub planner through to claims, a
rejected plan, a `satisfied` plan, and exit 5 on a closed incident.

Not exactly to spec, with reasons:

- A deterministic run with no `budget.seconds` is unbounded, as the design's Budget row
  says unlimited is the v0 default; a session always runs under a bound, the task's own
  (the validator requires one) or ten minutes for a direct caller, since a hung process
  must end. The provider kills the session's process group at the same bound. A
  deterministic run that does carry a bound and passes it is abandoned, not killed: it keeps
  executing while the next task starts, writes nothing to the store, and holds the process
  open until it finishes. Only read-only capabilities exist in v0, so the overlap has no
  effect on the record; a writing capability will need a cancellable run.
- A task still `running` when a pass starts was left by a pass that died mid-run (v0 runs
  one task at a time in one process), so the pass fails it with that reason rather than
  skipping it forever, and the planner can reissue it.
- A result that does not fit its schema fails the task with the issues in one sentence;
  a bound longer than the timer can hold (about 24 days) is treated as no bound.
- Set aside for Mauria: the planner's own tokens are recorded on `plan.proposed` and do
  not count against the incident's budget, since the design's Budget row speaks of tasks;
  whether an incident budget should include planning spend is a design call.
- The budget check before a task uses the task's own bound where it sets one, which the
  validator has already fitted to the incident's remaining budget, and the capability's
  typical cost otherwise; before the review it always used the typical cost, so a session
  task the validator had just approved could be refused on the same step.
- A budget stop ends the pass and is returned to the caller: `step` prints it, and the
  planner's section 1 shows the last stop's reason, so the next plan can respond.
- A session that fails after spending (an error envelope, or output that does not fit the
  capability's schema) throws a `SessionError` carrying its session id and usage, and the
  dispatcher records that usage on `task.failed`, so failed sessions still count against a
  token budget.
- Promotion of asserted claims lives in `recordClaims`, so any deterministic result
  promotes what it matches, whether or not the planner asked through `claimsToVerify`;
  the design's Step 6 now describes the event's record, which is the claim-verification
  record Mauria asked for on 2026-09-13.
- `step` exits 0 when the plan is rejected: the cycle ran and its outcome is recorded.
  Exit 5 is for an incident that is not open. A planner that cannot run at all (no binary,
  a non-zero exit, no JSON) exits 1 with the reason on stderr and nothing written for the
  cycle; the design's exit-code table has the row.
- `step` prints the proposed plan's units, tasks, questions and requests before the
  verdict, so a rejected plan can be read without opening the event log.
- `NOSCOPE_CLAUDE_BIN` names the binary every provider call runs on, the planner's and
  each task session's; the README and the design's Step 2 say so beside `NOSCOPE_DB`.
## PR 13: Blocking channels (#13, merged 2026-09-13)

Built: `noscope incident answer <id> "<text>"`, which answers the planner's oldest open
question, stores the answer on the question where the planner's next input reads it, writes
`question.answered`, and returns the incident to `open` once no question waits; the stub
binary now serves a scripted plan to a planner call (recognised by its system prompt) and
a session output to a task, with `NOSCOPE_STUB_PLANS` walked in order across cycles, so a
test can run several steps. Tests: criterion 8 (an `interpret` task answering
`insufficient` leads the next step's planner input to carry what was needed and the
scripted plan to supply it), and a plan with two questions blocks the incident, `show`
prints them, `step` refuses with exit 5, and two answers reopen it with the answers in the
next planner input.

Not exactly to spec, with reasons:

- Blocking itself landed in PR 11 (`applyPlan` sets `blocked` and writes `question.asked`,
  `capability.requested` and `grant.requested`), since applying a plan is where the status
  is decided; this PR adds the way back.
- `answer` answers one question per call, the oldest without an answer, so each answer is
  its own event and the planner sees which question it belongs to; several questions take
  several calls, and the command says how many still wait.
- An incident blocked only by a capability or grant request has no v0 way back: `answer`
  exits 5 and says so. Registering the capability, or `incident grant`, is after v0.
- The provider runs a session under the environment the command was given, merged over
  the process's own, so a test's stub variables reach the stub through the CLI and the
  real binary keeps its PATH.
- From the review (2026-09-13): a grant request holds the block after every question is
  answered, since the request lives only in the log (`grant.requested` beyond
  `grant.given`) and not on the incident; the planner's section 1 lists waiting grant
  requests beside grants; `answer` exits 5 on a `satisfied` or `failed` incident, which
  takes no answer. A reopening answer writes two `question.answered` events, one for the
  answer and one for the status, since v0 has no reopen event type.

## PR 14: Run to completion (#14, merged 2026-09-13)

Built: `noscope incident run <id> [--max-cycles N]`, repeating the cycle until the incident
leaves `open` or the cap is hit, re-reading the incident each cycle and saying why it
stopped; `step` and `run` share one `cycle` function, so a step and a run's cycle print the
same lines. Tests: criterion 6 on scripted plans (a grep, then `satisfied`; the incident
ends satisfied with the verified claim naming the code path and `incident.closed` carrying
the planner's rationale), the cap stopping a runaway loop of plans the validator rejects,
and `failed` recorded with the rationale.

Not exactly to spec, with reasons:

- The cap defaults to 10 cycles when `--max-cycles` is not given, since `run` exists to
  demonstrate the milestone end to end and an unbounded loop on a real planner would spend
  without a check; the design names no default.
- `run` on an incident that is not open exits 5, as `step` does, and a cycle that blocks or
  closes the incident ends the run before the cap.
- From the review (2026-09-13): a budget stop ends the run, since another cycle could only
  plan and never run (before, `run` called the planner every cycle to the cap with tasks
  sitting ready); a cycle whose provider cannot run ends the run with exit 1 and the reason
  on stderr, as `step` does, with the store consistent; `--max-cycles` accepts only a
  positive whole number written as digits.

## PR 15: First incident (#15, merged 2026-09-13)

Built: the live run of the first incident against the real Claude Code provider, nine
steps from the roughdraftplus working directory, recorded in `docs/first-incident.md` with
the answer, the run cycle by cycle, the totals, the acceptance criteria checked one by one,
and event-log excerpts; two tuning changes to the planner input that the run demanded.

Not exactly to spec, with reasons:

- The planner input's section 8 shows each capability's input fields (name, type, required
  or default, nested shapes in full) rendered from its schema, where the design said names
  and descriptions only: the first live plan named inputs the capabilities could not take
  and was rejected, and the fifth omitted the fields of an object array. DESIGN.md Step 4
  says so now.
- Claims get positional ids (`001-c381`) instead of UUIDs, since the planner mistyped a
  UUID in `claimsToVerify` and lost a cycle.
- The run's first nine cycles ended `blocked` on a question for Mauria: the planner
  declared the evidence complete and asked the one thing the repository cannot prove. Her
  answer contradicted the planner's inferred link; the next three cycles said so, found a
  stronger explanation (the selection rests at the document end after a mount-time
  `setContent`), verified its code facts deterministically, and closed the incident
  `satisfied` on cycle 12, meeting criterion 6. Criteria 5 and 8 were not observed live
  (the planner stayed within span of control unprompted and the `interpret` tasks had enough
  evidence) and rest on the stub tests, as the document says.
- The preamble and role prompts were not changed; the plan expected tuning there, and the
  run needed none.
- Observations for the revisit, in the document: promotion by exact triple never fired, and
  grep's per-match claims took the planner's input from 7k tokens to 91k in one cycle and 111k by cycle 9.


## PR 17: Usage split and cost (#17, merged 2026-09-13)

Built: every `task.usage` and `plan.proposed` event now carries the input context split
into uncached, cache-write and cache-read tokens, and the provider's own cost at list price
(`total_cost_usd` from the Claude Code envelope) when it reports one. `Usage` in
`src/models.ts` has the four new fields, `parseClaudeCodeResult` fills them, `sumUsage`
folds them, and `incident show` prints the cost beside the spend when one is known.
DESIGN.md Step 6 and the architecture page say what a usage carries. Second of the three
pieces from the first incident's audit, and the first built, since `incident review` reads
what this records; the audit could only bound the run's cost between $7 and $22 because
the provider's three input counts were collapsed into one.

Not exactly to spec, with reasons:

- `inputTokens` keeps its meaning as the whole context, so budgets and the planner's
  remaining-budget line are unchanged; the split sits beside it rather than replacing it.
- `costUsd` is optional on a usage and on a summed spend: a run that fails before the
  provider answers, or an event recorded before this change (all of incident 001), has no
  cost figure, and summing zeros for those would report a run as cheaper than it was, so
  the sum carries a cost only when every `task.usage` event does (from the review). A
  deterministic run records `costUsd: 0`, which is a fact, even when it is abandoned past
  its time bound; only a session that fails before the provider answers records none.
- The cost `incident show` prints is labeled task cost: like the spend it sits beside, it
  excludes the planner's calls, which are recorded on `plan.proposed` and not counted
  against the budget (the design call on the revisit list). The incident's whole cost is
  `incident review`'s.
- The three split fields are required and zero on a deterministic run; a usage recorded
  before this change is read with the parts as zero, since `sumUsage` reads events rather
  than parsing them.
- The stub binary now reports `total_cost_usd: 0.0123`, so the provider test pins the
  whole shape; a second parse pins the no-cost case.

## PR 18: Keep session transcripts (#18, merged 2026-09-13)

Built: `--no-session-persistence` is no longer among the Claude Code provider's fixed
flags, so every planner and task session leaves its transcript under Claude Code's project
directory for the session's working directory, keyed by the session id the event log
already records. Mauria's decision on 2026-09-13, when the first incident's audit wanted
the planner's transcripts and found none: while the runtime is being refined, the
transcripts are the material.

Not exactly to spec, with reasons:

- DESIGN.md Step 3 listed five fixed flags and its Reference table measured context with
  all five; the flag stops only the transcript write and changes no context measurement,
  so the measurements stand and the rows say which flag was dropped since.
- Transcripts land under `~/.claude/projects/<directory with slashes as dashes>/`, which
  for an incident run from a repository is that repository's own Claude Code project
  directory, beside Mauria's interactive sessions there; they are told apart by the
  session id on `plan.proposed`, `task.completed`, `task.failed`, `task.insufficient` and
  claim provenance.
- From the review: `task.completed` did not carry the session id before this PR, so a
  session that completed with no claims left no way to its transcript; the dispatcher now
  writes it there, which is the one behavior change beyond the flag.

## PR 19: Incident review (#19, merged 2026-09-13)

Built: `noscope incident review <id>`, the After Action Review computed from the event log
by `renderReview` in `src/review.ts`: each cycle with its verdict (applied with the unit,
task and claimsToVerify counts, or rejected with every rule line), the planner's model,
session id and usage, every task run with its capability, model, session id, tokens (with
the cache split when recorded), seconds, cost, outcome and the claims it entered, tasks
that failed before running, budget stops, questions and answers; totals by role and model;
plan, task and claim counts with promotions; the cost. `plan.proposed` now records the
planner's model. The session ids are the keys to the transcripts PR 18 keeps. Second of the
three pieces from the first incident's audit; on incident 001 it reproduces the audit's
table exactly (planner 12 calls, 1.09M in, 74k out, 930 s; investigate on Opus 3 calls,
2.24M in, 86k out, 956 s; Sonnet 2 calls; interpret 2 calls; 22 deterministic runs),
replacing the scratch script that computed it.

Not exactly to spec, with reasons:

- Cost is the provider's recorded figure where every usage carries one, and otherwise an
  estimate at list rates (the claude-api skill's table cached 2026-06-24, kept in
  `src/review.ts` with that date). A usage recorded before PR 17 has no cache split, so its
  input is bounded between all cache reads (0.1x) and all cache writes (2x: Claude Code
  writes the one-hour cache, seen as `cache_creation.ephemeral_1h_input_tokens` in its
  envelope on 2026-09-13); the report says which case applies. A model with no known rate
  is counted as unpriced rather than guessed. Fable 5.1's cheaper cache reads (0.025x) are
  not modeled; no incident has run on it. Incident 001 comes out at $6.37 to $40.15 against the
  audit's $7 to $22, which used 1x as the upper factor.
- The planner's model is taken from `plan.proposed` and, for events recorded before this
  PR, assumed to be the default `claude-opus-5`, with the assumption stated in the cost
  line.
- A rejection reason is clipped at 240 characters with the remainder's length and a pointer
  to `incident events`, since one live reason ran to 3,000 characters.
- The computation lives in `src/review.ts` rather than under `src/commands/`, so the
  handler in `src/commands/incident.ts` stays a few lines and the report is tested on
  synthetic events without a store.
- From the review: a task that fails before it runs (interrupted by an earlier pass, or
  its capability missing) writes `task.failed` and no `task.usage`, so those are listed
  from `task.failed` with their reason; a task with a usage but no outcome event, which
  the dispatcher never writes, prints "no outcome recorded" rather than "completed". That
  default had hidden a lookup bug: an outcome event names its task inside its recorded
  mutation, not at the top of its payload, so no outcome was ever matched and every run
  printed "completed"; the review now reads the id from either place.

## PR 20: Claim basis and the confidence scale (#20, merged 2026-09-13)

R2-1 of the round 2 plan. Built: every claim carries `basis`, `observed` or `inferred`.
Deterministic claims enter observed; a session's claim must name its basis or its result
does not fit the schema. The session preamble defines the confidence scale beside the
term: observed, 0.9 to 1; inferred from code, at most 0.7; runtime behavior not reproduced,
at most 0.5. The planner sees the basis on each asserted claim; `incident review` counts
inferred claims per task. DESIGN.md Vocabulary, Step 2 and Step 6 and the architecture
page follow.

Not exactly to spec, with reasons:

- The store gained its first migration: a version 1 file (every file before this PR,
  incident 001 included) is migrated in place when opened, verified claims becoming
  observed and every other claim inferred, since a session claim with no recorded basis is
  read the conservative way. The design had said a file at another version is refused;
  refusing would have made the first incident unreadable by the build that reviews it.
- Replaying events recorded before this PR fills the basis the same way, so the replay
  test and the review command keep working on the old log.
- `ClaimProposal` keeps `basis` optional because the deterministic capabilities build
  proposals too and are observed by construction; the session result schema uses
  `SessionClaimProposal`, where it is required.
- From the review: the migration runs as one transaction and adds the column only if it
  is missing, so a file left half-migrated by a crash finishes on the next open. The
  preamble test pins the three scale lines. `incident review` reads claims from the log's
  events, not the table, so on an incident recorded before this PR it shows no inferred
  counts even after the file is migrated; the counts start with the next incident.

## PR 21: Task refs (#21, merged 2026-09-13)

R2-4 of the round 2 plan. Built: a task in a plan may carry a `ref`, and another task in
the same plan may name it in `dependsOn`, so a chain of tasks runs in one cycle. The
validator holds a task ref to the unit ref's three tests against task ids and refuses a
cycle among new tasks ("No cycles"), and accepts a ref as a dependency ("Dependencies
resolve"). `applyPlan` assigns ids in plan order and rewrites refs to ids before creating
tasks; the dependent enters pending and the dispatcher, unchanged, runs it in the same pass
once its dependency completes. The planner prompt and rules say so. DESIGN.md Step 4
(the plan sketch) and Step 5 (the two rules) follow.

Not exactly to spec, with reasons:

- A task ref and a unit ref live in separate namespaces (a task ref is only ever named in
  `dependsOn`, a unit ref in `unit` and `parent`), so the same label on a unit and a task
  is allowed; the plan did not say either way.

## PR 22: The situation carried in the plan (#22, merged 2026-09-13)

R2-2 of the round 2 plan. Built: `ActionPlan` gains `situation`: what changed, the
hypothesis, the verified claims it rests on (id and one line each), every inferred link with
what settles it (a task by ref or id, a question in this plan by position, or a reproduce
task), and the claim ids to keep in view. `rationale` stays as "why this plan". The planner
input gains section 10, the last applied plan's situation as the planner wrote it, or
"(none)" before one; it comes last because the provider caches the unchanged front of a
prompt. Two validator rules: "Inferred links are worked" and, under "Dependencies
resolve", every claim id the situation names exists. `plan.proposed` and `plan.applied`
carry the situation; `incident show` prints the last one under decisions. DESIGN.md Step
4 (sections and sketch), Step 5 (the rule) and the ICS mapping row for the Planning Section
follow.

Not exactly to spec, with reasons:

- `settledBy` is a small union (`{task}`, `{question}`, `{reproduce}`) rather than a
  string, so the validator checks it without parsing; a question is named by its
  position in this plan's `questionsForHuman`, since questions have no id until the plan
  is applied.
- `proven` entries carry a one-line rendering beside the id, per Mauria's review comment
  that the situation should carry the verified claims, so the brief (R2-5) and section 10
  can show them without the claims section.
- The situation's claim ids are checked against every claim, not only asserted ones;
  a `proven` claim must in addition be verified (from the review), since it is the one
  place a plan could mark the planner's own conclusion true.
- A `reproduce` settlement may name an open task by id as well as a ref in this plan,
  as a `task` settlement may; the plan's text said a ref.
- From the review: `incident show` prints the whole last situation, not counts; missing
  ids are reported once; the architecture page lists the situation and section 10.

## PR 23: What the planner reads (#23, merged 2026-09-13)

R2-3 of the round 2 plan. Built: a capability may declare `summarize` (grep does); its
claims reach the planner in full only in the cycle after they land, or when the last
situation names them in `proven` or `keep`, and the rest collapse to one line per task
with the inputs, the claim count and the files with counts. Section 5 shows a session's
findings in full (summary, observations, conclusion, reasoning) where it clipped every
result at 200 characters; a deterministic result stays clipped. DESIGN.md Step 3 (the
`summarize` field) and Step 4 (sections 2 and 5) follow.

Not exactly to spec, with reasons:

- "The cycle after it lands" is read from the log: a claim recorded after the last applied
  plan is fresh, whatever the clock says, so a rejected plan does not age the claims it saw.
- The collapsed line does not list claim ids, since the point is the size; a claim the
  planner wants in view next cycle goes in `keep` while it is still shown in full.
- The collapsed line names the task's inputs (clipped) rather than the pattern alone, so
  it holds for any capability that declares `summarize`.
- `summarize` names a predicate, not a capability (from the review): grep's
  `has_no_match_for` claim, whose subject is the search root, would otherwise collapse into
  a line that reads like one match. Only the named predicate collapses.
- The re-rendering of incident 001 under this rule is in the pull request, not here: the
  run's planner input falls from 2.17M to 0.85M characters (61 percent), the same figure
  the analysis put on dropping uncited match claims; cycle 3 is unchanged because its
  matches are fresh. The inline snapshot did not change, since its fixture has no applied
  plan; the dedicated test guards the collapse.

## PR 24: Evidence by reference (#24, merged 2026-09-13)

R2-5 of the round 2 plan. Built: a task names what it reads in `evidenceFrom`, claims by
id and tasks by id or by ref in the same plan, and at dispatch the runtime renders those
claims and the tasks' results into the brief after the task's own inputs. Every session
brief now opens with the incident objective, then the last situation's hypothesis and its
proven list. The interpret capability's `evidence` input is optional; the validator
requires some evidence one way or the other, and checks that referenced claims exist and
referenced tasks are completed or in the task's `dependsOn`. The planner rules say to name
evidence rather than copy it. The store's second migration adds the column. DESIGN.md
(the Task vocabulary row, the incident file row, Step 2's columns and migrations, Step 5's
two rows) follows.

Not exactly to spec, with reasons:

- The "some evidence" check is generic: any session capability whose parsed inputs carry an
  empty `evidence` array and whose `evidenceFrom` names nothing is refused, rather than a
  rule written for `interpret` alone.
- A referenced task must be completed or in the task's `dependsOn`, so its result exists
  when the brief is built; the plan said only that a task may name refs.
- The brief renders a referenced session's findings in full (summary, observations,
  conclusion, reasoning) and any other result as JSON, since a session reads it once.
- The migration machinery became a chain of numbered steps, each idempotent, so a version 1
  file reaches version 3 in one open; a version with no step is refused with the handle
  closed, as before.
- The run test's chained interpret reads the grep's result by task ref, not its claims by
  id: a claim cannot be named before the task that produces it has run, so within one
  plan a task refers to another task's result, and to claims only from earlier cycles.
- From the review: "No duplicates" keys on `evidenceFrom` as well as inputs, since two
  interpret tasks with one question over different claims are different tasks; a replay
  test covers a task recorded before `evidenceFrom` existed.

## PR 25: Roles and rules (#25, merged 2026-09-13)

R2-6 of the round 2 plan. Built, prompt text only: the interpret role names the strongest
alternative explanation and the observation that would decide it, and treats a conclusion
stated in the brief as the hypothesis under test; the investigate role names, for every
inferred claim, the runtime observation or file that would settle it; the planner's system
prompt says that a link the repository cannot establish is settled by reproducing it or by
a question in the same plan, never by more reading, that a brief to interpret carries the
question and the evidence by reference and never the expected conclusion, and that the
rationale says nothing the situation already says. `docs/first-incident.md` names each
change and the cycle of run 001 that motivated it.

Not exactly to spec, with reasons:

- The two rules from R2-2 were already in section 9 when R2-2 merged, so this PR adds
  none there.
- The measure of these changes is the second run, R2-8; a test pins each new sentence so a
  later edit cannot drop one unnoticed.
- From the review: the planner's example of an unprovable link no longer names run 001's
  own (the rerun is the measure); the planner is told the runtime attaches its hypothesis
  to every brief; a capability request is the channel when no reproduce capability is
  listed; the investigate role's settling item carries a "settled by:" prefix so it can be
  told from a citation.

## PR 26: Browser capability (#26, merged 2026-09-13)

R2-7 of the round 2 plan. Built: external equipment, the design's third kind, brought
forward from after v0: an MCP server declared by name and launch command and passed to
the provider as `--mcp-config` (inline JSON) with `--strict-mcp-config`, or a provider
integration named as equipment. Two browsers are registered: `playwright_browser`
(`npx @playwright/mcp@latest --headless --isolated`, on npm at 0.0.80 on 2026-09-13) and
`claude_in_chrome` (Claude Code's `--chrome`). A session capability may declare several
and name an input field, `equipmentSelect`, whose value picks the one to attach. The
`reproduce` capability: inputs `browser`, `url`, `steps` and `observe`; role text that
performs the steps and reports what was observed, never inferred; output of one
observation per step with an optional screenshot path. Registered `read_only` under the
scratch-copy constraint the plan records. `SessionRequest` gains `mcpServers` and
`integrations`; the preamble names a browser among the equipment kinds. DESIGN.md Step 3
(equipment kinds, the capability table) follows; the Reference rows below record what the
live probes found.

Not exactly to spec, with reasons:

- The plan spoke of an equipment kind `mcp_server`; the kind is `external` with two forms,
  because Claude in Chrome is not a server the runtime launches but an integration the
  provider turns on, and the design's session request stays provider-blind by naming the
  integration rather than the flag.
- `--mcp-config` takes the JSON inline (Claude Code accepts strings as well as files, per
  `claude --help` on 2026-09-13), so no temporary file is written per session.
- The live probes' results are in DESIGN.md's Reference table: Playwright works from a
  headless session once its tools are allowlisted (`--allowedTools mcp__<server>`, which
  the provider now renders for every attached server) but refuses `file:` URLs, so the
  opt-in live test serves the fixture over HTTP; Claude in Chrome is denied from a
  headless session even under `bypassPermissions`, so it stays registered as
  `headless: false` with a description that says to prefer Playwright. The plan expected
  both to be tried; one works headless.
- `npx --yes` in the Playwright launch, so a machine without the package cached does not
  stall on npm's prompt.
- Only Playwright has a live test; there is none for Claude in Chrome, since a headless
  session cannot reach it, and the three probes recorded in DESIGN.md stand in for it.
- The screenshot path per step is optional in the output schema, and the role asks for one
  after any step whose observation matters, since a screenshot of every step is noise.
- From the review: Playwright writes its screenshots to a scratch directory
  (`--output-dir` under the OS temp dir), so a `read_only` capability leaves nothing in the
  incident's working tree; the package is pinned (`@playwright/mcp@0.0.80`) so each
  transcript records which server drove it and a cold cache cannot stall the session's
  connect timeout on a registry check; the capability's description tells the planner to
  name Playwright, since `claude_in_chrome` comes back `insufficient` from a headless
  session; the registry's guard message names session-only equipment.

## PR 27: Second run (#27, merged 2026-09-14)

R2-8 of the round 2 plan. The first incident rerun live with round 2 merged, from the same
roughdraftplus commit, against Roughdraft serving a scratch document with five comments;
`incident review` recorded beside run 001 in `docs/first-incident.md` under "Second run":
8 cycles to `satisfied` with the same code path, planner input 265k tokens over the run
against 1.09M, $16.20 at list rates, and the step that code cannot prove settled by five
`reproduce` sessions instead of a question. The section also walks the round-2 changes
cycle by cycle and lists what the run found in the runtime.

Not exactly to spec, with reasons:

- The run forced two code changes, both on this PR. A brief rendered a reproduce result as
  `undefined: undefined` per observation because the renderer assumed investigate's
  `where` and `what`; observations now render by their own fields, with a test. A
  capability request blocked the incident with no way back to `open`; `incident provide`
  answers the oldest unanswered request, records `capability.answered`, shows the answer
  to the planner in section 1 and in `incident show` and `incident review`, and reopens the
  incident once no question, request or grant waits. DESIGN.md's channel table and CLI
  table and `docs/architecture.html` follow.
- A third fix: Playwright MCP resolves a screenshot the session names against the server's
  working directory, not `--output-dir`, so the run's twelve screenshots landed in the
  roughdraftplus tree; the server now starts inside its output directory through a shell
  wrapper, and the reproduce test pins the launch. PR 26's Reference row is corrected.
- The run was stepped from this branch's build once the fixes were in, from cycle 5 on;
  cycles 1 to 4 ran main's build. The first attempt ran a stale `dist/` and was discarded;
  the papercut is logged.
- The scratch document was restored from a pristine copy by the operator when the
  planner asked, rather than by a capability; the write-up records it.
- The two questions the run raised were answered by the session running it, not by
  Mauria, who was asleep: the fixture restore as a fact, and the browser as an inference
  from the machine's default browser, labelled so in the answer.

## R3-0: Mechanism checks (#28, merged 2026-09-15)

R3-0 of the round 3 plan. Two spike scripts under `spikes/round3/` with a `run.sh` runner:
`resume.sh` makes three Haiku calls on one session, each with `--resume` and a different
`--json-schema`, and prints each call's structured output and usage; `agents.sh` makes one
call that spawns a `pinger` subagent defined with `--agents` and prints the envelope's
`subagent_stats` and `modelUsage` beside the subagent transcript's own usage, then starts a
session without agent kinds and resumes it with one. Five rows in DESIGN.md's "Verified
facts" table record what they showed on 2026-09-15 with Claude Code 2.1.272: a resumed call
takes its own schema and returns one structured result; usage is per call; the envelope's
cost includes subagents and their transcripts and `.meta.json` carry per-member usage and the
spawning `toolUseId`; `--agents` is honored on resume. The compaction row rests on the Claude
Code docs (`DISABLE_COMPACT`) and was not run live.

Not exactly to spec, with reasons:

- The compaction check is documentary, not a live call: proving that compaction does not
  fire needs a context near the limit, which would cost more than the fact is worth when the
  docs state the variable plainly. R3-3 sets the variable and R3-9 is where a wrong reading
  would show.
- Cache reads were 0 on every resumed call in `resume.sh`, which the row records as an
  open observation rather than a fact; R3-3's live test settles it with a fixed schema.

## R3-2: Status is a label (#30, merged 2026-09-15)

R3-2 of the round 3 plan. Built: a claim's status now says only which kind of source
produced it, `verified` for deterministic equipment and `asserted` for a session, and
never changes after entry; the basis, `observed` or `inferred`, is what the validator
reads. `promoteMatching` and the promotion path are gone from `src/verifier.ts`, so a
deterministic result that matches an asserted claim on subject, predicate and object
leaves it asserted, and no `claim.verified` event with a `claim.status` mutation is written
any more. `claimsToVerify` is gone from `ActionPlan` (now a `z.strictObject`, so a plan
still carrying the field is rejected at parse), from `applyPlan`'s `plan.applied` payload,
from the validator's "Dependencies resolve" line and from `step`'s printout. The `proven`
check accepts any claim whose basis is `observed`, whichever task observed it, and refuses
an inferred one with "its basis is inferred, not observed"; "Status is earned" requires at
least one observed claim for `satisfied` in place of a verified one. Planner input sections
2 and 3 are one section, "2. Claims", every line carrying `(status, basis; ...)` and its
provenance, and the sections after it renumber to nine; the grep collapse from R2-3 runs
over the merged section. The planner's system prompt and rules say status names the source
and gates nothing, basis says whether it was seen, and `proven` and `satisfied` key on
observed; the session preamble's "until the runtime verifies them" is replaced by the same
statement. No store column changed and `user_version` stays at 3; the version-1 migration
still reads an old file's verified claims as observed. DESIGN.md Vocabulary (claim), Step 3
(the preamble row and the sentence on why deterministic capabilities exist), Step 4, Step 5
and Step 6 follow; the sentence "only deterministic verification promotes it" is gone.
`docs/architecture.html`'s loop and "A claim's life" section follow.

Tests: the validator accepts a `proven` entry naming an observed session claim (`c-seen`)
and refuses an inferred one; a `satisfied` plan passes with observed session claims and no
verified claim, and fails when every claim is inferred; the models test rejects a plan with
`claimsToVerify`; the planner snapshot is updated; the dispatcher test that pinned
promotion now pins its absence, with no `claim.status` mutation in the log.

Not exactly to spec, with reasons:

- The `proven` check stays under "Dependencies resolve", where it was, rather than moving to
  "Inferred links are worked" whose text describes it; DESIGN.md's rule table records that
  placement ("both checked under Dependencies resolve") and moving it changes nothing the
  planner reads.
- `incident review` no longer prints `claimsToVerify N` on a cycle line or `N promoted` in
  the claims summary; the plan block does not name `review.ts`, but both figures measured
  the removed mechanism and would read as a zero that could have been nonzero. A review of
  runs 001 and 002 still parses their logs; the `claim.verified` status events in them are
  simply not counted.
- The session preamble in `src/providers/base.ts` was not named in the block; its one
  sentence promising verification was changed because a prompt that promises a mechanism
  the runtime no longer has is a documentation error. R3-4 rewrites the preamble for
  leaders and lands after this.
- Section numbers cited in the planner prompt ("Section 10", "section 8") follow the
  renumbering; the plan block did not mention them.
- `setClaimStatus` in `src/store.ts` keeps no caller in `src/`; it stays so the replay
  test can write a `claim.status` mutation and prove old logs from runs 001 and 002 still
  rebuild, since those logs carry promotion events.

## R3-3: Persistent sessions (#29, merged 2026-09-15)

R3-3 of the round 3 plan. Built: `SessionRequest` gains optional `resume`, a session id;
the Claude Code renderer adds `--resume <id>` when it is set, and `--no-session-persistence`
is never among the flags, so every session stays resumable. `SessionOutcome` is unchanged:
a resumed call returns one structured result and reports that call's usage alone, with the
session's id unchanged. The provider spawns every session with `DISABLE_COMPACT=1` in its
environment, so auto-compaction never rewrites a session between the calls that resume it.
The stub binary answers a `--resume` call with the id it was given as `session_id` and
records `DISABLE_COMPACT` in its log. Tests: the renderer with and without `resume`, the
stub resumed twice, the environment reaching the stub, and a live test behind
`NOSCOPE_LIVE=1` that runs two Haiku calls on one session with one schema and asserts the
id is kept, the word from the first call is recalled, and the second call's own usage,
written or read, covers the first call's whole context.
DESIGN.md Step 3 (a `resume` row in the session table, the compaction sentence beside the
isolation flags) and the Speed section's last sentence follow; `docs/architecture.html`
names both on the session line. No caller sets `resume` yet; R3-4's unit leaders do.

Not exactly to spec, with reasons:

- The plan's acceptance, a live assertion that the second call's cache reads are nonzero,
  is not met, because the fact is not reliably true. Two things were found (all live, Claude
  Code 2.1.272, 2026-09-15). First, a bare session caches nothing on any call: Haiku 4.5's
  minimum cacheable prefix is 4096 tokens (Anthropic's prompt caching docs, read the same
  day) and the session's context is about 3k, so the first live run of the test read 0
  because its first call had written 0; the test now pads its role text past the minimum,
  with a fresh id per run so a rerun inside the cache's lifetime writes again, and asserts
  the first call's write. Second, with the padding, whether a resumed call reads the earlier
  calls' prefix from cache is intermittent: over 24 runs of two calls, the resumed call read
  the launch call's prefix in 14 and rewrote the whole context (about 12k tokens) in 10;
  over 26 runs of three calls, a second resumed call read the first resumed call's prefix
  in 24. The runs are sequential and seconds apart, and no client-side signal separates a
  prefix that differed from a cache miss. The test therefore asserts what held in every
  run: the resumed call's own usage, written or read, covers the first call's whole context,
  which is the usage-per-call fact R3-4 costs tasks by. The `resume.sh` zeros, whose first
  call did write 8.7k, are one more instance of the same intermittency and stay unexplained;
  the R3-0 Reference row and the design's `resume` row carry the counts, and the Speed
  section says a resumed call's input cost is bounded by the whole context at cache-write
  rates rather than by the new turn. The probe that produced the counts is not committed.
- Two rules for R3-4 are recorded on the `resume` field and in the design's `resume` row,
  from the review: `systemPrompt` on a resumed call is ignored, because Claude Code 2.1.272
  defaults `--system-prompt-snapshot on` and keeps the first call's system prompt on every
  resume, so a seat whose role text must change needs a fresh session; and a session is
  resumed with its original `cwd`, since its transcript lives under that directory's
  project folder (stated as the safe rule, not verified).
- The renderer rejects an empty `resume` (`resume needs a session id`) rather than passing
  `--resume ""` to the binary.
- `DISABLE_COMPACT` is set inside `runProcess` on the spawned environment rather than by
  each caller of the provider, so no request can forget it.
- The Reference table gains no row here; R3-0 lands the resume rows, and this PR's finding
  is in the `resume` row of Step 3's session table instead, so the two PRs do not both
  append to one table.

## R3-1: Tool and subagent events (#31, merged 2026-09-15)

R3-1 of the round 3 plan. Built: the Claude Code provider runs every session with
`--output-format stream-json --verbose` and reads the stream: each `tool_use` block and the
`tool_result` matched to it on `tool_use_id` become one tool call with the tool name, the
full input, the result clipped at 4,000 characters (`TOOL_RESULT_CAP`) with its full length
beside it, `is_error`, and the duration between the two messages' timestamps; the final
`result` line is parsed as the envelope was. When the envelope's `subagent_stats.spawned`
is nonzero the provider reads each transcript under
`<config dir>/projects/<cwd as dashes>/<session id>/subagents/`: agent id, type and
`toolUseId` from the `.meta.json`, model (the envelope's canonical alias for the
transcript's dated snapshot), usage summed from the assistant records, and the member's own
tool calls, in spawn order. `SessionOutcome` carries this as `activity`, and so does
`SessionError`, so a failed session's calls are filed too: a session that returned an error
envelope, and one that died before any (killed on its timeout, or a nonzero exit), whose
session id is read from the stream's init line. `src/activity.ts` writes the
events: one `tool.called` per call with the session id, unit, task in flight (`taskId`,
nullable, and `cycle` for a planner call) and the transcript path, then per subagent one
`subagent.ran` and its calls as `tool.called` events carrying the `agentId`. The dispatcher
writes them in the task's transaction before its claims; the planner writes them after
`plan.proposed`. `task.usage` stays the envelope's figures. `incident review` prints each
session's calls by tool with errors and time in tools, each subagent with its usage and
calls, and a totals line. Fixture: `test/fixtures/stream/`, a stream captured 2026-09-15
from a live Haiku session on Claude Code 2.1.272 with one Bash `echo` and one `pinger`
subagent, plus that subagent's transcript and meta file, with every absolute path
normalized to `/scratch/...`, the machine's MCP servers dropped from the init line, and the
transcript's attachment records (environment and account details the parser never reads)
removed. The stub emits stream-json: an init line, one assistant and one user line per
entry of `NOSCOPE_STUB_TOOLS`, and the envelope. DESIGN.md Step 2 (event types), Step 3
(the flags and the transcript paths) and Step 6 (what the log holds per session),
`docs/architecture.html` and the README's environment paragraph follow.

Not exactly to spec, with reasons:

- `--verbose` is added beside `--output-format stream-json`: print mode refuses the stream
  format without it (verified 2026-09-15 on 2.1.272).
- The `StructuredOutput` call through which a session answers its schema is not filed as a
  `tool.called`: it is the result the task already records, and counting it would add one
  call to every session.
- A subagent's usage is summed once per API message id, not once per assistant record: the
  transcript writes one record per content block of a message and repeats the message's
  usage on each, so a plain sum double-counts a message with thinking and text.
- The subagent's tool calls are separate `tool.called` events carrying its `agentId`, and
  `subagent.ran` carries their count, rather than the calls nested inside the
  `subagent.ran` payload, so one fact has one home and `incident review` counts calls from
  one event type.
- The transcript directory is resolved from `CLAUDE_CONFIG_DIR` when the provider's
  environment sets it (the documented way to move Claude Code's session history), and the
  session's cwd is passed through `realpathSync` first, since Claude Code names the project
  directory from its own resolved cwd. A missing subagents directory yields no
  `subagent.ran` events rather than a failed task.
- The stub's tool lines carry synthetic timestamps 1.5 s apart, so a test can assert a
  duration.
- `--strict-mcp-config` moves into the isolation flags, on every session with or without
  `--mcp-config` (the plan block did not name it; the ruling behind the isolation flags is
  that no session inherits Mauria's personal setup). While capturing the fixture, with
  `--setting-sources ""` the session's init line still listed the claude.ai MCP servers of
  her account (Craft, Gmail, Drive, Calendar) as connected and Craft's tools among the
  session's tools. With the flag and no `--mcp-config`, one live Haiku call on 2.1.272
  (2026-09-15) returned an init line whose `mcp_servers` is empty and whose tools are
  `StructuredOutput` alone.
- From the review: a session killed on its timeout or exiting nonzero now files the calls
  it made under the init line's session id, and its error message quotes the stream's last
  line rather than its first; the planner's calls in `incident review` are selected by
  `cycle`, not by a null `taskId`, so a leader's call filed under no task (R3-4) is not
  counted as the planner's.

## R3-4: Unit leaders (#32, merged 2026-09-15)

R3-4 of the round 3 plan. Built: every unit has a leader. `UnitProposal` and `Unit` gain
`leader` (provider and model, required), `equipment` (built-in tool names and external
equipment names, as a capability declares them) and `bashAllowlist`; `Unit` gains
`sessionId`, null until the leader first runs; `objective` replaces `purpose`. The store is
at schema version 4: the migration renames `purpose` to `objective` and gives an old unit
the legacy leader (`claude-code`/`claude-opus-5`, the planner's pair, since the planner was
then the only seat above a task), no equipment and no session, and replay reads a
`unit.create` mutation from before leaders the same way, so runs 001 and 002 still review.
`incident create` gains `--ic-model` (default `claude-opus-5`, checked against the models
Claude Code serves) and creates the root unit with that leader and the four read-only
built-ins. The new module `src/leader.ts` holds the leader role text, the orientation, the
turn prompt, the `LeaderTurn` schema's JSON form, `runsInsideLeader` (a session-backed task
on the leader's provider and model whose equipment and Bash allowlist the unit holds;
`default` covers every built-in) and `unitsOwingReport`. The dispatcher runs the units one
at a time in tree order (`unitsInTreeOrder` in `src/tree.ts`), each until its leader
reports: a task runs in process, inside the leader's session (the leader's request with the
task's brief and the capability's schema, resumed once the session exists) or in its own
session; after each the leader is asked for a `LeaderTurn`, `continue` or `report`
(`met`, `not_met` or `progress`; `changed` with claim ids; `pictureChanged`; `why` and
`suggestion` required for `not_met` by a refinement); `report` writes `unit.reported` and
ends the unit's pass, `pictureChanged` ends the whole pass and `dispatch` returns the unit's
id beside `ran`, `reports` and `stopped`. The leader's session id is recorded on the unit
by `leader.started` (mutation `unit.session`) at its first call, whether that call was a
task or a turn, and `unit.closed` carries it. `ActionPlan` and `LeaderTurn` carry an
optional `discrepancy`, recorded as `picture.discrepancy` (seat, unit, task in flight) and
printed by `step`, `incident show` and `incident review`. The preamble in
`src/providers/base.ts` is rewritten per the plan block, with the session's place as one
paragraph per seat (`SEAT_PLACES`: `task`, `leader`, `ic`) and the hierarchy around the
unit rendered from the tree into every brief (`renderHierarchy`). The validator's "Model
known" covers a new unit's leader, "Closing is clean" refuses to close a unit whose leader
has a session and has not reported since the unit's last task ended, and "Effect policy"
holds a new unit's equipment to known equipment and its allowlist to read-only commands.
The planner's unit tree shows each leader's model and last report outcome, a new section 6
lists the unit reports since the last cycle, and the prompt says what a new unit names.
`incident tree` shows each leader's model and last report; `incident review` lists each
leader's turns with their usage under the role `leader`, counts turns and reports, and
lists each unit's reports by cycle. The stub recognises a leader's turn by the `LeaderTurn`
schema and answers `continue` while the prompt says tasks remain and a progress report once
it says none do, or `NOSCOPE_STUB_TURN` / `NOSCOPE_STUB_TURNS`; `NOSCOPE_STUB_CALLS` appends
one line per call. DESIGN.md Vocabulary (unit, task), the ICS mapping rows for the
Operations Section and the organizational levels, Step 1's layout, Step 2 (the `units`
columns, the event types, the migration), Step 3 (the preamble row, the user message), Step
4 (the input sections, `UnitProposal`, `discrepancy`), Step 5, Step 6, Step 7 and the Model
choices follow; `docs/architecture.html` gains the leader node and follows on the cycle and
the session's prompt; the README's environment paragraph names leaders.

Tests: the dispatcher on the stub runs a grep in process, an investigate on the leader's
model as a resumed call on the leader's session and an interpret on another model in its
own session, with per-task events for all three, two `unit.continued` and one
`unit.reported`, checked against the stub's call log (kind, `--resume`, prompt, schema,
tools); a `pictureChanged` report stops the pass before the next unit and records the
discrepancy; a leader that continues with nothing left is asked again next pass with no
task; a failing leader ends the pass naming the unit after the task's events; the preamble
test pins the seat paragraphs, the added terms and the leader role text; the planner
snapshot shows leaders in the tree and a report in section 6; the store replays a unit from
before leaders, `leader.started`, both turn events and `picture.discrepancy`, and migrates
a version 3 file; the validator tests cover a leader on an unknown model or provider, unit
equipment and allowlist, and demobilization; `incident review` prices a leader's turn.

Not exactly to spec, with reasons:

- The unit tree is planner input section 3, not 4 (R3-2 merged sections 2 and 3), and a
  section 6, "Unit reports since the last cycle", is added, so the file has ten sections
  and the prompt's section numbers move: without it a report would reach nobody until
  R3-7, and the planner is the seat that reads the file today.
- Every leader turn is recorded, `unit.continued` beside `unit.reported`, because each turn
  is a call with its own usage and `incident review` costs it; `leader.started` is a third
  event because the session id is a state change (the mutation `unit.session`) and the
  tables must rebuild from the log.
- The report field is `pictureChanged`, camel case like every other field in the contracts;
  the plan block writes `picture_changed`.
- A leader's turns are not counted against the incident's budget, as the planner's calls
  are not (the design call on the revisit list); the per-task budget and time-bound
  behaviour is unchanged, and a turn runs under a fixed 300-second bound.
- A leader that answers `continue` when no ready task remains ends its unit's pass with no
  report rather than being re-asked in a loop; the unit then owes a report
  (`unitsOwingReport`: a task ended after the last report, whether or not a session exists
  yet, since the turn creates one), is asked for one at the start of the next pass with no
  task to show, and cannot be closed until it has reported, which is how "Closing is clean"
  reads demobilization.
- A leader that cannot answer (a failed session or an output that does not fit) throws,
  which `step` reports as exit 1 after the task's own events were written, the way a
  planner that cannot answer does; its usage is not recorded. One failure is recovered
  from (review, ruled option (a)): a resumed call that dies before the stream's init line,
  which is what the binary does for a session it cannot find, replaces the session: a fresh
  one is oriented and asked the same turn, and its `leader.started` carries `replaced` (the
  dead id) and `reason`; every `leader.started` carries the `cwd` the session was launched
  from, since a session is found under its original cwd.
- A session task is bounded by its request's timeout alone, not by the dispatcher's timer
  (review): the provider kills the process and files its calls under the session id, and a
  dispatcher-side `TimeBound` would fail the task while that process still ran, so the
  leader's next call would find its session in use. `withinSeconds` now bounds deterministic
  tasks only, and `timedOut` on `task.failed` is true only for those.
- A task that fails on the leader's first call still records that session on the unit
  (review) when the provider returned its id, so the turn resumes a session that has read
  the orientation and the brief rather than starting a cold one.
- A task runs inside the leader's session only when its capability's Bash allowlist is also
  within the unit's, beyond the model and equipment match the plan names, since a command
  the leader's session cannot run would be denied there; a capability with
  `equipmentSelect` (`reproduce`) never runs inside, since the leader's session attaches
  every piece of its equipment and the per-task check would be skipped.
- The leader's `--tools`, `--allowedTools` and system prompt are sent on every resumed call
  as on the first; whether Claude Code honours a changed tool list on `--resume` is not
  verified and nothing here changes it between calls.
- The orientation before a task's brief is only the unit's own lines (its id, objective,
  equipment and allowlist), since the brief already carries the incident objective, the
  situation and the hierarchy; a turn on a fresh session gets the full orientation.
- The IC seat paragraph describes the seat R3-7 builds and says a task under command runs
  under the IC as under any leader; in this PR the root's leader answers `LeaderTurn` like
  every leader. Its role text (`leaderRole("ic")`) is the unit leader's with two sentences
  changed: it opens "Your role: Incident Commander, leader of command", and a `not_met`
  report under command goes to Mauria, who decides what happens next, since nothing sits
  between the IC and her. For R3-7: a root session started under R3-4 keeps this role text
  in its snapshotted system prompt (Claude Code keeps the first call's system prompt on
  every resume), so R3-7 must null `command`'s `session_id` in its migration, or recreate
  the root session, before the IC's own turns use it.
- The root unit's equipment at `create` is the four read-only built-ins with the read-only
  allowlist, which the plan block does not name; a task on the IC's model with no more than
  that runs inside the IC's session.
- The "Effect policy" rule, not named in the plan block, is where a new unit's equipment and
  allowlist are checked, because that is the rule that keeps a session read-only.
- `renderTaskBrief` renders the hierarchy only when its context carries the units, which
  dispatch's does, so the bare brief the session tests pin is unchanged.
- `Leader` replaces the unused `ProviderModel` schema; `runSession` takes an optional
  prepared request and `resolveEquipment` is shared between a capability's request and a
  leader's; the step's `ran` lines do not say where a task ran, since the events do
  (`task.completed`'s session id is the unit's for a task run inside the leader).
- The stub's `NOSCOPE_STUB_FAIL` and `NOSCOPE_STUB_EXIT` leave a leader's turn alone and
  `NOSCOPE_STUB_LEADER_FAIL` fails it instead, so a test of a failing task session still
  gets its leader's turn; `NOSCOPE_STUB_SLEEP_MS` holds a task call past its bound,
  `NOSCOPE_STUB_RESUME_FAIL` names a session whose resume exits before any output, and each
  `NOSCOPE_STUB_CALLS` line counts the stub processes still running when the call started,
  which is how the timeout test shows the turn waited for the killed process.

## R3-5: Strike teams (#35, merged 2026-09-15)

R3-5 of the round 3 plan. Built: a task declares the subagent team its leader may send, the
runtime provides it and logs every member. `StrikeTeam` in `src/models.ts` is `kind` (a
name of letters, digits, `-` and `_`), `model`, `tools` (built-in tool names), `prompt`
(the member's system prompt), `count` and `why`; `TaskProposal` gains optional
`strikeTeam: StrikeTeam[]`, `Task` carries it with `[]` as the default (column
`strike_team_json`, schema version 5, the migration adding the column), and a task with
more than one kind is a task force. `LeaderTurn` gains optional `requestStrikeTeam`, the
same shape. No preset kinds and no default kind exist. `applyPlan` copies a proposal's team
onto the task and records `strike_team.defined` (`declaredBy: plan`) beside `task.created`.
The dispatcher passes the task that runs next into the leader's turn, whose prompt names it
and the team it already declares and says how to ask; a `requestStrikeTeam` on a `continue`
turn is held to the team's three rules (`strikeTeamRejections` in `src/validator.ts`) and,
accepted, becomes the declaration on that task (`setTaskStrikeTeam`, mutation
`task.strikeTeam`, event `strike_team.defined` with `declaredBy: leader`, the unit and the
session; a kind the task already declares is replaced by name), written in the turn's
transaction after `unit.continued`; refused, or asked on a `report` turn or with no task
left, `strike_team.rejected` keeps the request, who asked and the reasons. Whichever call
runs the task carries the team as the request's `strikeTeam`: the leader's resumed call for
a task inside the leader, or the task's own session (`buildSessionRequest`); a turn never
does. The Claude Code renderer turns it into `--agents` (`{kind: {description: why,
prompt, model, tools}}`) and adds `Agent` to `--tools` (unless `default`) and to
`--allowedTools`, for that call alone. The brief (`renderStrikeTeamBrief` in
`src/strike-team.ts`) lists each kind's shape, count and why, says a kind is sent by name
through the Agent tool, and says a claim resting on a member's finding cites the member's
`agentId`, which the Agent tool's result shows the session (the R3-1 fixture's result
carries `agentId: af6c0f2722871e1a1`). The validator's "Model known" checks a team's model
against the task's provider's list and refuses a team on a task that runs no session;
"Effect policy" holds a team's tools to the four read-only built-ins (that a member's `Bash`
is held to the parent session's allowlist is inferred from Claude Code applying permission
rules session-wide, not tested on 2.1.272); "Budget respected"
holds `count` times `STRIKE_MEMBER_MIN_TOKENS` (600; the fixture's `pinger` with no tools
read 672) inside the task's token bound where it sets one; the planner's rule lines say the
same and its prompt says what a team is and that none exists by default. `incident review`
prints each declaration and refusal in its cycle and, at the end, one line per declared
config (task and kind, as last declared): model, who declared it, count declared, members
run (`subagent.ran` under that task with that `agentType`), their usage and cost, and how
many claims cite a member by its `agentId` or its `subagent.ran` event id in their evidence
(`citesMember`). `step` prints a plan's teams under their tasks and a leader's declarations
and refusals after the pass. The leader role text gains the paragraph R3-4 left out: a
leader may send a team the task declares or ask for one in its turn, choosing kind, model,
tools, prompt and count and saying why; the preamble's strike-team line says no kind exists
by default and whoever asks chooses the shape. DESIGN.md Vocabulary (task, strike team, task
force), the ICS mapping row, Step 2 (the column, the events, the migration), Step 3 (the
`strike_team` session field, the brief), Step 4 (`TaskProposal`, `requestStrikeTeam`), Step
5 (the three rules), Step 6 (provision and events) and Step 7 (`review`) follow;
`docs/architecture.html` follows on validate, apply, dispatch and the session's inputs; the
README names the new live test.

Tests: the models test pins the schema, the field on a proposal and a turn, and the
`LeaderTurn` JSON schema's required member fields; the validator refuses a writing tool, an
unknown model, a count over the task's token bound and a team on a deterministic task, each
under its rule, passes a well-formed team, and applies the same checks to a request outside
a plan; the renderer test shows a declared team reaching `--agents` with `Agent` in the
tools and the allowlist, on a resumed call too, and nothing on an empty team; the dispatcher
test on the stub runs a grep, an investigate inside the leader and an interpret in its own
session, with the leader's `requestStrikeTeam` after the grep declared on the investigate
(`--agents` and the brief's team lines on the leader's resumed call), the interpret's own
declaration reaching its own session, a request with `Edit` refused with its reason and a
request on the report turn refused for having no task; `applyPlan` writes the plan's
declaration; the store migrates a version 4 file and replays `task.strikeTeam`; `review`
prints two configs, one refusal, members against counts and claims citing by agent id and
by event id. The live test behind `NOSCOPE_LIVE=1` (run 2026-09-15 on Claude Code 2.1.272,
twice) has a Haiku leader run one investigate inside its session with a two-member `pinger`
team declared by the plan: the log held `strike_team.defined`, two `tool.called` for the
`Agent` calls and two `subagent.ran` of type `pinger`, each `toolUseId` matching one of the
calls.

Not exactly to spec, with reasons:

- "The count against the task's budget" is read as the count times a per-member floor
  against the task's token bound, since the task's budget is the only figure a count can
  be held to and no member cost is declared anywhere; a task with no token bound has
  nothing for the count to exceed. The floor is a named constant with its source.
- `strike_team.rejected` is a second event type beside `strike_team.defined`, so a
  leader's refused request is still in the record (what leaders ask for is what presets
  are learned from) without a "defined" event that defined nothing.
- The leader's request goes on the task that runs next in its unit, which the turn prompt
  now names (`Next: task ...`), since a leader cannot see task ids otherwise; on a `report`
  turn there is no next task in this pass, so the request is refused as having nothing to
  send it on rather than held for a later pass.
- The live acceptance says "one `tool.called` for the `Agent` call and two `subagent.ran`
  linked to it"; on 2.1.272 one `Agent` call spawns one member, so the session makes two
  calls and the test links each member to one of them. In both live runs the binary launched
  the members as background agents ("Async agent launched successfully") and the session
  waited for their notifications; both transcripts were read as before.
- `LeaderTurn` is now one `strictObject` with `report` required and nullable (null on a
  continue turn), the not-met refinement moved onto `LeaderReport`, every field name kept.
  In the first live runs the Haiku leader's turn did not fit the R3-4 shape, one open
  object with `report` optional: it flattened the report's fields onto the turn (`{kind:
  "report", outcome: ..., changed: ...}`), which ended the pass at parse. The closed object
  puts `additionalProperties: false` and the required `report` into the schema the
  provider validates against, so a flattened turn is refused at the `StructuredOutput`
  call and retried by the session. The orchestrator asked for a discriminated union of two
  strict variants; the API refuses one at the top level of a tool's input schema
  ("input_schema does not support oneOf, allOf, or anyOf at the top level", a 400 seen
  2026-09-15 on 2.1.272 with the union rendered from zod as `oneOf`), so `jsonSchemaFor`
  now names that in its refusal and the closed object with the required nullable report is
  the nearest shape the API takes. In the live run after the change the Haiku leader's turn
  nested its report and parsed on the first answer.
- The `Agent` tool's result on 2.1.272 tells the model the `agentId` is internal and not to
  quote it; the brief tells the session to cite it in a claim's evidence, and in the live
  runs Haiku did. A claim can also cite the member's `subagent.ran` event id, which only a
  later call could know; nothing renders those ids to a session yet.
- `--allowedTools` carries bare `Agent`, the form the spike verified; the documented
  `Agent(kind, ...)` form that restricts which kinds may be spawned is not verified on
  2.1.272 and not used.
- A leader's declaration replaces a kind of the same name the task already declares rather
  than being refused, since `--agents` is keyed by name and a later definition is what the
  leader asked for; the event carries the whole resulting list.

## R3-7: The IC above the planner (#33, merged 2026-09-15)

R3-7 of the round 3 plan. Built: the root unit's leader, the Incident Commander, has its
own two schemas and the cycle runs through it. `src/ic.ts` renders the IC's briefing, the
change report since the IC last acted (every `picture.discrepancy` first, every
`unit.reported` with its why, suggestion and whether the picture changed, every question
answered and capability provided, the rules its last turn failed, and the spend since then:
every usage any seat recorded after the IC's last turn, summed) followed by
`renderPlannerInput`'s ten sections and the ask, and makes the IC's two calls on the root
unit's session through `leaderRequest`: the command turn under `CommandTurn`
(`periodObjectives`, `priorities`, `closeUnits`, `answers` with an empty default,
`questionsForHuman`, `capabilityRequests`, `grantRequests`, `incidentStatus`, `rationale`,
`discrepancy`) and the review under `ReviewTurn` (`approve`, `correct` with `corrections`,
`amend` with `plan`), or `FinalReviewTurn` after a redraft, whose verdict enum is `approve
| amend` so the provider's schema and the parse both refuse a second correction. The cycle
in `src/commands/incident.ts` is the eight steps: briefing; command turn, validated under
Units exist, Closing is clean and Status is earned (`validateCommand`, the turn checked as
a plan that creates nothing) and applied by `applyCommand` (closes, questions, requests,
status, and `command.turned` carrying the turn, the call's provenance and the period as the
mutation `incident.period`), the cycle ending there when the status is not `continue` or
the turn was rejected (`command.rejected` per rule); the planner's draft; the IC's review,
with one redraft on `correct` (the planner's input is the file with its draft and the
corrections appended after section 10, `plan.proposed` marked `redraft` with the
corrections) and a second read under `FinalReviewTurn`; the validator on the plan to apply
(the draft, the redraft, or the amended plan); `applyPlan`, whose `plan.applied` now
carries `verdict`, `corrections` and `diff`; dispatch; stop. `planDiff` compares each
array field of the plan as a set of items under a key-sorted JSON serialization (a
reordered item is no change, an edited one is removed and added) and names the other
fields that differ in `changed`. The incident carries `period` (`number`, `objectives`,
`priorities`) in the new `period_json` column; the store is at schema version 6, and the
migration also nulls every root unit's `session_id`, since a root session started under
R3-4 keeps that build's leader role text in its snapshotted system prompt, so the IC's
first command turn starts a fresh session under `IC_ROLE`. The period renders into the
planner's section 1, every leader's orientation and every task's brief (`renderPeriod` in
`src/tree.ts`, nothing before a period exists). `leaderRole("ic")` returns the new
`IC_ROLE`: it scopes, breaks down, equips and judges; its digging is assigned; a period
ends when units report or the picture changes; `satisfied` when the period objectives and
the incident objective are met by the reports on observed claims; a `not_met` report's
why and suggestion are information for its decision and never a decision; a discrepancy
it cannot reconcile from the file becomes a question for Mauria; the situation stays the
planner's; one review, one redraft; a task under command runs under it as under any
leader. The planner's prompt says the IC sets the period and reviews the draft, and that
the rationale names the priority that chose between plans. The IC's own activity is filed
under the root unit and the cycle with `seat: "ic"`; `cycleOf` in `src/store.ts` counts
`command.turned` events, falling back to `plan.proposed` for a log from before the IC, and
`incident review` cuts cycles the same way, prints the IC's command turn and each review
with their usage under the role `ic`, each draft's planner line (`redraft` marked), the
cycle's verdict with the IC's, and `ic verdicts: N review(s): a approve, c correct, m
amend`. `incident show` prints the current period's objectives and priorities. The stub
recognises the two schemas (`periodObjectives`, `verdict`) and answers
`NOSCOPE_STUB_COMMAND(S)` and `NOSCOPE_STUB_REVIEW(S)` walked with their own counter
files, or by default one objective and `continue`, and `approve`; `NOSCOPE_STUB_CALLS`
lines carry the kinds `command` and `review`. DESIGN.md Vocabulary (action plan, cycle,
incident file, a new operational period row), the ICS mapping rows for the Incident
Commander and Planning Section, the action plan and the Planning P, Step 1's layout, Step 2
(the `period_json` column, the new event types, the version 5 migration), Step 3 (the
preamble row), Step 4 (retitled the IC and the planner: the briefing, both schemas, the
review and the diff, the channel table), Step 5 (the root is never closed; what a command
turn is held to), Step 6 (the IC's usage and activity), Step 7 (`create`, `show`, `step`,
`review`, `answer`) and the Speed section follow; `docs/architecture.html` gains the IC
node and the eight-step cycle; the README's environment paragraph names the IC.

Tests (`test/ic.test.ts`): a run on the stub where cycle 1's IC sets objectives, the
planner drafts, the IC corrects, the planner redrafts with the corrections in its input,
the IC approves under a schema that cannot say correct, the plan applies with the verdict,
corrections and diff on `plan.applied`, a unit reports, `show` prints the period and
`review` counts the verdicts; a `pictureChanged` report ends the pass and the next step's
briefing opens with the discrepancy and the report, with the spend since the IC's last
act; `amend` applies the amended plan and records the diff; a second `correct` fails the
step with the IC named; a `satisfied` turn with no observed claim and a close of the root
are rejected with `command.rejected` and named in the next briefing, a `blocked` turn with
a question stops before the planner and `answer` reopens the incident, and a `failed` turn
closes it; the change report and briefing rendered from a scripted log; the two schemas;
the diff. The models test counts 39 event types; the store test migrates a version 5 file,
replays the period, and asserts the root session is dropped and a leader's kept; the
planner snapshot shows the period in section 1; the review test pins the IC lines and the
verdict counts, and that a log from before the IC shows none; the step test's printout
gains the IC's lines.

Not exactly to spec, with reasons:

- `command.turned` is written before the IC's own filing events (`leader.started`, its
  `tool.called` and `picture.discrepancy`) in the same transaction: `icCall` returns a
  `record` closure the caller runs after the turn's event, so the turn opens the cycle in
  the log and review's cut at `command.turned` keeps the IC's activity in its cycle.
- The command turn is validated, which the plan block does not say: a close of a unit that
  is closed, running, owing a report, or the root would throw inside `closeUnit` or leave
  the tree wrong, and a `satisfied` with no observed claim would close the incident
  unearned. The three rules that cover what a turn can do are applied by the same checks
  as a plan's; `command.rejected` is a new event type for it, and "Closing is clean" now
  refuses the root for plans too.
- `diff` on `plan.applied` is between the planner's first draft and the applied plan, not
  the redraft and the applied plan, so after a correction it shows what the correction
  changed; with `corrections` beside it that is the whole record of the IC's hand.
- `Period` carries `number`, the cycle that set it, so `show` and a brief can say which
  period this is; `period` is optional on `Incident` rather than nullable, so the many
  incident literals in tests keep compiling and an `incident.create` mutation from an old
  log parses unchanged.
- The IC's `answers` are recorded on `command.turned` and printed by `step`; delivering
  them to a waiting unit is R3-6's, whose resource requests and `waiting` status are not on
  this base.
- The IC's usage is not counted against the budget, like the planner's and the leaders'
  (the design call on the revisit list); the change report's spend does include it.
- `--priority` on `create` and `priorities` on the incident already existed (PR 4) and
  rendered in section 1; this PR adds the planner prompt's sentence that the rationale
  names the priority, the IC's restatement on the period, and the priorities in every
  brief.
- The IC's session is always created by a command turn, never by a task under command:
  the command turn is step 2 and dispatch is step 7, and the migration nulls a session
  R3-4 had started, so no root session ever carries the old role text.
- A resumed IC call that dies before the stream's init line replaces the session the way a
  leader's turn does (`leader.started` with `replaced`), so a lost root session does not
  end every cycle.
- The stub's `NOSCOPE_STUB_FAIL`, `NOSCOPE_STUB_EXIT` and `NOSCOPE_STUB_SLEEP_MS` leave the
  IC's turns alone as they leave a leader's, and `NOSCOPE_STUB_LEADER_FAIL` fails them; an
  empty `NOSCOPE_STUB_COMMANDS` or `NOSCOPE_STUB_REVIEWS` list falls back to the default
  rather than answering nothing.
- Review's "plans:" line now reads "N drafted in M cycle(s)", since a cycle can hold two
  drafts.
- An IC that cannot answer (a failed session, or an output that does not fit, which is
  what a second `correct` is) ends the step with exit 1 naming the IC; the call is filed
  first as `command.failed` (session id, which turn, cycle, reason, the usage the provider
  returned) and a first call's session goes on the unit (`leader.started` with `failed`),
  so R3-9's context sum and `incident review` see it and no paid session is orphaned. The
  period it set stands and the next step opens a new command turn.
- From the review (PR 33): every turn schema is `z.strictObject`, including `UnitClose` and
  `GrantRequest`, which the plan shares; `FinalReviewTurn` omits `corrections` before its
  refinement, and the refinement also refuses a `plan` without `amend` and `corrections`
  without `correct`, so only an amend verdict's plan is ever applied. A review on a session
  with no id (lost since the command turn, or fresh after a handoff) is briefed with the
  change report and the file before the draft: `icCall` takes a prompt builder that sees
  the unit as it stands. The IC's `leader.started` carries no usage and the change report
  skips the IC's own discrepancies, so a turn that ends the cycle is not reported back to
  the IC as news. The migration releases a root session through the log (`leader.released`,
  the `unit.session` mutation with a null id; `setUnitSession` takes null), so a replay
  drops it too, and R3-9 drops a session the same way. `cycleOf` counts the drafts before
  the first command turn plus the accepted command turns, so a migrated incident keeps its
  numbering and a rejected turn does not advance the period; review cuts on the same
  openers and lists a rejected or failed command turn as the period it attempted. The
  change report's heading names its window (the command turn or the review it follows),
  renders a `resource requests:` heading with `(none)` for R3-6 to fill, and the role text
  says `answers` is for those and nothing else, that the IC's tools are for a task under
  command and not its turns, and that `satisfied` is refused while a task is open.
- For R3-9: a handoff between the command turn (step 2) and the review (step 4) must
  re-brief the incoming session before the draft; `reviewTurn` already does so for a
  session with no id, so releasing the root session (`setUnitSession` with null) before
  the review is the whole mechanism.

## R3-6: Lacks resolve at the leader (#34, merged 2026-09-15)

R3-6 of the round 3 plan. Built: a lack is resolved by the nearest seat that can. A task's
`insufficient` no longer goes to the planner: the leader's next turn renders what the task
needed, each with its kind, and what the leader does about each (`RESOLVE_LACKS` in
`src/leader.ts`); the planner's section 5 lists only needs other than `retrievable_fact`. A
`LeaderTurn` gains optional `assignTasks: TaskProposal[]`, on either move: after the turn is
recorded the proposals pass the plan rules that read tasks (Capabilities exist, Units exist,
No cycles, No duplicates, Inputs validate, Span of control, Effect policy, Budget respected,
Dependencies resolve, Model known), run on a plan that creates those tasks and nothing else,
plus three of the leader's own in `LEADER_RULES`, keyed the way `PLANNER_RULES` are: "Own
unit" (every task names the leader's unit), "Capability held" (`holdsCapability`: a
deterministic capability always, a session-backed one when the unit's equipment and Bash
allowlist cover its, an `equipmentSelect` one when the task's pick is held; `runsInsideLeader`
now delegates to it) and "Budget within share" (`unitShare`: the share is the sum of the
budgets of the unit's plan-assigned tasks per dimension, undefined where none bounds it;
charged is the usage of the unit's ended tasks plus the bounds of its open tasks, the
leader's own included; a dimension no plan task under the unit bounds is a share of zero,
so an assignment may not bound it, ruled 2026-09-15 in review). A passing assignment is applied by `applyLeaderTasks` in
`src/runtime.ts` (`buildTasks` is shared with `applyPlan`): `task.created` and `plan.applied`
with the actor `leader`, the unit, its session and the task ids; the dispatcher runs the
ready ones in the same pass. A refused one records `plan.rejected` per rule with the actor
`leader` and the unit, creates nothing, and its reasons open the leader's next prompt
(`refusedSinceLastTurn`). The report gains optional `resourceRequests` (`ResourceRequest`:
kind `permission`, `missing_means` or `human_knowledge`, what, why): the report is forced
`pictureChanged` before it is recorded, then `raiseResourceRequests` in one transaction
raises a `human_knowledge` request as a question (`text` is "what (why)", `unitId` the unit),
a `missing_means` one as a capability request naming the unit, a `permission` one as
`grant.requested` with `unitId`, `what` and `why`, and moves the unit to the new status
`waiting` (`unit.waiting`, the mutation `unit.status`; `Store.setUnitStatus`); the incident's
status is untouched. The turn's record, its assignments and its requests land in one
transaction (the inner `batch` calls run as savepoints), with the assignments validated
and applied before the requests are raised, so a report that both assigns and asks keeps
its tasks; the schema refuses a `report` on a `continue` turn, so a request never rides
on one. Dispatch runs active units only, so a waiting unit is skipped, its
pending tasks stay pending and it owes no report. `incident answer` and `incident provide`
answer the oldest open question or request whichever seat raised it; when it named a unit and
nothing of that unit's is still open (`openRequestsByUnit`), the unit returns to `active`
(`unit.resumed`); the incident returns to `open` only when a plan had blocked it and nothing
of the planner's still waits (`holdsOn` counts the planner's only).
The next pass opens a resumed unit (`resumedUnits`: `unit.resumed` after the unit's last
turn) with a turn carrying every answer to its requests (`answeredRequestsOf`) before any
task runs. `incident show` marks each question and request with the unit that raised it and
lists the waiting units with what each waits on; `incident tree` and the planner's section 3
show `[waiting]` with the requests; section 6 shows a report's requests; `step` prints a
report's requests and each leader's assignments; `incident review` lists what a leader sent
up, assigned or was refused under its turns and counts lacks resolved at a leader against
those sent up. The leader role text says how a lack resolves and lists the leader's rules,
the turn schema's descriptions say the same, and the planner prompt says what a leader
does with its own lacks. The stub gains `NOSCOPE_STUB_OUTPUTS`, a walked list of task
outputs with the counter `NOSCOPE_STUB_OUTPUT_COUNTER`. Rebased over R3-5 and R3-7 (#35,
#33): `assignTasks` sits in the shared `TurnFields` and `resourceRequests` in the report's
fields; the refinement reads "a continue turn's `report` is null"; a leader-assigned task
carries its own `strikeTeam` (recorded as `strike_team.defined` with `declaredBy: leader`),
while `requestStrikeTeam` still targets the pre-computed next task; the `CommandTurn`'s
`capabilityRequests` omit `unitId` too. The IC's `answers` are delivered: the change
report's `resource requests:` heading lists what each waiting unit still asks, with the text
an answer names it by; `validateCommand` refuses an answer naming a unit that is not
waiting or a request it did not raise ("Answers match"); `applyCommand` answers each
through `answerRequest` in `src/runtime.ts`, the one function `incident answer` and
`incident provide` also call, which stores the answer, reopens the incident when a command
turn or a plan had blocked it and nothing of theirs still waits, and resumes the unit once
nothing of its is open, so the same cycle's dispatch delivers the answers. `IC_ROLE` says
the IC assigns tasks under command like any leader. The schema version stays 6. DESIGN.md Vocabulary (unit), Step 2
(the `units` status, the question and request fields, the event types), Step 4 (the
channel table gains a column for the leader), Step 5 (the leader's rules), Step 6 and
Step 7 follow; `docs/architecture.html` follows on the leader node, the cycle, the
session's output and the waiting-on-Mauria cards.

Tests: the dispatcher on the stub runs an investigate inside the leader that comes back
insufficient for a retrievable fact, whose leader assigns a grep, then an investigate with
the grep's result in `evidenceFrom` that runs as a resumed call on its session, then reports
`met`, all in one pass, checked against the stub's call log and the `plan.applied` and
`task.created` events; an assignment under another unit is refused, recorded with the leader
as actor, creates nothing and is read back into the next turn's prompt; a `human_knowledge`
request puts the unit in `waiting` with the question naming it, forces `pictureChanged`,
stops the pass, leaves the incident `open` and the unit's dependent task pending, is skipped
next pass while the other unit runs, and after `incident answer` the unit is `active`, its
leader reads the answer before its pending task runs; a `missing_means` request is a
capability request naming the unit and `incident provide` resumes the unit only once its
question is answered too, with `show` and `tree` listing what it waits on. The validator
tests cover each leader rule with its reason, the share before and after a task settles, and
the plan rules on a leader's tasks; the store test covers the `unit.status` mutation, closing
a waiting unit and replay; the models test the new fields and the schema descriptions; the
review test the leader's lines and the `lacks` count; the preamble test the role text; the
blocking test that a retrievable fact reaches the leader's prompt and not the planner's;
the planner snapshot shows a waiting unit in section 3, a non-retrievable need in section
5 and a report's requests in section 6.

Not exactly to spec, with reasons:

- `unitId` on a question or capability request is optional and absent on the planner's own,
  not null: every stored question and every test's `toEqual` on one stays as it was, and the
  planner's plan shape (`CapabilityRequest.omit({ answer, unitId })`) is unchanged.
- A unit has no budget of its own in the schema, so "inside its budget" is read as what the
  plans allotted the unit's tasks: the share is the sum of the plan-assigned tasks' budgets
  per dimension. Ruled in review (2026-09-15): a dimension no plan task under the unit
  bounds is a share of zero, so an assignment may not bound it, and a leader under only
  unbounded deterministic tasks cannot assign a session task bounded by the incident's
  budget alone. A deterministic task with no bound asks nothing of the share. The share is
  cumulative over the incident: a plan task that finishes under its bound frees the rest to
  its leader.
- A refused assignment is not re-asked within the pass: the unit's pass goes on as before
  (a `continue` with nothing left and nothing assigned ends it without a report, and the
  unit then owes one), and the refusal is rendered into the leader's next turn, which is
  what a `plan.rejected` is for the planner.
- `assignTasks` on a `report` turn is applied too, but the unit's pass has ended, so the
  tasks run next pass; the description and DESIGN.md say so.
- The root unit never enters `waiting` from a leader turn (second review): a resource
  request on the IC's leader-turn report is refused as `plan.rejected` by the actor `leader`
  with the rule "Resource requests", read into its next leader prompt and listed in its
  change report under "refused on your last leader turn under command", and the report is
  still picture-changing so the command turn that raises the lack follows at once.
- "Answers match" also refuses an answer given twice for one unit and request, and names a
  permission request as one only a grant answers, so an IC slip is a `command.rejected`
  rather than a crash inside the command turn's transaction.
- `incident answer` and `incident provide` pass over a closed unit's open questions and
  requests, since nothing reads their answers; the command says "unit X is closed" when an
  answer lands on one through the IC.
- A `permission` request holds its unit until a grant exists, which is after v0, the way
  the planner's grant request holds the incident; `openRequestsByUnit` counts every
  `grant.requested` with a `unitId` as open.
- A unit with several requests returns to `active` only when all of them are answered; the
  command says "still waits on N request(s)" otherwise.
- A resumed unit's leader is asked for a move with the answers before any task runs, so the
  answer reaches it before a task that runs inside its session; the plan block does not say
  when the leader reads the answer. `resumedUnits` compares the resume to the leader's last
  turn of either kind, so the answered turn is given once, and `answeredRequestsOf` renders
  only the requests of the unit's last wait, so a unit that waited twice is not told the
  first round's answers again.
- `plan.applied` and `plan.rejected` by a leader carry the actor `leader` and the unit id,
  and every reader of those events (`lastSituation` in the dispatcher and the planner,
  `lastCycleSequence`, the planner's section 9, the review's cycle verdict, `incident show`'s
  decisions) skips them, since a leader's apply mid-pass is not a cycle boundary.
- `unit.waiting` and `unit.resumed` are new event types, not named in the plan block, because
  a status change needs an event carrying its mutation; `user_version` stays 6, since no
  column changes.
- The `unit.close` mutation now closes any unit not already closed, so a plan can demobilize
  a waiting unit ("Closing is clean" only refuses an already closed one); "Units exist"
  still takes only an active unit for new work.
- Section 5 keeps an insufficient task's non-retrievable needs, which the leader is also
  expected to raise, so the planner may read one lack twice (section 5 and the report's
  requests in section 6) in the cycle it lands.
- `DispatchOptions` gains `providers`, the list a leader's assignments are validated
  against; the CLI does not set it, so Claude Code alone is used, as for a plan.
- Span of control and a parent's "Below it" line count every unit not closed, so a waiting
  child still counts and shows; "Units exist" still takes only an active unit for new work
  and names the unit's real status when it refuses.
- The IC assigns tasks under command like any leader (Mauria's ruling: a deterministic
  task belongs to whichever leader assigns it, command included): the root's `LeaderTurn`
  keeps `assignTasks`, and `IC_ROLE` says so; the other three kinds of lack the IC raises
  in its command turn, never as a leader's resource requests.
- A leader that assigns a task and asks a strike team for it in the same turn declares the
  team on the task's own `strikeTeam` field; `requestStrikeTeam` targets the task computed
  as next before the turn, so on such a turn it is refused as R3-5 records it.

## R3-8: Initial IC and transfer of command (#37, merged 2026-09-15)

R3-8 of the round 3 plan. Built: `incident create` runs the size-up. After the incident and
its root unit are written, the initial IC, a session on `--initial-model` (default
`claude-haiku-4-5`, checked against the models Claude Code serves) with the read-only tool
set (`Read`, `Grep`, `Glob`, `Bash` under the read-only allowlist), the preamble, the new
`initial_ic` seat and `INITIAL_IC_ROLE` (`src/size-up.ts`), reads the objective,
constraints, priorities and budget and the runtime's own findings, gathered in code before
the session runs (`gatherFindings`: the registered capabilities and equipment, the budget,
whether the cwd is a git repository and its root, branch, HEAD and changed-path count,
whether each URL a constraint names answers on one HEAD request with a five-second bound,
falling back to GET when the server refuses HEAD, and the models each provider serves), and
returns the `IncidentBriefing`: `kind`, `dominantProblem`, `obviouslyNeeded` (each `what`,
`checked`, and `finding` required when checked), `initialObjectives` (at least one),
`initialOrganization`, `questionsForHuman`, `hazards`, `incomingCommander` (`provider`,
`model`, `why`); one strict object, bounded at 300 seconds. The briefing is recorded as
`incident.briefed` (the root unit, the session, the initial IC's provider and model, `seat:
"initial_ic"`, cycle 0, the usage, the cwd, the findings and the briefing) and the session's
tool calls filed under the root unit and cycle 0 with the same seat. Command then transfers:
`command.transferred` with `kind: "initial"`, the outgoing session and leader, the incoming
leader with `incomingSessionId: null` (the IC's session starts at its first command turn;
`leader.started` follows), the briefing as `document`, `chosenBy` and `reason`; its mutation
is the new `unit.leader`, which sets the root unit's leader and replays. `Transfer` in
`src/ic.ts` is the one definition for both kinds, a union on `kind` over a common core
(`unitId`, `outgoingSessionId`, `outgoing`, `incomingSessionId`, `incoming`, `document`):
`initial` adds `chosenBy` and `reason`, `handoff` adds `contextTokens` and `threshold`; one
`recordTransfer` writes the `unit.leader` mutation for both, a no-op on a handoff whose
incoming leader is the unit's own, so every transfer replays the same way. R3-9 records its
handoff through `recordTransfer` with `outgoing` and `incoming` both the unit's leader, and
its incoming session evaluates the handoff document through the same trigger below. The incoming model
is the briefing's `incomingCommander` when Claude Code serves it, `--ic-model` when given
(now an override rather than a default), and `claude-opus-5` when the briefing names a pair
the provider does not serve. A question in the briefing becomes an incident question
(`question.asked` with `seat: "initial_ic"`) and the incident goes `blocked` before the IC
starts; `incident answer` reopens it as it reopens any block. `--no-size-up` creates the
incident on `--ic-model` or the default with no briefing and prints the R3-4 line. A size-up
that fails (the provider's error, or an answer that does not fit the schema, which
`sizeUp` returns unparsed so `create` parses it inside the same try and files the session
that answered, then a failed session that returned an id, the way `icCall` does) is filed as
`command.failed` with `seat: "initial_ic"` and `turn: "size-up"`, with the session's usage
and activity; the incident stands, unbriefed, on
`--ic-model` or the default, and `create` exits 1 saying so. `create` prints the briefing
line by line and the transfer; `incident show` prints the briefing's kind and dominant
problem and the transfer after the period.

A command turn with a transfer pending (`pendingTransfer`: the last `command.transferred`
is later than the last accepted `command.turned`; a rejected turn does not count, matching
`cycleOf`, so the retry of a rejected first turn evaluates again) renders the transfer's
document after the change report and before the incident file (for the initial transfer
`# Transfer of command: the initial IC's briefing`: who wrote it on what model, every line,
and `your model: …, chosen by …`; for a handoff the outgoing IC's document as written), and
its ask opens with the evaluation instruction naming what to judge (a briefing's objectives
and units, a handoff document's period objectives, unit states and next move); the turn is
taken under `FirstCommandTurn`, `CommandTurn` with the new `briefingEvaluation` (an array
of `{ item, verdict: accepted | rewritten | discarded, why }`) required and non-empty, so
the provider's own validation holds the IC to it. Every other command turn keeps the
optional field and the plain ask. `step` prints one `briefing: <verdict> <item>: <why>` line
per verdict after the rationale. `IC_ROLE` gains one paragraph:
the IC takes command from a briefing, the initial IC's or an outgoing IC's handoff document,
its first act is to evaluate it, and nothing in it binds it. `incident review` gains a
`size-up` block before the cycles (the initial IC's call with its usage, priced under the
role `initial_ic`; what the briefing said in numbers and the model it recommended; the
transfer with who chose the model; the briefing's questions; a failed size-up; the initial
IC's tool calls) and the line `briefing kept: a of n item(s) accepted, r rewritten, d
discarded` from the first accepted `command.turned` carrying an evaluation, or `briefing
kept: not evaluated yet`, `briefing: none (the size-up failed)` or `briefing: none (no
size-up)`; the size-up block and `incident show` list initial transfers only. The stub recognises the
size-up by its schema (`incomingCommander`), answers `NOSCOPE_STUB_BRIEFING` or a default
briefing naming `claude-opus-5`, logs the kind `size-up`, and adds one default verdict to a
command turn whose schema requires `briefingEvaluation` when the scripted turn carries none.
DESIGN.md Vocabulary (a row for the incident briefing and transfer of command), the ICS
mapping (a row for the initial IC and transfer of command, from ICS 201), Step 2 (the two
event types, the mutation, the failed size-up), Step 3 (the seat and the role text), Step 4
(the first briefing, `FirstCommandTurn`, `briefingEvaluation` and `IncidentBriefing` in the
schema blocks), Step 6 (the initial IC's usage and where its calls file), Step 7 (`create`'s
flags and `review`) and the Model choices table (the initial IC on Haiku; the IC routed per
incident) follow; `docs/architecture.html` gains the initial IC node and follows on the IC
node, step 1 and the system prompt; the README's environment paragraph names the size-up and
the new live test.

Tests (`test/size-up.test.ts`): `create` on the stub records the briefing, sets the IC's
model from it, writes the transfer with its mutation, and the log replays into a fresh store
with the same leader; the size-up call's model, tools, allowlist, system prompt, schema and
prompt (the runtime's findings rendered) are checked against the stub's call log; `--ic-model`
overrides the briefing, an unknown recommended model falls back to the default, and a bad
`--initial-model` is a usage error; `--initial-model` routes the size-up and `--no-size-up`
makes no call and gives the IC the plain first turn; a briefing question blocks the incident
with the question recorded, `step` is refused, `answer` reopens it, and the first command
turn then shows the question and its answer; the first command turn carries the briefing
section and the evaluation instruction, its schema requires the evaluation, the turn's
verdicts land on `command.turned`, and the second turn carries neither; `review` shows the
size-up block, the transfer, the initial IC's tool calls, the role total and the kept count
before and after the first turn; a failing size-up files `command.failed` and exits 1 with
the incident standing; an inline snapshot of the briefing section and the ask in the IC's
first briefing; `gatherFindings` on a plain directory, a fresh `git init` and a refused URL,
and `urlsIn`; the seat and role texts; a live test behind `NOSCOPE_LIVE=1` that sizes up the
noscope checkout read-only on Haiku and asserts a `kind`, an objective, a commander and the
git finding come back; a briefing that fails the schema's refinement (a checked need with no
finding, which the JSON schema sent to the provider does not catch) is filed as
`command.failed` with the session's usage and tool calls; a rejected first turn is retried
with the briefing section and the required evaluation, `step` prints the verdicts, and
review counts the accepted turn's; a handoff-kind transfer written through `recordTransfer`
keeps the leader, is the pending transfer, renders its document and the handoff ask, and
stays out of the size-up block and `show`. The models test counts 41 event types and covers
`IncidentBriefing`, `briefingEvaluation` and `FirstCommandTurn`. Every earlier test that calls `create` passes
`--no-size-up`, so those tests keep testing what they tested.

Observed in the live test (2026-09-15, Claude Code 2.1.272, the noscope checkout, objective
"where does this repository decide which model the Incident Commander runs on?"): Haiku made
19 tool calls in 80 seconds (`ls`, `find`, `Grep`, `Read`, and `grep` through Bash), 507k
input tokens of which 465k were cache reads, $0.16 at list price; it named the kind "an
investigation of model routing decision points", found the three decision points and their
precedence, recommended `claude-opus-5` because "this is subtle investigation, not a narrow
read", raised three questions for Mauria (two of them things it could not have found: why
this matters now, whether the defaults should change) and named as a hazard that an unserved
recommendation falls back to the default silently. One thing it did that the design says it
cannot: it ran `grep` through Bash, which is not on the read-only allowlist, and the call
succeeded; the transcript shows `is_error: false` on all four `grep` calls (verified from the
session transcript). The inference from that one run is that in `-p` mode `--allowedTools`
does not bound Bash to the listed commands on 2.1.272, or that Claude Code passes `grep` as
read-only on its own; either way the session's Bash was read-only in fact but not by the
policy as written. This is the provider's ground (R3-4 built the allowlist), not this PR's,
and is reported rather than changed.

Not exactly to spec, with reasons:

- The transfer's incoming session id is null on the initial transfer: the IC's session does
  not exist at `create`, it is created at the first command turn, and the plan's "the
  transfer from the initial IC's session to the IC's" is recorded as the outgoing session
  plus the incoming leader, with `leader.started` naming the session when it starts. R3-9's
  handoff, which creates the fresh session before recording, fills both ids on the same
  event.
- The evaluate-the-briefing instruction is in the first command turn's user message, and the
  schema requires the evaluation there, because a resumed call ignores `systemPrompt`; the
  role text carries the general rule in a sentence so a session started by R3-9's handoff
  reads it too.
- The root unit is created before the size-up, on `--ic-model` or the default, and the
  transfer sets its leader through the `unit.leader` mutation, so a failed size-up leaves a
  usable incident with the failure filed (`command.failed`) rather than an orphaned paid
  session and no incident; the plan block does not say what a failed size-up does.
- No schema migration: the briefing lives in the log (`incident.briefed`) and is read from it
  (`briefingOf`), and the root unit's leader column already existed, so the store stays at
  version 6 and an incident from before R3-8 has no briefing and gets the plain first turn.
- The size-up's usage is on `incident.briefed` and is not counted against the budget, like
  every seat above a task; it is in the IC's first change report's spend and in review's
  totals under `initial_ic`.
- The briefing's `incomingCommander.provider` is checked against `claude-code` alone, since it
  is the only provider; a briefing naming another provider falls back to the default the
  same way as an unserved model, with the reason on the transfer.
- `obviouslyNeeded` records whether a tool checked each need as `checked` plus `finding`,
  rather than the plan's "whether a tool checked it" alone, so the check's result is in the
  record; the refinement requires `finding` when `checked`.
- The size-up prompt tells the session the runtime's findings are checked and to cite rather
  than re-check them; the live run cited them and still spent 19 calls reading, so the role
  text (from the review) says a check is one look at whether a thing exists, answers or is
  where the objective says, and what the incident turns on is for the units to establish
  under the IC.
- The live test uses the noscope checkout itself, read-only, rather than a fixture repository;
  `test/fixtures/tree` is inside the checkout, so a fixture repository would need its own
  `.git`, which a checkout cannot carry.
## R3-9: IC handoff at the context threshold (#36, merged 2026-09-15)

R3-9 of the round 3 plan. Built: the IC is never compacted (every session runs with
`DISABLE_COMPACT=1`, R3-3), so the runtime hands command off below Claude Code's limit.
`prepareHandoff` in `src/ic.ts` runs before the command turn and before each review: it
reads the context of the IC's last call's last message from the usage it recorded
(`lastIcContext`: the new optional `Usage.contextTokens` on whichever of `command.turned`,
`plan.reviewed` or `command.failed` was last, counted only when that call ran on the root
unit's current session, and null when the call recorded none, so an unknown figure never
hands off; `parseClaudeCodeResult` sets it on every session's usage from the stream's
last `assistant` line, that message's uncached plus cache-write plus cache-read tokens,
because the envelope's usage is summed over the call's API turns: the live fixture's
three messages read 7,253 + 8,762 + 9,040 and its envelope says 25,055, while the last
message's context was 9,357) and, when it has reached `NOSCOPE_IC_HANDOFF_TOKENS` (`handoffThreshold`: default
120,000, read from the command's environment, refused with exit 1 when it is not a positive
whole number), resumes the outgoing session once under the `HandoffDocument` schema
(`period` with `objectives`, `priorities` and `why`; `units` with `unitId`, `state` and
optional `waitsOn`; `hypothesis` with `statement` and `claims`; `setAside` with `what` and
`why`; `nextMove`; one strict object, nested objects strict too) with `renderHandoffAsk`,
the seat-tailored ask (why: the context reached the threshold and the session is never
compacted; who reads it: a fresh session in the same seat under the same role text, briefed
with the document and the full file; what: the five things the plan block names, for a
successor that acts as the same IC with its context emptied and not as a stranger reading
the file). The session is then released through the log, `setUnitSession(root, null)` as
`leader.released` with the call's provenance and usage, `released`, the reason, and
`handoff` (`contextTokens`, `threshold`, `document`), in one transaction with the call's
activity. The next IC call starts a fresh session (`icCall` already does when the root has
none) under the unchanged `IC_ROLE`; its user message carries the transfer through R3-8's
path (`transferToEvaluate`: the transfer pending in the log, or the handoff in flight
before its transfer is written): after the change report, `renderTransfer`'s handoff
branch says who it takes command from, under the same role text, at what context, and
renders the document section by section (`renderHandoffDocument`); then the file, and the
ask opens with R3-8's evaluation instruction naming the document's items (each period
objective and priority, each unit's state, the hypothesis, each thing set aside and the
next move), answered in `briefingEvaluation` under `FirstCommandTurn`; before a review,
the same transfer and ask precede the draft and `ReviewTurn` and `FinalReviewTurn` carry
`briefingEvaluation` as an optional field, recorded on `plan.reviewed` (`reviewTurn`
already re-briefs a session with no id; it now takes the handoff too). The transfer is
R3-8's `Transfer` with `kind: "handoff"` (`unitId`, `outgoingSessionId`, `outgoing`,
`incomingSessionId`, `incoming`, both leaders the unit's, `document`, `contextTokens`,
`threshold`), written by R3-8's `recordTransfer` (the `unit.leader` mutation, a no-op
here) from `icCall`'s `started` with the successor's `leader.started`, the moment its id
is known, after `command.turned` or `plan.reviewed` in the same transaction;
`pendingTransfer` treats a transfer that names its incoming session as pending until an
accepted command turn, or a review that carried a `briefingEvaluation`, has run on that
session, so the successor evaluates once, on whichever call was its first, the next turn
is not asked again, and a review that skipped the optional field leaves the next command
turn to evaluate under the schema that requires it. `review`'s `briefing kept` line
counts only the first accepted turn after `incident.briefed`, so a handoff's verdicts are
never counted as the briefing's; `step` labels the verdict lines `briefing:` or
`handoff:` by the transfer's kind. `step` prints
the handoff (session, context, threshold), the
transfer after the successor's turn, a lost outgoing session, and a pending handoff
resumed. `incident show` prints `IC: <provider>/<model>, session <id or none yet>; N
transfer(s) of command`. `incident review` prices the handoff call under `ic` in its cycle
(`wrote its handoff after N tokens of context`), lists each `command.transferred` with its
kind, both sessions, the context that triggered it and the document's length in JSON
characters, followed by how its document was evaluated (`evaluated on its command turn`
or `review`: the counts by verdict and each item, or `evaluated: not yet`), and ends with
`transfers of command: N (kinds)`. The stub recognises the
document by its `nextMove` property, answers `NOSCOPE_STUB_HANDOFF` or a one-line default,
logs the kind `handoff`, ends every call with one answering `assistant` line whose message
usage carries the context (`input_tokens` is `NOSCOPE_STUB_IC_CONTEXT` or the next entry of
`NOSCOPE_STUB_IC_CONTEXTS`, counter file `NOSCOPE_STUB_IC_CONTEXT_COUNTER`, the last entry
repeating, on the IC's calls only; 1,000 otherwise; the envelope repeats the figures), and names a fresh session
`stub-session-N` when `NOSCOPE_STUB_SESSION_COUNTER` is set, so a test can tell the
successor from the outgoing session. DESIGN.md Vocabulary (cycle), Step 2 (the event, with
`command.failed` and `leader.released` now listed beside it), Step 3 (the compaction
sentence), Step 4 (the schema), Step 6 (the handoff paragraph and `contextTokens` on
`task.usage`), Step 7 (`show`, `step`, `review`), the Reference row on compaction and the
usage-per-call row follow; `docs/architecture.html` follows on
the IC node and cycle steps 2 and 4; the README names `NOSCOPE_IC_HANDOFF_TOKENS`.

Tests (`test/handoff.test.ts`): a run on the stub with the threshold at 5,000 where cycle
1's review runs at 6,500 tokens of context (the stub's `contextTokens`) and the next `step` shows the handoff call
resumed on the outgoing session (its prompt and schema pinned), the command turn on a fresh
session whose system prompt is the IC's and whose briefing carries the transfer and the
document between the change report and the file with the evaluation ask under
`FirstCommandTurn`, a new session id on the root unit, `leader.released` with the document
and the call's usage before `command.turned`, `command.transferred` (the full `Transfer`
with its `unit.leader` mutation) right after it and before `leader.started`, the transfer
consumed by that turn, `show` naming the new session with one transfer and `review`
pricing the handoff and listing the transfer with its evaluation; below the threshold two
steps make no handoff call, write no release or transfer and keep the session; a command
turn at 6,500 hands off before the review, whose fresh session is briefed with the
transfer and the document before the file and the draft and asked to evaluate under a
schema with `briefingEvaluation` optional, the scripted evaluation recorded on
`plan.reviewed` and listed by `review` as evaluated on its review, with `leader.released`,
`plan.reviewed`, `command.transferred`, `leader.started` in that order, and the next step
resumes the successor with the plain ask and schema; an outgoing session that cannot be resumed
is released with the reason and no document, no transfer is written, and the successor's
briefing opens with the change report; a handoff call that answers outside its schema
(`NOSCOPE_STUB_HANDOFF` without `nextMove`) is filed as `command.failed` with `turn:
"handoff"` and the call's usage, the session stays on the unit with no release and no
transfer, the step exits 1 printing nothing, and the next step retries the handoff on the
same session and completes it; `prepareHandoff` on a scripted store returns none
with no session, none below the threshold, a pending handoff after a release with a
document, none once a successor started, none when the last call recorded no
`contextTokens` however large its summed input, and none when the last IC call ran on
another session; the threshold's default, override and refusals, with the CLI's exit 1 on
a bad value; the document schema's strictness and its rendering. The providers test pins
`contextTokens` 9,357 on the live fixture and 1,500 on the stub, and that a trailing
subagent line is not read as the session's context.

Not exactly to spec, with reasons:

- The check runs before each review as well as at the top of the cycle, as the task
  message asks beyond the plan block: the command turn's own context is what the review
  would exceed, and the final read after a redraft is checked the same way, so no IC call
  runs on a session past the threshold.
- The handoff call's usage and the document ride on `leader.released` as well as the
  document on `command.transferred`: the release is the outgoing session's last act and
  the call that review prices (an IC call with no usage in the log would be an orphaned paid
  session, the rule R3-7's review set), and the transfer cannot be written until the
  successor's id is known. A cycle that ends between the two (or a first call returning no
  session id) leaves the handoff pending in the log, and `prepareHandoff` resumes it
  rather than asking the outgoing session, which is gone, again.
- `command.transferred` is written with the successor's `leader.started` whether or not
  its first call answered (`icCall`'s failure path records the session on the unit, R3-7),
  so a successor that answered badly is still the session command passed to and the next
  cycle resumes it rather than repeating the transfer.
- An outgoing session that cannot be resumed for its handoff (the call dies before the
  stream's init line) is released with the reason and no document, and no transfer is
  recorded: `icCall`'s replacement of a lost session would have asked a fresh session,
  which knows nothing, for the handoff. The next call starts on the file alone and `step`
  says so. A handoff call that fails otherwise is `command.failed` with `turn: "handoff"`
  and ends the cycle; the session stays and the next cycle retries.
- From the review (PR 36) at the rebase onto R3-8: the evaluation, first asked for in the
  command turn's `rationale`, is the `briefingEvaluation` field R3-8 gave the first
  command turn, extended as an optional field to both review schemas for a handoff before
  a review, so `incident review` lists every transfer's evaluation (on which call, the
  verdicts by kind, each item); and `command.transferred` is R3-8's one definition,
  written by its `recordTransfer`. `pendingTransfer` gained the incoming-session rule
  above because a handoff's transfer is written after the turn that consumed it, and the
  sequence comparison alone would have asked the successor to evaluate twice.
- The stub's usage fields were fixed (1,000 / 200 / 300 / 42) rather than set from the
  environment as the task message supposed; `NOSCOPE_STUB_IC_CONTEXT(S)` scripts the IC's
  calls only, so the planner's and leaders' usage in every existing test is unchanged.
- The threshold is compared as reached (`>=`), so the wording throughout is "reached".
- From the review (PR 36): the trigger first read `inputTokens`, the envelope's sum over
  the call's API turns, which runs at a multiple of the context and would have handed off
  near 60,000 of real context and then on every cycle; it now reads `contextTokens`, the
  last message's own input, recorded on every session's usage, and never falls back.
  `incident review` does not print `contextTokens` yet; the handoff line and the transfer
  line carry the figure that triggered them.
- The Reference row says the handoff is tested on the stub only and the threshold has not
  been reached live; no live test is added, since reaching 120,000 tokens of IC context
  would cost a long Opus session.

## R3-10a: A refusal replaces the session (#38, merged 2026-09-15)

Forced by the third live run (R3-10, 2026-09-15): the IC's review turn on Opus 5, a resumed
call over the planner's draft, came back from the API refused (`model_refusal_no_fallback`,
category `reasoning_extraction`), and the next step's command turn on the same session was
refused again in under a second; the runtime filed `command.failed` both times and would
have resumed the flagged session forever, since `icCall` and the dispatcher's `leaderTurn`
replaced a session only when a resume returned no session id. Built: the provider
(`refusalOf` in `src/providers/claude-code.ts`) reads the `model_refusal_no_fallback`
system line, or any line whose `stop_reason` is `refusal`, on exit 0 and on exit 1 alike,
and throws a `SessionError` carrying the session id (from the result, else the init line),
the refused call's usage from the result (`usageOf`, shared with the success path), its
activity and the new `refused: { category, explanation }` (`Refusal` in
`src/providers/base.ts`; `SessionError`'s fifth argument, null otherwise). `icCall` treats
a refused resumed call like a dead session: it files `command.failed` with the refusal and
the usage (`fileFailure`, now shared with the failure path), releases the session through
`leader.released` with `reason: "refused: <category>"` and the refusal, and asks a fresh
session the same turn (the command turn's briefing, or `reviewTurn`'s re-brief with the
file before the draft), whose `leader.started` names the refused session as `replaced`; a
handoff call refused becomes the lost-outgoing-session path, released with the reason and
nothing handed off. The dispatcher's `leaderTurn` does the same with the new event
`leader.failed` (unit, session, provider, model, seat, reason, refusal, usage). A fresh
session refused too is filed and ends the cycle or the pass with exit 1 and a message
naming the category, the replaced session and Claude Code's advice (rephrase the request
in a new session or change the model); a refused fresh session is not put on the unit, so
the next call starts fresh again. `incident review` prices a refused IC call in its cycle
with `(refused: <category>)` on the failed-turn line, a refused leader turn as `leader of
<unit> ...: turn failed (refused: <category>)`, and ends with `refusals: N: <seat> <category>
(session <id>), ...` or `refusals: none`. The stub refuses the calls `NOSCOPE_STUB_REFUSE`
names by ordinal (counted in `NOSCOPE_STUB_CALL_COUNTER`), printing the init line, the
system refusal line (`NOSCOPE_STUB_REFUSE_CATEGORY`, default `reasoning_extraction`), a
synthetic assistant line and a result with `stop_reason: "refusal"` and the call's usage,
then exiting 1, on the shape the run's log recorded. DESIGN.md Step 2 (the events), Step 6
(the rule) and the Reference table (the observed fact) follow.

Tests (`test/refusal.test.ts`): the provider on a refused stub call returns a
`SessionError` with the session, the refusal, and the usage including `contextTokens`
and cost; the IC's review refused on its resumed session is filed with the refusal and
usage, the session released with the category, a fresh session briefed with the file before
the draft answers, `leader.started` names the replaced session, the unit holds the new one,
`review` shows the refused turn and the refusals line, and the next step resumes the
replacement; refused twice, the step exits 1 with the category and the advice, both
refusals are filed, one release, no session on the unit, no review recorded, `review`
lists both, and the next step starts fresh and completes; a leader's turn refused on its
resumed session in cycle 2 is `leader.failed`, released, replaced by a fresh session whose
turn reports, and listed by `review`. The models test counts 44 event types.

Not exactly to spec, with reasons:

- The leader's failure event is new (`leader.failed`), since no event recorded a failed
  leader turn before (R3-4 recorded none and threw); it carries the refusal and the usage
  so review prices the call. A leader turn that fails for another reason still records
  nothing, as before.
- A refused first call on a fresh session (no session to release) is filed and thrown
  without the session going on the unit; before this PR a failed first IC call was
  recorded on the unit (`leader.started` with `failed`), which for a refusal would have
  resumed a refused session next cycle.
- The refusal's result line in the run's log has no `type: "result"` key (its first keys
  are `duration_api_ms`, `stop_reason`, `session_id`, `total_cost_usd`, `usage`), so the
  provider finds it by `stop_reason` on the exit-1 path and the stub prints that shape;
  whether the real line carries `type` is unknown (the log clips the reason at 200
  characters).
- A task refused inside a leader's session is not replaced at the task: it fails as a task
  with the refusal in its reason, and the leader's next turn on that session is what gets
  replaced.

## R3-10b: The session's read-only command list (#39, merged 2026-09-15)

Forced by run 003 (R3-10): the planner's first plan under the Sonnet IC gave its new unit a
Bash allowlist of `grep`, `rg`, `git log`, `git status` and `git diff`, and the validator's
"Effect policy" rejected all five as "not read-only", because the rule compared entries
against `READ_ONLY_COMMANDS`, the seven-command list `run_readonly` executes in process
(`ls`, `cat`, `head`, `tail`, `wc`, `find`, `stat`), and the planner was never shown the
list. Built: `READ_ONLY_SESSION_COMMANDS` in `src/equipment/builtin.ts`, the in-process list
plus `grep`, `rg`, `diff`, `pwd`, `which`, `basename`, `dirname`, `realpath` and the read-only
git subcommands as whole entries (`sort`, `uniq`, `tree` and `echo` were dropped in review:
each has a write form or needs a redirect, and none is worth much to an investigation;
`rg --pre` and `git --output` remain as accepted holes beside `find -exec`); the effect policy, `investigate`, the size-up, the root unit at `create` and the
provider's default allowlist use it; the planner's "Effect policy" rule text names the list
so a plan is never drafted outside it. `run_readonly` keeps the in-process list, since it
executes one binary and cannot take a two-word entry. DESIGN.md Step 3's built-in tool row
and Step 5's Effect policy row follow; tests derive their expectations from the list.

Not exactly to spec, with reasons:

- The list is a floor, not the fence: in print mode Claude Code permits read-only commands
  beyond the allowlist and denies writes regardless (the Reference row from R3-8), so
  widening it changes what the planner may declare and what the validator accepts, not what
  a session can do.
- `holdsCapability` treats a capability's read-only allowlist as held whenever the unit
  holds `Bash` and every entry is on the session list, so a unit a plan declared with a
  subset still runs `investigate` inside its leader under the unit's own allowlist; before
  this the leader rule "Capability held" would have refused it.

## R3-10: Third run (no PR; run 2026-09-15, written up in 29d4077)

R3-10 of the round 3 plan. The first incident's objective run live a third time with round 3
merged, on `~/.noscope/third-run.sqlite`, stepped by hand by the session running the build
while Mauria slept, and written up under "## Third run" in `docs/first-incident.md` with the
measures beside runs 001 and 002, the round-3 changes step by step, and what the run found
in the runtime. The acceptance holds: incident 002 reached `satisfied` in three command turns
with the same code path named (`PageCard.tsx:1884`); the IC amended the first draft and
approved the second; the root unit's picture-changing report ended the pass and the IC closed
the incident on it. $4.86 at list rates against $16.20 for run 002.

Not exactly to spec, with reasons:

- The run is two incidents. Incident 001's IC on Opus 5 was refused by the API on every
  resumed turn (category `reasoning_extraction`); the runtime looped on the flagged session,
  which PR 38 fixed, and a fresh Opus 5 session refused too, so incident 002 ran with
  `--ic-model claude-sonnet-5`, the override recorded on its transfer.
- The run forced a second fix: the effect policy rejected the first plan's unit for a Bash
  allowlist of `grep` and the read-only git subcommands, which PR 39 fixed.
- The size-up's two questions were answered by the operator as out of scope, as run 002's
  fixture questions were, and each answer says so.
- Strike teams, lacks at the leader, the handoff and a `not_met` report did not occur; the
  write-up lists them as not exercised.

## R4-8: The size-up scoped to the kind (#40, merged 2026-09-15)

R4-8 of the round 4 plan. Forced by run 003 (R3-10): both size-ups, on an objective that
asked to determine a cause and identify a code path, proposed a fix objective ("Implement
the fix to preserve sensible selection state", "Confirm that changing line 1884 … would
prevent the unwanted scroll") and a fix unit (`fix_designer`, `Plan`), and asked Mauria what
the intended behavior after a deletion should be; the IC discarded those items each time,
at the cost of a question round before it started. Built: prompt text and schema
descriptions, no mechanism. `INITIAL_IC_ROLE` (`src/size-up.ts`) gains one paragraph: the
objectives, the units and the questions follow from the kind of incident, and the kind
follows from the objective's verb; an objective that asks to determine, identify, explain
or find, or asks a question (where, what, why), is a diagnosis, answered by the cause or
the place it names, so it takes no fix objective, no fix unit and no question about what
the intended behavior should be, because the answer is the cause and the fix is another
incident unless the objective asks for it; an objective that asks to build, change, fix or
add is a build and takes those. The question sentence now says a
question for Mauria is only what no tool could find and the objective does not already
settle; R3-8's "a check is one look" sentence stands. The ask in `renderSizeUpPrompt` says
the objectives and organization are scoped to the objective's verb and repeats the question
rule. `IncidentBriefing` keeps every field; four descriptions say the same: `kind` is read
from the objective's verb (determine, identify, explain, find, or a question, is a
diagnosis; build, change, fix, add is a build), `initialObjectives` takes no fix objective on a diagnosis,
`initialOrganization` no fix unit, `questionsForHuman` no intended-behavior question and
only what no tool could find and the objective does not settle. DESIGN.md's Model choices
row for the initial IC, the preamble row's summary of `INITIAL_IC_ROLE` and the
`IncidentBriefing` schema block follow; `docs/architecture.html`'s initial IC node and the
README's list of live tests follow.

Tests (`test/size-up.test.ts`): the role pins the "a check is one look" sentence, the
diagnostic and build sentences and the question rule; the JSON schema sent to the provider
carries the three scoped descriptions; the rendered ask carries the scoping. A live test
behind `NOSCOPE_LIVE=1` sizes up a diagnostic objective on Haiku against the checkout it
runs in ("Determine why the Incident Commander runs on the model the briefing names rather
than --initial-model, and identify the code path that sets the root unit's leader at
transfer of command", the first incident's shape on code the size-up can read) and asserts
no initial objective or unit matches fix, implement, remediate or patch, and no question
mentions intended behavior.

Observed in the live test (2026-09-15, Claude Code 2.1.272, the noscope checkout): Haiku
made 19 tool calls in 72 seconds (`Grep`, `Read`, and `ls`, `find` and `grep` through
Bash), then wrote: kind "diagnosis"; a dominant problem naming `recordTransfer` in `ic.ts`,
`store.setUnitLeader` and the `unit.leader` mutation, and that `--initial-model` only ever
routes the size-up; four needs, all checked with the file and lines each check showed;
three objectives ("Determine where the incident briefing's incomingCommander field is
written and what value it carries", "Identify the code path from transfer of command
recording through store mutation application that sets the root unit's leader", "Verify
that --initial-model only affects the size-up session"); three investigation units, one per
flow (size-up, transfer, model selection), each a read on the small model; no questions;
three hazards on where the precedence hides; the small model as the incoming commander,
"a diagnosis with a read-only investigation scope". No fix objective, no fix unit, no
intended-behavior question, where run 003's two briefings had one of each. The test passes
the fake provider's model list, as R3-8's live test does, so the briefing named `fake-small`
rather than a Claude model. One run on one objective; the fourth run (R4-13, renumbered from R4-10 on 2026-09-15) is the measure.

Not exactly to spec, with reasons:

- The ask in `renderSizeUpPrompt` changed too, though the plan names only the role text and
  the schema: it is the one place the field list is rendered per call, and its old
  parenthetical on questions ("only what only Mauria knows or may decide") would have
  contradicted the role.

## R4-1: The work behind the report (#41, merged 2026-09-15)

R4-1 of the round 4 plan. Built: the IC's change report shows the work behind every
report, so the IC judges the leader's account against what the unit did. `renderReport` in
`src/ic.ts` renders each `unit.reported` since the IC last acted as a block headed by the
unit id and the report's event id (the id R4-2's verdicts answer it by), the report line as
before (outcome, picture changed, what changed on which claims, why and suggestion), then
"work since its previous report": the unit's tasks whose `task.completed` or `task.failed`
lies between the unit's previous `unit.reported` and this one, in the order they ended,
each as `task <id> (<capability>, <model>): <objective>`, then `claims:` as `id: subject
predicate (basis, confidence)` with the object left to the incident file's claims section
(a deterministic task's claims past the first three are listed by id only, since they are
observed at confidence 1 by construction and a wide grep would fill the block), then a
line for what it came to (a session result's `completed, answered; summary: …`, the
findings' `conclusion` or observation count when they carry no summary, the summary or
conclusion cut at 300 characters with an ellipsis since the file carries the findings;
`completed, insufficient; needed: …`; a deterministic result's `completed; result: N
line(s) of JSON, in the task record`; `failed: <reason>`). The claims come before the
ending so the block's cap falls on a summary's tail and never on the claims (run 003's
interpret task carried a 2,390-character summary and 13 claims, which the first cut of
this PR clipped whole). Then `tool calls:` by tool name with
counts from the `tool.called` events in that window filed under those tasks or under the
unit's own leader turns (no task, no cycle; the IC's own calls under the root carry a
cycle and are not counted as the root's work). Each task's block is clipped at
`NOSCOPE_REPORT_WORK_CHARS` characters (default 1,500; `reportWorkChars` reads it with the
same validation as the handoff threshold, now shared in `wholeNumberSetting`) and a clipped
block ends with `[+N chars clipped; the full record is task <id>]`, so the id is present
whatever the cap. The cap reaches the renderer from the IC call's `options.env` through
`renderCommandBriefing` and `renderBriefingBody`, so a fresh review session's briefing is
clipped the same way. Everything is read from the log: tasks from `task.create` mutations,
results from `task.completed` mutations, claims from `claim.create` mutations, so the
renderer needs no store. `incident show` prints "unit reports, the last of each unit, with
the work behind it" after the situation, one block per unit that has reported, clipped at
the same cap from the command's environment. `IC_ROLE` says a report is the leader's
account, the work beneath it is what to judge the account against, a change is as good as
the claims under it, a clipped block names its task id, and the file's claims section
carries each claim with its object clipped. DESIGN.md Step 4 (the change report's contents) and Step 7 (`show`), the
architecture page's IC node and step 1, and the README's environment list follow. Tests:
a snapshot of the change report with one reported unit showing a grep and an investigate,
their claims and `Read 2, Grep 1`, then a second report on the same unit showing only a
failed read and an insufficient interpret with the leader turn's `Glob 1`; a task over the
cap clipped with the pointer naming its id, the block before it exactly the cap, the
environment variable's parsing and the briefing reading it from the env; run 003's shape,
a 3,000-character summary over six claims at the default cap, with every claim id present
and the summary cut; a grep with six claims listing three and the rest by id; `show` printing
the block and clipping under `NOSCOPE_REPORT_WORK_CHARS`. The `reportedUnit` fixture in
`test/fixtures/models.ts` scripts the unit, its two tasks, claims, tool calls and report,
and `scriptedIncident` now returns its store.

Not exactly to spec, with reasons:

- The report line changed shape: `u-a: met; …` became `u-a, report <event id>: met; …`,
  since R4-2 keys `report.reviewed` on the report's event id and the IC has to be able to
  read it off the block. The event id is the store's UUID, so the run test in
  `test/ic.test.ts` reads it from the log rather than pinning it.
- Tool calls are counted per unit and report window, not per task, as the plan block
  says; a task's own calls are already listed per task in `incident review`.
- A deterministic result's "line count" is the line count of the result pretty-printed as
  JSON, since a deterministic result has no lines of its own (a grep's is a match list, a
  read's is one text field); the claims under the task carry its substance.
- A claim's object is not rendered at all, not even clipped to one line, since the plan
  block lists five fields and the incident file's claims section, which the IC reads in
  the same briefing, carries each claim with its object clipped in the cycle it lands.
- A session result's summary is cut at 300 characters and a deterministic task's claims
  past the first three are ids only, neither in the plan block: the per-task cap is for
  the claims the IC judges by, and run 003's interpret summary and grep match lists would
  otherwise take the whole block.

## R4-6: Session work leaves command (#42, merged 2026-09-15)

Forced by run 003 (R3-10, "Third run" in `docs/first-incident.md`): the planner put the
reproduce, the read, the grep, the investigate and the interpret directly under `command`,
so the built rule that a leader runs matching tasks inside its own session had the IC's
session take the investigate as an assignment, against the ruling that the IC's digging is
assigned, and the root's leader turn after each task ran five times at 60k to 115k context
for $0.94, more than the planner's two calls. Built: `runsInsideLeader` in `src/leader.ts`
returns false when the unit is the root, so a session-backed task under `command` runs in a
session of its own through `buildSessionRequest`, whatever its model and equipment, and the
IC's session runs no task. The root takes no leader turn at all: `dispatch` runs the root's
runnable tasks one after another with no `settle` between them (a deterministic one in
process, a session-backed one alone), and `leaderTurn` throws if it is ever asked for the
root; the pass's resumed-unit turn (the answers read before a unit runs) skips the root
too, so a store from before this PR holding a root that was answered out of `waiting`
runs its pass rather than throwing there. The root's pass ends without a report the way a unit's ends on a `continue` with
nothing left: once `nextIn` finds no runnable task under it, the root is marked done for
the pass and the loop moves to the next unit; `unitsOwingReport` excludes the root, so no
later pass asks it for a report either, and a pass with only the root's tasks makes no
provider call beyond the tasks' own. The IC judges the results at its command turn: the
change report (`renderChangeReport`) lists, after the unit reports, every task under
command that ended since the IC last acted, under "tasks under command, ended with no
leader to report them:", one block per task in the form of a report's work (R4-1:
`tasksCreated` and `mutationOf` find the task from the log, `describeClaims` its claims,
`describeEnding` how it ended, `clipBlock` cuts the block at `workChars` with the task id
as the pointer), so a session task reads as it would under a report: `completed, answered;
summary: …`, `completed, insufficient; needed: …`, or `failed: <reason>`. The one
difference from a report's block: a deterministic result's text is rendered whole under
the cap (`completed; result: <JSON>`) rather than as "N line(s) of JSON, in the task
record", since no leader reads the root's results and this block is the IC's only view of
them. The section is absent when none ended. `claimsUnder` in `src/ic.ts` is the
claims-by-task lookup both renderers share. The root's refused-resource-request path is gone with the turn: `leaderTurn`
no longer records `plan.rejected` under "Resource requests", the change report no longer
has "refused on your last leader turn under command", `step` no longer prints the root's
requests as refused, and the `resourceRequests` schema description drops its clause about
command. `IC_ROLE` and the IC's seat paragraph say that no task runs in its session, that a
task under command is deterministic and runs in process while a session-backed one placed
there runs alone, that either's result reaches it in its change report with no leader turn
between, that its tools serve no turn, that command files no report, and that every lack it
has goes through the command turn; the sentences that it runs a task under command as any
leader and is held to the leader rules are dropped, since it never sees a `LeaderTurn`. The
IC's deterministic assignments move from the root's leader turn to the command turn (ruled
2026-09-14: deterministic tasks belong to whichever leader assigns them, command included):
`CommandTurn` gains `assignTasks` (default empty); `validateCommand` makes them the
`createTasks` of the plan it checks the turn as, so Units exist sees their unit and Status
is earned refuses `satisfied` beside them ("satisfied while creating N task(s)", the state
the rule forbids the planner), and holds them to the other task rules a leader's
assignments pass (Units exist runs once, over the plan, so a bad unit is reported once),
to Own unit against the root and to a rule of the IC's own, "Deterministic only", which
refuses a session-backed capability with "the IC assigns deterministic work only, and
session work goes under a unit"; `applyCommand` creates them
last in its transaction with `plan.applied` by the actor `ic` (`IC_ACTOR` in
`src/leader.ts`) naming the root, the session the turn's first call may just have put on
it, and the task ids, and returns them for `step` to print as it prints a plan's; they run
in the same cycle's dispatch pass as root tasks and reach the next change report under the
"tasks under command" heading, except that one whose `dependsOn` names a unit's task runs
in the pass after that task completes: the root is first in tree order and is done for the
pass once its ready tasks have run, so the schema description and `IC_ROLE` say so rather
than "this cycle's pass" alone (the loop is left for R4-9's rewrite). The planner's cycle window (`lastCycleSequence`) and
review's per-cycle verdict skip the `ic` actor as they skip the leader's, and review lists
"IC assigned N task(s) under command" in the cycle. The planner's section 9
gains, after the rules, "warned on, and applied anyway:" with `PLANNER_WARNINGS` (one line,
"Session work under a unit": session work belongs under a unit with a leader, never under
command; one placed there runs alone with no leader to judge it, and a deterministic task
under command is fine) and, after "rejected last cycle:", "warned last cycle:" with the
`plan.warned` events of the last applied plan (recorded before `plan.applied`, so the
window opens at the plan applied before it) when that plan was last cycle's; when the last
cycle rejected its plan, the window opens at the last applied plan and shows nothing,
since a rejected plan records no warnings and the earlier plan's would otherwise repeat
under the label. The validator's `Verdict` on a passing plan
carries `warnings`; `WARNING_CHECKS` in `src/validator.ts`, keyed by the warning's name
before the colon as the rules are, flags each new session-backed task whose unit is the
root; `validateAndRecord` records one `plan.warned` per warning (rule, reason, rationale)
in the transaction that would have recorded rejections, and `step` prints each after "plan
approved" as "warned, applied anyway: <rule>: <reason>". A leader's assignments carry no
warnings. `plan.warned` is the 45th event type. DESIGN.md Step 2 (the event), Step 3 (the
seat paragraph and role text row), Step 4 (the change report), Step 5 (the IC's lacks and
the warning table), Step 6 (the root's dispatch) and `docs/architecture.html` follow.

Tests: a dispatcher test where a grep and an investigate on the root's leader's model, with
the root's equipment, run under the root: the investigate runs in its own session under the
capability's role text with no leader prefix, the stub is called once, no `leader.started`,
`unit.continued` or `unit.reported` is written, the root keeps no session, the pass ends
with both tasks completed and no report, the change report lists both results under
command after the unit reports (the grep's claim and its result text, the investigate's
`completed, answered; summary:`), and a second pass runs nothing and calls nobody; a
dispatcher test that a root answered out of `waiting`, as only a pre-R4-6 store can hold,
runs a pass with no call; an IC test that a failed read and an insufficient interpret
under command reach the change report as `failed: no such file` and `completed,
insufficient; needed: observation: …`, and that a grep with twenty matches fits at the
default cap and is cut at 200 characters with the pointer naming its task; a command
turn declaring `satisfied` beside one grep is rejected on Status is earned ("satisfied
while creating 1 task(s)") and a grep under a unit that does not exist draws Units exist
once and Own unit; a unit
test that the same investigate runs inside a led unit's leader and never inside the root,
and that a failed task leaves the led unit owing a report and the root not; a validator
test that a plan with a grep and an investigate under the root and an investigate under a
unit passes with one warning naming the investigate under the root, records one
`plan.warned` with the rationale and no `plan.rejected`; the planner snapshot shows the
warning text and, since its fixture's last cycle rejected its plan, "(nothing warned)",
with a second test showing the warning under "warned last cycle" while the warned plan is
the last cycle's and none once a rejection follows;
the providers test pins the new IC sentences and that "as under any leader" and the leader
rules are gone from `IC_ROLE`; an IC test where the first command turn assigns a grep under
command: `step` prints the assignment and the task, the grep runs in the pass with no
leader call (the stub sees command, planner, review), `plan.applied` by `ic` names the
root, its session and the task, the planner's section 4 still opens at the last plan, the
next briefing lists the grep's result under "tasks under command" and in section 4, and a
second command turn assigning an investigate under command and a grep under a unit that
does not exist is rejected on Deterministic only, Own unit and Units exist with nothing
created. The dispatcher tests of a leader's turns
(inside-the-leader runs, the replaced session, strike-team requests, the failed leader, the
retrievable-fact assignment, the refused assignment, the malformed continue) moved from the
root to a unit under it (`led()` in `test/fixtures/models.ts`, the root's equipment and
allowlist), since the root no longer has the behaviour they test; the blocking test of an
insufficient interpret likewise creates a unit in its first plan, and its lack now reaches
that unit's leader in its session.

Not exactly to spec, with reasons:

- The IC takes no leader turn at all, not only after session tasks, per the orchestrator's
  brief (the root has no leader turns; the IC judges at its command turn). The block's "the
  IC's own assignments under command stay deterministic" is kept by moving the assignments
  from the root's leader turn to the command turn (`assignTasks` on `CommandTurn`), held to
  the task rules, Own unit and Deterministic only rather than to the leader's three rules
  (Capability held is moot for deterministic work; Budget within share is not applied,
  since the root has no plan share of its own to assign inside).
- The role text drops more than the one sentence the block names: the paragraph telling the
  IC to assign on a leader turn under the leader rules and that its resource requests are
  refused described calls that never happen; the assignment sentence is restated for the
  command turn.
- The warning is recorded as an event (`plan.warned`) rather than held only on the verdict,
  because the planner reads the log and nothing else; "warned last cycle" needs the record.
- The root's refused-request rule ("Resource requests" under `plan.rejected` by the actor
  `leader`) is removed rather than kept dormant: no code path can reach it.

Review (PR 42, 2026-09-15), applied before merge: the command turn's assignments had been
checked outside the plan the turn is held to, so `satisfied` beside an assignment passed
(fixed as above, with the test); the under-command block had rendered a result in full
through `renderTaskResult`, unclipped, and an insufficient session result as its JSON
with no `needed` callout (rebuilt on R4-1's renderers as above); the schema and role text
said a dependent root task runs in this cycle's pass (reworded); the resumed-unit turn
could reach `settle(root)` on a pre-R4-6 store (guarded); "warned last cycle" repeated
the previous applied plan's warnings after a rejected plan (narrowed); DESIGN.md Step 5
sent a fact the IC lacks only through a period objective where `IC_ROLE` also offers a
deterministic task under command (aligned).

## R4-7: Refusals: the category, and the fallback to Opus 4.8 (#43, merged 2026-09-15)

R4-7 of the round 4 plan. Two things the third run left open. The category: run 003's
`command.failed` events recorded `refused: { category: "unstated", explanation: "" }`
while the IC sessions' transcripts (`cf551f26`, `a30d1d7f`) carry
`apiRefusalCategory: "reasoning_extraction"` on the same `model_refusal_no_fallback` line.
The cause, read from Claude Code 2.1.272's own code on 2026-09-15: the binary serializes
that system message for the SDK stream with snake_case keys (`api_refusal_category`,
`api_refusal_explanation`), and writes the transcript record with camelCase ones; R3-10a
read the camelCase names off the stream, found the line, and took the missing field as
`unstated` with an empty explanation, which is exactly what the events show. The run's raw
stream was not captured, so the stream's spelling is verified from the code and inferred
from the events, not seen live. Built: `refusalOf` in `src/providers/claude-code.ts` takes
the call as refused on the system line or a result envelope whose `stop_reason` is
`refusal`, never on the synthetic assistant frame alone, since the binary's own
`model_refusal_fallback` routing delivers the refused leg's assistant frame ahead of a
successful result on its fallback (review finding; inferred from the binary's schema
descriptions, not seen live). The category is read from the system line under either
spelling, then the assistant frame's `stop_details` (the transcript's synthetic assistant
message carries `category` and `explanation` there, and the binary's own refusal reader
uses it), and, when the stream still names no category and the session id is known, the
session's transcript under the project directory (`readTranscriptRefusal`, the path R3-1's
provider already resolves); `unstated` remains only when no record names one. The stub
prints the snake_case line and `stop_details`, as the stream does. The Reference row records the two spellings and that Claude Code has a
refusal fallback of its own (`model_refusal_fallback`), which the run's sessions did not
have.

The fallback, ruled by Mauria in review on 2026-09-15. `fallbackModel` in `src/leader.ts`
reads `NOSCOPE_IC_FALLBACK_MODEL` from the command's environment, default
`claude-opus-4-8`, refused when the provider does not serve it. Every refused seat retries
once on it, and no seat retries beyond that. The IC (`icCall` in `src/ic.ts`): the refused
call is filed (`command.failed`), its session released when it was resumed, and command
transfers to the fallback as `command.transferred` of kind `fallback` (R3-8's `Transfer`
union gains the kind: the refused calls as `refusals`, the outgoing and incoming leaders,
`chosenBy: "runtime"`, no document; `recordTransfer` changes the root unit's leader through
the log, so every later IC call stays there); a fresh session on the fallback is asked the
same turn, and its `leader.started` names the refused session as `replaced` and
`fallbackFrom`. A fallback transfer is never pending for evaluation (`pendingTransfer` skips
it), and a handoff recorded by a successor that fell back keeps the fallback as its incoming
leader. Refused on the fallback too, or refused after a fallback
transfer already exists (the IC's model was changed once, by the runtime or by an answer),
`blockOnRefusals` asks a question naming every refusal (`question.asked` with
`icRefusals`), blocks the incident (`incident.blocked` with the same) and throws
`IcRefused`, which `step` and `run` print as the blocked incident, the question and the
`answer` command, exiting 0 as a plan's question does. `holdsOn` in `src/runtime.ts` gains
the hold "the IC's model" (`icModelHold`: the last `incident.blocked` carrying `icRefusals`
with no transfer after it). While that hold stands, `incident answer` answers the question
the refusals raised (`icRefusalQuestionId`: the one the last `question.asked` carrying
`icRefusals` asked), not the oldest open question, so a unit leader's older question does
not swallow the model name (review finding); it parses the text for a model in the
provider's list as a whole word; found, it records the transfer (`chosenBy: "answer"`, the
refusals carried) before answering the question, so the incident reopens on that model; not found,
the answer is stored, the same question is asked again under the next id, and the incident
stays blocked with a hint listing the models. A unit leader (`leaderTurn` in
`src/dispatcher.ts`): the refused turn is filed as `leader.failed` carrying `fallback` and
the mutation `unit.leader` to the fallback model, the session released, and a fresh session
on the fallback asked the same turn; refused there too, or refused when the unit's leader
already is the fallback, the runtime writes the unit's report (`reportRefusals`:
`unit.reported` by the dispatcher's actor with `writtenBy: "runtime"` and the `refusals`, a
null session, `not_met`, both refusals as the why, the IC's choices as the suggestion,
picture-changing), and the pass ends on it. A task session (`runTask`): the refused call is
filed on the task as `task.usage` carrying the refusal, the model and the fallback, plus its
activity (`unitShare` in `src/leader.ts` sums every `task.usage` of a task, so the refused
call counts against the unit's share as it counts against the incident budget; review
finding), and the task is retried once in its own session on the fallback whatever the
first call ran in, and a first call refused inside the leader's resumed session releases
that session there (`leader.released` with `refused: <category>`, as a refused leader turn
does; review finding), so the leader's next turn starts fresh instead of paying a refusal
the runtime already knows is coming; `task.completed` and `task.usage` then carry `model`
and `fallbackFrom`;
refused there too, or refused when the task's own model is the fallback, `TaskRefused`
carries both, `task.failed` records `refusals` with both and the models, and `dispatch`
writes the same runtime report for the unit instead of asking its leader, ending the pass;
under the root, which has no leader to report for it (R4-6), the task's failure stands on
its own, the pass goes on to command's next task, and the change report's "tasks under
command" block (R4-1's `describeEnding`) lists it as `failed: refused on ...`, ruled by
the orchestrator in review: command files no report.
`incident show` lists every model change under "model changes:"; `step` prints a fallback
transfer under the turn that forced it; `incident review` lists a fallback transfer with its
models, chooser and refusals (no evaluation lines), a leader's refused turn with its move
to the fallback, a task's refused call priced and named with the model it was retried on, a
retried task's outcome with `fallback from`, the runtime's report as such, and the refusals
line now names each call's model and includes task sessions. DESIGN.md Step 2 (the events),
Step 6 (the rule), Step 7 (`show`, `step`, `run`, `review`, `answer`), the Reference row
and the Model choices table follow; README and CLAUDE.md name the variable, and CLAUDE.md
no longer says to pass `--ic-model claude-sonnet-5` as the only way around the refusal.

Tests (`test/refusal.test.ts`): the provider yields `reasoning_extraction` from a stream
whose system line uses either spelling, and from a stream carrying only the stop reason
beside a transcript fixture under a scratch project directory (and `unstated` without the
transcript); the IC's review refused on its resumed session is filed, released, transferred
(kind `fallback`, the refusal as reason), reviewed by a fresh session on `claude-opus-4-8`
whose `leader.started` carries `fallbackFrom`, the unit's leader changed, `show` and
`review` naming the change, and the next command turn resumes it on the fallback; refused
on the fallback too, the incident blocks with the question carrying both refusals, that
`step` exits 0 and the next exits 5 on the blocked incident, an answer naming no model is
stored and re-asked with the hint, an answer naming Sonnet 5 transfers command (chosen by
`answer`) and reopens, a refusal on Sonnet
blocks again on one refusal (the fallback already tried), an answer naming Haiku runs the
cycle through, and `show` lists the three changes; a leader refused on its resumed session
moves to the fallback on `leader.failed` (the mutation checked), its fresh session reports
on `claude-opus-4-8`, and `review` names the move; a leader refused on the fallback too has
its unit report `not_met` by the runtime with both refusals, the pass stops, `review` lists
the runtime's report and both refusals, and the IC's next change report carries it; a task
in its own session refused is retried on the fallback with both models on its events; a
task refused on both fails with both, the unit reports by the runtime, and no leader turn
is asked; a task refused inside its leader's resumed session releases it, and the leader's
turn after the retry starts fresh; a root task refused on both fails with both refusals,
no report is filed, the pass runs command's other task, and the change report lists the
failure under the tasks under command; `NOSCOPE_IC_FALLBACK_MODEL` is validated against
the provider's list.

Rebased over R4-6 in review: the root takes no leader turn, so `leaderTurn`'s root
branches (the `seat: "ic"` filing, the transfer on the root's `leader.failed`, the block
on the root's second refusal) were dead and are deleted; `blockOnRefusals` is `icCall`'s
alone; the runtime's `not_met` report for a task refused twice is written on the unit
path only.

Not exactly to spec, with reasons:

- The stream's spelling of the category key is read from the binary's code, not observed
  on a live refusal: a refusal cannot be provoked deterministically, and R4-13's run (the fourth run, renumbered from R4-10) is
  where it will be seen. The provider reads every spelling and the transcript, so whichever
  record carries the category reaches the event.
- A second refusal of the IC ends `step` and `run` with exit 0 and the blocked incident,
  not exit 1 as R3-10a's second refusal did: the outcome is now in the record (the
  question and `incident.blocked`), which is what exit 0 means for a plan's question, and
  exit 1 is for a failure outside the record.
- "Refused on the fallback" is read as "the seat's fallback has been tried": for the IC any
  fallback transfer on the incident, including one Mauria's answer chose, so a refusal on
  the model she named blocks again on that one refusal rather than retrying Opus 4.8 a
  second time; for a leader or task, the seat's model already being the fallback. The
  question then names the refusals that call sequence filed, one or two.
- A task refused inside its leader's session is retried in its own session on the fallback,
  not inside the leader (the leader's session is on the refused model and is itself flagged),
  and the leader's session is released with the refusal, so its next turn starts fresh on
  the unit's own model rather than resuming the flagged session; the leader itself does not
  move to the fallback, since its own turn was not refused. R3-10a had such a task simply
  fail.
- An answer naming no model re-asks the question under the next id rather than leaving the
  first unanswered: the answer is a record of what Mauria said, and an open question is
  what `incident answer` acts on, so the hold "the IC's model" and the re-asked question
  together keep the incident blocked until a model is named.
- A refused handoff call stays the lost-outgoing-session path (released, nothing handed
  off) rather than a fallback: the handoff asks the outgoing session what it knows, and a
  fresh session has nothing to hand off; the fallback applies to the successor's first
  call when that is refused.
- Review's refusals line gained the model (`ic reasoning_extraction on claude-opus-5
  (session ...)`), changing R3-10a's format, so that a refusal on the fallback reads
  differently from one on the primary model.

## R4-9: Parallel dispatch (#44, merged 2026-09-15)

R4-9 of the round 4 plan. Built: `dispatch` in `src/dispatcher.ts` runs the passes of
unrelated units at once and, inside a unit, starts every runnable task that is not inside
the leader's session together. Two units are related when a task of one that has not ended
names, in `dependsOn`, a task of the other that has not ended, either way round
(`relatedUnits`, read from the store's tasks before each scheduling round, so a task a
leader assigns mid-pass with a cross-unit dependency relates its units from the next
round on; a dependency already completed, failed or cancelled orders nothing, and a
parent and a child are related only through their tasks). A unit's pass starts when the
unit has something to do (a resumed leader to brief, a runnable task, a report owed), no
unit related to it is mid-pass, and fewer than
`NOSCOPE_PARALLEL` passes are running: a positive whole number read from the command's
environment (`options.env`, `process.env` when absent), 3 when unset, refused otherwise
with the same shape of error as `NOSCOPE_IC_HANDOFF_TOKENS`; related units keep tree
order, so `NOSCOPE_PARALLEL=1` is the round 3 dispatcher. The scheduling loop starts what
can start, waits for a pass to end, and looks again, which replaces round 3's outer
re-visit of units whose cross-unit dependencies completed mid-pass. Inside a unit, the
leader's session takes one call at a time: a task that runs inside it (`runsInsideLeader`)
and every turn queue on one promise chain, and at most one inside task is in flight or
awaiting its turn at a time, so inside tasks keep round 3's shape (task, turn, task, turn)
while the tasks in sessions of their own, and the deterministic ones, start the moment
they are runnable. Every ending lands in a queue and reaches the leader on a turn of its
own, in the order the tasks ended (`settle` per ending, as before); the turn's prompt
(`renderTurnPrompt`, new `running` and `landed` arguments) lists the unit's tasks still
running in sessions of their own (the tasks in flight; an inside task queues on the
leader's chain as a turn does, so at a turn it has landed or not started) and, apart from
them, the tasks that landed while the turn waited and reach the leader on turns of their
own ("Ended already"); when nothing is left to start but tasks are still running or still
to be heard it asks the leader to continue and wait or report now, rather than for its
report, so the stub's default turn keeps continuing until the last ending is heard. A
leader that reports while its own tasks are in flight ends the unit's pass; the tasks land
(their events are written) and get no turn. Every ending the leader has not heard
(`endedSinceLastTurn` in `src/leader.ts`: tasks of the unit that completed or failed after
its last `unit.reported` or `unit.continued`, a pass that died included; inside-ness from
`runsInsideLeader`) is computed once at the top of the unit's next pass and rides on that
pass's first turn whatever its cause (`renderTurnPrompt`'s `unheard` argument, rendered
before the cause as "Since your last turn these tasks also ended:" with `renderEnding`),
so a unit with a runnable task next pass hears them on the turn after that task, and a
unit with nothing to run hears them on its owed turn: `TurnCause` gains `{ status:
"owing" }` in place of `null`, carrying nothing itself. The runtime's report after two
refusals (`writtenBy: "runtime"`, R4-7) is not a turn: `endedSinceLastTurn` and
`refusedSinceLastTurn` skip it when placing the cutoff, so the endings and validator
reasons a leader never read survive it and ride on its next real turn (a new task, or
the IC's revise once R4-3 lands); `unitsOwingReport` still counts it as the report it is,
so the dispatcher does not ask a refused seat again on its own, and the change report
lists those endings under the runtime report meanwhile. A report
whose `pictureChanged` is true, or a budget stop, sets the pass's halt: no pass and no
task starts after it, every run in flight finishes and lands, and a task that lands after
the halt still gets its leader's turn (the leader hears the ending; nothing starts from
it), so a result is never left unread; `dispatch` returns once every pass has landed its
runs, with the first halt (`pictureChanged` names the first such unit). The budget is
checked before every start (`budgetRoom`): a task that does not fit what is spent stops
the pass with `budget.exceeded`, round 3's test and reason; a task that fits what is spent
but not what is spent plus what the tasks in flight are held to (`reservationFor`: the
task's own bound or the capability's typical cost) is deferred, left unattempted for the
sweep after the next landing anywhere (a dispatch-wide promise replaced on every
landing), so concurrent starts cannot overrun the budget together and a reservation never
stops an incident, since `incident run` ends on any stop and the planner reads
`budget.exceeded` as the budget having stopped the pass. A pass with a deferred start and
nothing of its own in flight waits on that promise rather than ending. A leader that
cannot answer, or a run that throws past `runOne`, sets the halt (the rejection callback
itself, so a pass mid-turn when the run threw cannot start a task on its next sweep), and
the error is thrown once every pass has landed its runs, so nothing writes to the store
after `dispatch` returns. `failInterrupted` keeps its job, since a pass lands every run
before it returns. `Dispatched.ran` is in landing order. `LEADER_ROLE` says tasks in
sessions of
their own start at once and `dependsOn` is what serializes; the report's `pictureChanged`
description and the role text say the IC acts before anything new starts, not before the
next unit; the planner's preamble says independent tasks run at once across units and
within one, only tasks inside a leader's session one at a time, and that `dependsOn` is
declared where a task needs another's result and nowhere else. `incident review` prints,
under each cycle's tasks, `wall time: cycle N s, dispatch N s; K task(s) summing N s,
parallel Rx` (`wallTimeLine` in `src/review.ts`): the cycle from the event that opened it
to its last event, the dispatch span from the first `task.started` to the last task ending
or leader turn, the tasks' recorded seconds summed, and `parallel` the sum over the span,
1.0 in sequence and higher when tasks overlapped. The stub gains `NOSCOPE_STUB_SLEEP_IF`,
which narrows `NOSCOPE_STUB_SLEEP_MS` to task calls whose prompt contains the text (a
task's objective, in the tests), so one task of a pass is slow and the rest are not; its
`concurrent` figure in the call log is a bound, not a measure (two stub processes started
4 ms apart each saw none running). DESIGN.md Step 6 (dispatch, the owed turn, the budget
check, the strike-team request's target), Step 7 (the review row) and the Speed section
follow; `docs/architecture.html` follows on the dispatcher node, cycle step 7 and the
speed line; README and CLAUDE.md list `NOSCOPE_PARALLEL`.

Merged after R4-6 and R4-7, which land in the pass as follows. The root (R4-6): its
resumed branch is skipped, an ending of its gets no turn (`continue` before `settle`), and
its pass ends with `done.add` once its runs have landed, so with `runsInsideLeader` false
for the root every root session task starts at once in a process of its own and the IC
reads the results in its change report. Refusals (R4-7): `runIt` carries `runOne`'s
`refusals` on the landed ending (`Landed`, a `TaskEnding` with optional `refusals`), and
the loop, before `settle`, files the runtime's `not_met` report on the unit
(`reportRefusals`, pushed with `sessionId: null`), marks the unit done and halts with
`pictureChanged` naming it; a root task refused twice ends as its `task.failed` under the
tasks under command, as R4-7 built it. That refusal report is filed even when the leader
reported earlier in the pass (the ending landed after the report), since the IC decides
on refusals with its verdicts; the unit then has two reports in one pass. A leader's own
fallback (R4-7, `setUnitLeader` inside `leaderTurn`) changes `unit.leader.model` mid-pass
through `settle`'s returned unit, so `runsInsideLeader` flips for the unit's tasks not yet
started (planned-inside tasks run in sessions of their own, at once), the one-inside-task
gate evaluates against the new leader, and `endedSinceLastTurn` renders an ending that ran
inside the old session as an outside one; accepted as is. Two tests that ran inside tasks
under the root moved onto the `led()` unit, since the root takes no turn.

Tests: two independent units on the stub with sleeping sessions run at once (the second's
`task.started` precedes both `task.completed` by sequence and by timestamp, and the same
run with `NOSCOPE_PARALLEL=1` writes the same events per unit in the same order and the
same multiset overall); a picture-changing report from one unit ends the pass while the
other's task in flight completes, its leader hears the ending on a turn after the stop,
and the task that completion made runnable stays pending; with `NOSCOPE_PARALLEL=2` three
independent units run two at a time (no stub process ever saw more than one other, the
second task started before the first completed, the third after the first report); inside
a unit, two tasks in their own sessions start together, a `dependsOn` serializes the third
behind the first, and the turn after the fast one lists the slow one as still running and
asks the leader to continue or report rather than for its report; two tasks inside the
leader's session run one at a time, each followed by its turn; a leader that reports while
its own task runs leaves the task to land without a turn, and the next pass's owed turn
renders that ending before asking for the report; a runtime report after two refusals
(t-dep refused on its model and the fallback in pass 2, `NOSCOPE_STUB_REFUSE`) leaves
t-slow's and t-dep's endings unheard, and a third pass with a new task carries both on
that task's turn; a task that landed after its unit reported, whose completion made a
dependent runnable, reaches the leader on the next pass's first turn, the one on the
dependent's ending, and nothing is owed after that report; a task that landed while a
turn was queued behind a slow inside task is listed on that turn as ended already, not
running, and gets its own turn next; a task in flight is
held against the budget, so a second unit's task that fits by spend but not by reservation
waits for the landing and is then stopped on what is spent, with one `budget.exceeded`
after the first task's `task.completed`, while the first's leader still hears it; two
units whose tasks fit one at a time by spend but not by reservation both run, the second
starting after the first lands, with nothing stopped; `NOSCOPE_PARALLEL=0` is refused. The
round 3 dispatcher tests that read as a sequence now declare it: the grep, investigate
and interpret test and the strike-team test chain their tasks with `dependsOn` (and so
also pin that a chain still serializes: `task.ready` per dependent, the same call order as
before), the two-unit picture-change and waiting
tests and the IC's picture-change step test run with `NOSCOPE_PARALLEL=1`, and the root
unit's refused-request test chains its two greps. The review test pins the wall-time line
once per cycle that ran a task; the preamble tests pin the new sentences of `LEADER_ROLE`
and the planner prompt.

Not exactly to spec, with reasons:

- The cap bounds unit passes, as the plan says, and not processes: a unit with several
  independent session tasks starts them all, so the number of Claude Code processes can
  exceed `NOSCOPE_PARALLEL`; a unit with N independent session tasks spawns N+1 processes
  (its leader's and one per task), and with R4-6 the root's session tasks run in sessions
  of their own too. The plan's own task count and budget bound that side; a process cap is
  a follow-up, noted in review.
- The plan says a picture-changing report ends the pass "and the others finish the task in
  flight"; here the leader of a task that lands after the halt is also asked its turn on
  that ending, because the owed turn is the only other way the result would reach it, and
  a turn is not a task start. A task that lands after its own unit reported gets no turn,
  and the first turn of the unit's next pass carries it, whatever that turn is for; round
  3's owed turn said only that the unit had not reported, and never rendered the result,
  which parallel dispatch would have made a common way to lose one.
- A leader's `requestStrikeTeam` targets the task that runs next, which under parallel
  dispatch is a task not yet started: one still waiting on a dependency or one the leader
  assigns on the same turn. A task with no dependency has started already by the time the
  leader is asked anything, so a request made after it is refused as having nothing to
  send it on, as R3-5 already provided for.
- A leader is asked about each ending on a turn of its own, never about several at once,
  so the events of a parallel run are the events of the sequential run reordered; a turn
  that reads several endings would have been a schema and prompt change the plan did not
  ask for.

## R4-2: Report verdicts (#45, merged 2026-09-15)

R4-2 of the round 4 plan, on R4-1's ground, rebased onto R4-6, R4-7 and R4-9. Built: the IC answers every report with a
verdict, Mauria's ruling of 2026-09-15 that the IC reviews a unit's work when it comes in
and decides whether the unit is done, goes back for revision, or hands its slice to a
different unit. `CommandTurn` gains `reportVerdicts`, an array of `ReportVerdict` (a strict
object: `reportId`, the `unit.reported` event id as the change report heads the report;
`unitId`; `verdict`, `accepted` | `revise` | `reassign`; `instructions`; `why`), required
in the schema so the provider's own validation asks for it, with a refinement after parse
that refuses instructions on an accepted verdict and requires non-blank instructions on a
revise or reassign. `closeUnits` stays for units closed without a report. The reports a
turn must answer are `reportsAwaitingVerdict` in `src/leader.ts`: every `unit.reported`
after the last accepted `command.turned`; `latestReports` picks each unit's last of them,
the one its verdict answers. The change report's "unit reports:" now lists that window
(before, the reports since the IC's last turn of any kind, which dropped a rejected turn's
reports from the retry's briefing), a unit's earlier report in it marked `[an earlier
report this window; the verdict answers report <id>]`. The validator's `validateCommand`
gains the rule "Reports answered" (a `CommandRuleName` beside "Answers match"): each
verdict names a unit's last report in the window and that unit, a unit's earlier report
is refused by name with the id its verdict answers, no report has two verdicts, no
reporting unit is left without one, and no reported unit is in `closeUnits` as well (an accepted or reassigned unit is closed by its
verdict; a revised unit stays). The verdicts' closes are folded into the plan the command turn is
checked as (`verdictCloses`: accepted and reassigned units, reason `<verdict>: <why>`,
only for verdicts that name a listed report and its unit, and only for units not already
in `closeUnits`), so "Units exist" and "Closing is clean" hold them like any close: a unit
still running a task is not accepted out from under it, and a unit closed twice is named
once, by "Reports answered". `applyCommand` in `src/runtime.ts` records, after
`command.turned` and the call, one `report.reviewed` per verdict (payload `reportId`,
`unitId`, `verdict`, `instructions`, `why`, `cycle`; actor `ic`), then closes the
`closeUnits` and the verdict closes through `store.closeUnit`, so an accepted or
reassigned unit gets the same `unit.closed` (session demobilized) as a planned close; a
revised unit stays active for R4-3 to brief. `Commanded.closedUnits` carries both kinds.
`report.reviewed` is a new `EventType` (46 now, after R4-6's `plan.warned`). `incident step` prints `verdict on
<unit>'s report <id>: <verdict>: <why>; instructions: …` under the command turn; `incident
review` says `N verdict(s)` on the command turn's line, lists each verdict under it with
the report id, its why and instructions, and after the IC-verdict line counts `report verdicts: N: a
accepted, b revise, c reassign` for the incident and one line per unit; `incident tree`
(and the planner's section 3, which shares `describeLeader`) shows `last report: met,
accepted`, the IC's last verdict from `lastVerdicts` in `src/tree.ts`. `IC_ROLE` says the
three-way judgment with its reasons: accepted when the work shows the objective met on
observed claims and the unit closes; revise when the same unit is placed to finish and
the instructions say what is missing; reassign when a different shape of unit would do
better, the instructions carrying what was found and not found; the outcome is the
leader's opinion and the verdict the IC's; exactly one per unit that reported, on its last report; a reported unit is closed by its verdict, never by `closeUnits` as well; a
report's why or suggestion is answered through the verdict's instructions and the period
objectives. The command turn's ask names the verdicts. The stub (`test/stub-claude`)
answers every report its briefing lists: a turn with no `reportVerdicts`, or an empty
list, gets `accepted` for a `met` report and `revise` with stub instructions otherwise,
and a verdict with no `reportId` (or an empty one) gets the id of the last report listed
for its unit, since a test literal cannot know the store's UUID. DESIGN.md Step 2 (the
event), Step 4 (the change report's window, the schema, the verdicts, the application
order), Step 5 (the command turn's own rules as a table) and Step 7 (`tree`, `step`,
`review`), the architecture page's IC node and steps 1 and 2, and CLAUDE.md's IC sentence
follow. Tests: models tests for the three verdicts, both refinements, an unknown verdict,
an empty why, an unnamed key, the field's presence in the schema's `required`; validator
tests on two reported units for a missing verdict (one reason per report), a verdict on a
report not in the window, on the wrong unit, two on one report, accepted beside
`closeUnits`, an accepted unit still running a task (rejected by "Closing is clean" and
nothing else), and a good turn applied: the accepted unit closed with the verdict as its
reason, the revised one active, `report.reviewed` per verdict with actor `ic`, the event
order, and the window cleared for the next turn; a test that a rejected turn leaves the
report listed and owed; a test that the report the runtime files for a unit refused
twice (R4-7) is listed, owed a verdict, and closed by an accepted one with
`report.reviewed` recording it, and that with the unit's leader report earlier in the same
window the earlier report is listed with its marker, a verdict on it is refused with the
id that takes one, and the last is the one owed; a stub run where the leader reports `met`, a turn with a verdict
on no listed report is rejected on both reasons and the next briefing lists the report
again, the accepted verdict closes the unit through `unit.closed`, `review` counts and
lists it and `tree` marks it; the review and dispatcher snapshots follow the stub's
default revise.

Not exactly to spec, with reasons:

- A verdict names a report by its event id and its unit, not a unit alone as the plan
  block says, on the orchestrator's design points, since `report.reviewed` is keyed on the
  report. The rule counts units, as the plan block does: under parallel dispatch (R4-9) a
  unit can file two reports in one pass, its leader's and then the runtime's `not_met`
  when a later task of its is refused twice, and the verdict answers the last, the one
  the IC is deciding on; the earlier is listed and marked, and a verdict naming it is
  refused with the id that takes one. The stub answers each reporting unit on its last
  listed report. Decided with the orchestrator on PR 44's second review.
- The "tasks under command" block of the change report (R4-6) used the window since the
  IC's last turn of any kind, so after a rejected command turn the retry's briefing
  re-listed the reports but dropped the root's tasks that ended before the rejection.
  Fixed here: both use `eventsSinceLastCommand` in `src/leader.ts`, everything after the
  last accepted `command.turned`; tested by a rejected turn that keeps a completed root
  task listed and an accepted one that clears it.
- The window is the reports since the IC's last accepted command turn, not since it last
  acted, and the change report's report list now uses the same window: a rejected turn
  answered nothing, and under the old window the reports vanished from the retry's
  briefing while the rule would still owe verdicts on them.
- As first built, command's own report was listed with a `[command's own report; no
  verdict]` marker and a verdict on it refused by name, since the root's leader turn then
  filed `unit.reported` after a task under command. R4-6 merged first and removed the
  root's leader turn, so the rebase dropped that handling rather than carry dead paths:
  the root filter in `reportsAwaitingVerdict` (and `reportsSinceLastCommand`, which had
  become the same function), the marker, the "command's own" reason, the `IC_ROLE`
  sentence, the schema description on `reportVerdicts` and the test.
- The runtime-authored `not_met` report R4-7 files for a unit refused twice lands in the
  window and takes a verdict like a leader's, with no code change: accepted or reassign
  closes the unit; revise leaves it active with no session, which R4-3's fresh-session
  path picks up.
- `reassign` closes the unit here, on the orchestrator's reading, so R4-4 adds the
  reassignment record rather than the close; the plan block leaves both to R4-4.
- The verdicts' closes are folded into the plan checked under "Closing is clean" rather
  than checked separately, so an accepted unit that still runs a task is refused by the
  existing rule and its wording; only verdicts that name a listed report and its unit
  fold, so a misnamed verdict is one "Reports answered" reason and not also a "Units
  exist" one.
- The planner's unit tree shows the last verdict too, since it shares `describeLeader`
  with `tree`; it changes no planner snapshot, as no fixture carries a verdict.
- The stub decides a default verdict by the report's outcome (met → accepted, otherwise
  revise), so every existing multi-cycle test keeps its meaning without each scripting
  verdicts on ids it cannot know; a test that wants a particular verdict scripts it with
  `reportId: ""` and the unit id.

## R4-3: Revise (#46, merged 2026-09-15)

R4-3 of the round 4 plan, on R4-2's verdicts and R4-9's pass. Built: a `revise` verdict
reaches the unit's leader as a revision brief, the first turn of the unit's next pass,
before any task. `revisedUnits` in `src/leader.ts` finds every active unit whose last
`report.reviewed` with verdict `revise` is later than its last `unit.revised`, and builds
the brief (`RevisionBrief`: the `report.reviewed` event's id, the report's id and the
report itself from its `unit.reported` event, the instructions, the why, and the revision
number); `dispatch` in `src/dispatcher.ts` reads it beside `resumedUnits` and
`unitsOwingReport`, counts it as work for the pass (`hasWork`), and `pass` opens such a
unit with `settle` on a `TurnCause` of its own, `{ status: "revise", brief, period,
answers }`, ahead of the resumed-unit turn (a unit that resumed from `waiting` on the same
command turn, the IC having answered its requests while revising its report, reads the
answers on the same turn rather than on a second one). The turn goes through `leaderTurn`
as any turn: the session is resumed when the unit has one, and a unit with none (its
session released after a refusal, or the runtime's report after two refusals) gets a fresh
session opened with the orientation, as the existing `orientation` path already did for a
first call. `renderTurnPrompt` renders the cause (`renderRevisionBrief`) after the unheard
endings and before the refused-assignment reasons and the ask: the instructions and why,
the report reviewed in one line (`describeReviewedReport`), the period objectives and
priorities (`renderPeriod`), the answers when there are any, and what the leader does
with it; the ask is then the usual one, except that a unit with no task, nothing running
and nothing to hear is asked to assign what the instructions call for and continue, or
file its report (`NO_TASKS_REMAIN_ON_BRIEF`; review finding: the plain ask for a report
contradicted the brief two lines above), and one with tasks is asked to continue or
report. `unit.revised` is a new `EventType` (47),
recorded in the turn's transaction after `leader.started` and before the `unit.continued`
or `unit.reported` the turn produced, with the seat (unit, session, provider, model),
`reviewedId`, `reportId`, `instructions` and `revision`; a pass that dies before the
leader answers leaves it unwritten, so the next pass delivers the brief again.
`revisionOf` counts the unit's revise verdicts from `report.reviewed`; `leaderTurn` and
`reportRefusals` write it as `revision` on `unit.reported` when it is above zero, so the
report after the first revise carries `revision: 1` and the runtime's `not_met` for a
brief refused twice carries the same number. `Dispatched.reports` carries `revision` on a
leader's report and on the runtime's (`reportRefusals` returns the number it wrote; review
finding), and `step` prints `reported met (revision 1)`; the change report and `incident show` head the
report `met (revision 1)` (`renderReport`), which keeps the stub's report-line pattern
intact. `incident review` (`src/review.ts`) lists each delivery in its cycle (`revision 1
briefed to the leader of <unit> on report <id>: <instructions>`), marks a leader's report
line and the runtime's with the revision, and after the report-verdict counts prints
`revisions: N` with one line per delivery (`revisionLines`): the unit's turns (its
`unit.continued`, `unit.reported` and `leader.failed` events) and its tasks' `task.usage`
between the `unit.revised` and the unit's next `unit.reported`, with their tokens, seconds
and cost priced as the cycles price them (the window opens at the verdict's
`report.reviewed`, not the delivery, so a brief turn refused on the unit's model, filed
as `leader.failed` before `unit.revised`, is priced in it; review finding), the outcome
of the reviewed report and of the
answer, and the answer's `changed` lines not in the reviewed report; a revision with no
report after its brief says `not yet reported`. `LEADER_ROLE` gains a paragraph on the
verdicts and the brief: the unit and its objective stand, the instructions open the next
turn, the leader assigns what is missing or reports at once, and the next report is
numbered. DESIGN.md Step 2 (the event and the `revision` field), Step 4 (the revise
sentence), Step 5 (the Closing is clean row), Step 6 (the brief in the pass) and Step 7
(the review row), and the architecture page's dispatch step follow.

Tests: a stub run (`test/ic.test.ts`) where the leader reports `progress` in cycle 1, the
IC revises with instructions, cycle 2's pass resumes the leader's session with the brief
before any task (the prompt pinned: the instructions, the why, the reviewed report, period
2's objectives and priorities, the ask for a report), the leader assigns one grep and
continues, reports `met` on its ending with `revision: 1` (`step`'s line, the
`unit.reported` payloads, `unit.revised`'s payload and its place between `report.reviewed`
and `unit.continued`), the unit stays active, cycle 3's change report heads the report
`met (revision 1)`, the IC accepts and the unit closes, and `review` lists the delivery,
the numbered report, the verdict counts and the revision's line with its two turns, one
task, cost and the change added; a dispatcher test (`test/dispatcher.test.ts`) where a
unit with no session, the runtime's `not_met` report and a revise verdict on it gets one
fresh call with no `--resume`, opening with the orientation and carrying the brief, its
events after the verdict being `leader.started`, `unit.revised`, `unit.reported` with
`revision: 1`, its session recorded, and a second pass doing nothing; a `renderTurnPrompt`
test pinning a revise cause with answers and an unheard ending, in that order. The models
test pins the event count at 47. Two R4-7 tests and two R3-9 handoff tests changed with
the behavior: in each, cycle 1's leader reported `progress`, the stub's IC revised it, and
cycle 2 now opens the unit with the brief, so the refused call in the R4-7 tests is the
brief's turn (the fallback session takes the brief, continues, and reports after the
grep, three calls where there were two, the report marked `(revision 1)`), and the
handoff tests' cycle-2 call list ends with the leader's brief turn.

Not exactly to spec, with reasons:

- The brief is a turn cause of its own, delivered as the unit's first turn of the pass,
  with the unheard endings of earlier passes rendered before it as `renderTurnPrompt`
  renders them on every first turn, rather than after it: the endings are what the leader
  has not yet heard about its own work, the brief is what the IC concluded from that work,
  and keeping the existing order means one rendering path for every first turn. The
  refused-assignment reasons and the ask follow it as on any turn.
- `revision` is counted from `report.reviewed` events with verdict `revise` on the unit,
  not stored on the unit: the verdicts are the record of how many times the IC sent the
  unit back, the count needs no schema change on `units` and no mutation, and a replay
  gives the same number. It is written on `unit.reported` beside `report`, not inside the
  `LeaderReport` schema, since the leader does not count its own revisions and the report
  schema stays the leader's.
- `unit.revised` is written with the turn that read the brief, not when the verdict is
  applied: the plan block says it records the verdict's delivery, and delivery is the
  leader having read it; a pass that dies between the verdict and the leader's answer
  delivers the brief again on the next pass, since the verdict is then still later than
  the last `unit.revised`.
- A unit that resumed from `waiting` and was revised on the same command turn reads the
  answers on the brief's turn rather than on a separate resumed turn first: two turns for
  one moment would cost a call and split what the IC said in one place.
- The period objectives in the brief are the incident's current period, the one the
  verdict's command turn opened; `dispatch` reads `incident.period` from the incident
  `step` re-reads after `applyCommand`.
- The stub needed no change: a revise verdict is scripted as R4-2 built it (`reportId:
  ""` with the unit, or the default `revise` on a report that is not `met`), and the
  leader's second report is the next entry of `NOSCOPE_STUB_TURNS`.
- The stub's default verdict (`revise` on any report not `met`) now costs a leader turn
  per cycle for a unit that keeps reporting `progress`, since each revise is delivered;
  the four tests named above absorbed it. A test that wants a unit left alone after a
  `progress` report scripts an `accepted` verdict.
- A plan may not close a unit whose revise is not yet delivered, ruled by the
  orchestrator in review on 2026-09-15 when the gap was flagged: the plan drafted in the
  verdict's cycle would otherwise close the unit before its leader read the brief.
  `ValidationContext` gains `revised` (the keys of `revisedUnits`, set in
  `validationContext`), "Closing is clean" refuses such a close with `unit X has a
  revision not yet delivered; its leader answers it first`, and `validateCommand` runs
  the command rules with `revised` blanked, since the IC's close is its own decision and
  its verdict on the runtime's report for a unit whose brief was refused twice must be
  able to close the unit. The planner's rule text,
  the planner snapshot and DESIGN.md Step 5's row follow; a validator test pins the
  plan's rejection, the IC's close of the same unit passing, and the close freed once
  `unit.revised` follows.

## R4-4: Reassign (#47, merged 2026-09-15)

R4-4 of the round 4 plan, on R4-2's verdicts (which already close a reassigned unit
through `verdictCloses`) and R4-3's revise path. Built: a `reassign` verdict hands the
unit's slice on. `applyCommand` in `src/runtime.ts` records, after the verdicts'
`report.reviewed` and before the closes, one `unit.reassigned` per reassign verdict
(`reassignmentsOf`; actor `ic`; payload `reassignmentId`, numbered in the incident as
`<incident>-rNN` after `-qNN` and `-tNN`, `reportId`, `unitId`, the unit's `objective`,
`instructions`, `why`, `claims`, the ids of every claim whose provenance task is the
unit's, `cycle`, and `dropped`, true when the instructions begin `drop:`,
`dropsSlice`), then closes the unit through `store.closeUnit` as R4-2 did (its session
demobilized on `unit.closed`) and cancels its open tasks (`task.cancelled` by the runtime
with `rationale: reassign: <why>` and the `reassignmentId`; PR 45's review found that
`unit.close` sets status only). `Commanded` carries `reassignments` and
`cancelledTasks`, and `step` prints `reassignment <id> recorded from unit <u> with N
claim(s); the next plan gives it to a new unit`, or `dropped by the IC: <instructions>`,
and `task <id> cancelled`. `src/leader.ts` gains `Reassignment`, `reassignments` (every
`unit.reassigned`, each with `takenBy` from a later `reassignment.taken`),
`openReassignments` (recorded, not dropped, not taken) and `reassignmentTakenBy`. The
planner's input (`src/planner.ts`) gains section 11, "Reassignments", after the
situation: each open one with its id, the closed unit and objective, the cycle and
report, the instructions, the why and the claim ids, or "(none)"; the system prompt says
eleven sections and what section 11 asks. `UnitProposal` gains `takes`, optional, the
id of an open reassignment; the rule "Reassignments taken" (a `PLANNER_RULES` line, so a
`RuleName`, checked on plans only) refuses a `takes` naming no open reassignment, a
reassignment taken twice, and an open reassignment no new unit takes;
`ValidationContext` gains `reassignments`, the open ones. `applyPlan` records
`reassignment.taken` (the reassignment, the new unit's id, `fromUnitId`) after the
taking unit's `unit.created`, and `Applied.taken` lets `step` print `(takes reassignment
<id>)` on the unit it created and on the drafted proposal. The dispatcher's
`orientation` (`src/dispatcher.ts`) looks the unit's reassignment up
(`reassignmentTakenBy`) and `renderLeaderOrientation` renders it in the unit's own lines,
on a turn's first call and before a task brief run inside the session alike: the
reassignment's id, the closed unit and its objective, the report reviewed, the
instructions, the why, and the claims by id with each one's subject, predicate, basis
and confidence from the store. `IC_ROLE` says a reassignment is recorded with the
instructions and the claims, that the next plan must create a unit that takes it, that
the taking leader reads the instructions, and that `drop:` drops the slice instead.
`incident review` (`src/review.ts`) lists the recording and the taking in their cycles
and, after the revisions, `reassignments: N` with one line each: the unit, the cycle,
the claim count, taken by which unit, dropped by the IC with the why, or open, and the
instructions. Ruled by the orchestrator in PR 47's review: the IC can drop a
reassignment after the verdict, so `CommandTurn` gains `dropReassignments`, an optional
array of `{ id, why }`, held by the command rule "Drops match" (each id an open
reassignment, none twice), recorded by `applyCommand` as `reassignment.dropped` (the
id, the why, the cycle; actor `ic`) in the turn's transaction after the
`unit.reassigned`s, closed for `openReassignments` (`Reassignment.droppedWhy` carries
the why, the instructions for a `drop:` verdict), printed by `step` as `drop
reassignment <id>: <why>`, and listed by `review` in its cycle and on the summary line;
and a plan whose `incidentStatus` is `failed` is exempt from "Reassignments taken",
since a failing incident owes no taker, while `satisfied` stays held to it. `IC_ROLE`
says that the file's section 11 lists the reassignments still open, each taken by a plan
or dropped by the IC in `dropReassignments`. Three new `EventType`s (50 now). DESIGN.md
Step 2 (the events), Step 4 (the verdict, the application order, section 11, `takes`,
`dropReassignments`), Step 5 (the rules), Step 6 (the orientation) and Step 7 (`step`,
`review`), and the architecture page's IC and planner nodes and cycle steps 2, 3, 5, 6
and 7 follow; `src/ic.ts`'s and the DESIGN.md tree's "ten sections" read eleven.

Tests: a stub run (`test/ic.test.ts`) where the leader reports `progress` with a second
grep still pending, the IC reassigns with instructions, `step` prints the verdict, the
close, the reassignment with its one claim and the cancelled task, the planner's second
input carries section 11 with the reassignment (the first "(none)"), the draft without
a taking unit is rejected on "Reassignments taken" with the reason, `unit.reassigned`'s
actor and payload and its place between `report.reviewed` and `unit.closed`,
`task.cancelled`'s payload, the tasks' statuses, the third cycle's plan with a `takes`
applied (printed on the proposal and the unit), `reassignment.taken`'s payload and its
place between `unit.created` and `plan.applied`, the new unit's first call opening with
the orientation lines and the claim's line, and `review`'s cycle lines, verdict counts and
reassignment line; a unit test on two reported units where one reassign carries
instructions and the other `drop:`, both close, both are recorded (one `dropped`), only
the first is open, a plan taking nothing is refused with the reason, a `takes` on the
dropped one is refused beside it, two units taking one is refused, a taking plan passes,
`applyPlan` records `reassignment.taken` with `fromUnitId`, `reassignmentTakenBy` finds
it, the next plan owes nothing, a `failed` plan is exempt while a `satisfied` one is
held, and a later turn's drop of a third unit's reassignment is refused on an unknown
or already-taken id and on a double drop, applied with `reassignment.dropped`, closes
it for `openReassignments`, and shows in `review`'s cycle line and summary with the why.
The planner snapshot and the rule count (14) and event count (50) pins follow.

Not exactly to spec, with reasons:

- A reassignment is an event pair, not a table: `unit.reassigned` records it and
  `reassignment.taken` closes it, as `report.reviewed` and `unit.revised` pair in R4-3;
  no schema version rises, and a replay reads the same set. "Open" is recorded, not
  dropped and not taken.
- A `drop:` verdict records the reassignment with `dropped: true` rather than writing
  nothing or a separate event: the record shows the IC took the slice from the unit and
  chose to drop it, `review` counts it, and one event carries both facts. The test is
  `/^drop:/i` on the trimmed instructions.
- The reassignment's id is `<incident>-rNN`, numbered in the incident like questions
  and tasks, not the `report.reviewed` event's UUID: the planner names it in `takes`,
  and a test's plan literal can name `001-r01` where it could not name a UUID, so the
  stub needed no change for the taking plan; the reassign verdict is scripted as R4-2
  built it (`reportId: ""` with the unit).
- Section 11 is appended after the situation rather than inserted mid-file: both
  sections change every cycle, so the cached prefix is the same either way, and the
  existing section numbers, which the system prompt and the docs name, stay put. R4-5
  folds it into the situation.
- Only a reassign verdict cancels the closed unit's open tasks, as the block says; an
  accepted verdict still leaves them pending, as R4-2 built it, for a plan to cancel.
- The orientation renders each claim's subject, predicate, basis and confidence beside
  its id, not the id alone: the block says "by reference", the acceptance says the claim
  ids, and one line per claim costs little and tells the leader what the id is; the
  object is never rendered, and the line tells the leader to name a claim in
  `evidenceFrom` on a task it assigns, since a leader never reads the incident file
  (PR 47's review, finding 2).
- The rule is not applied to a command turn or a leader's assignments, which create no
  units; a plan that blocks or fails with a reassignment open is still held to it, since
  the IC decides what happens to the slice through the verdict and the plan carries it
  out.
- `incident show` is unchanged: the open reassignments are in the planner's section 11,
  in `step`'s lines and in `review`, and R4-5 puts them in the situation `show` prints.
- Follow-up, from PR 47's review (findings 4 and 5): a pending task that depends on a
  task a reassign cancelled stays pending forever, as one depending on a task a plan's
  `cancelTasks` cancelled already did; and an accepted verdict leaves the closed unit's
  pending tasks pending while a reassign cancels them. Both are noted for a later PR.

## R4-5: The IC owns the situation (#48, merged 2026-09-15)

R4-5 of the round 4 plan, on R4-4's reassignments, folding its section 11. Built: the IC
writes the situation, ruled by Mauria in review on 2026-09-15 ("i want the IC to own it
once it starts making the updates to it"), and the planner drafts the tactics against it
as a suggestion for the IC. `CommandTurn` gains `situation`, the `Situation` schema,
required, after `reportVerdicts`; `ActionPlan` loses it, so a plan carrying one is refused
by the strict object. `Settlement` is now a task (an open task's id, or the ref the IC
wants this period's plan to give the task that settles the link), a reproduce task the
same way, or `deferred` with a why; the `question` variant goes. `icSituation` in
`src/leader.ts` reads the situation off the last accepted `command.turned` (its `turn`
payload), skipping a rejected turn's, and replaces the two private copies of
`lastSituation` that read `plan.applied` in `src/planner.ts` and `src/dispatcher.ts`, so
every leader's orientation and every task's brief now carry the IC's hypothesis and proven
claims. The planner's section 10 is headed "The IC's situation", renders it as the IC wrote
it (a deferred link as `<claim>, deferred: <why>`), and ends with one line naming the ids
of the reassignments still open and the unit each came from, or "(none)"; section 11 and
`renderReassignments` go, the system prompt reads ten sections and says the plan works
the IC's situation and the rationale says how, and the reassignment is what the IC wrote
into the slice it concerns. `PLANNER_RULES`' "Inferred links are worked" now reads: every
inferred link in the IC's situation is settled by this plan, the task it names a ref in
this plan or an open task not cancelled in it, unless the IC deferred it; `ValidationContext`
gains `situation` (`icSituation(events)`, set in `validationContext`) and the check reads it
instead of the plan, its reason opening "the IC's situation has inferred claim …".
"Reassignments taken" reads "section 10 lists". The claim checks the plan's situation
passed under "Dependencies resolve" (every claim id named exists; every proven claim has
basis observed) move to a fifth command rule, "Situation grounded" (`CommandRuleName`),
checked in `validateCommand` on the turn's own situation. `planDiff`'s `changed` fields
drop `situation`, and `plan.applied` no longer carries one. `incident show` prints
`situation, the IC's:` under the period priorities, through the planner's `renderSituation`
(exported for it, indented two spaces), the open-reassignment ids under it; the block
after "decisions" goes. `step` prints `situation changed: …` and `hypothesis: …` after the
priorities, and the command turn's ask names the situation. `IC_ROLE` gains a paragraph:
the IC owns the situation, the picture every seat works from until its next turn; a link
is settled by a task by id or by the ref the plan is to give it, or deferred with why, and
a link deferred is a decision recorded, not an omission; a reassignment updates the slice
it concerns, with the ids still open listed under the situation in the file; the plan is
the planner's suggestion of the tactics that work it, its rationale saying how. The
sentence "The situation in the plan is the planner's; leave it as written" goes. The stub
(`test/stub-claude`) fills a default situation (`stub: nothing yet`, `stub hypothesis`)
on any command turn that carries none. DESIGN.md's Vocabulary gains a Situation row and
its Action plan and Cycle rows follow; the ICS mapping's Planning Section row says the
Situation Unit's picture is the IC's here, and the Situation Unit row and the Reference
row on a Situation Unit say the same; Step 2 notes `command.turned` carries the
situation; Step 4 (the `CommandTurn` sketch, the reassignment sentence, the command
rules, section 10, the `ActionPlan` sketch, the planner's paragraph, `planDiff`), Step 5
(the plan rule's row, the five command rules), Step 6 (the orientation) and Step 7
(`show`) follow, with the architecture page's IC and planner nodes, cycle steps 1 to 3,
the brief's user message and the claim-placement step, and CLAUDE.md's IC paragraph.

Tests: models tests that a command turn without `situation` is refused and one with the
three settlement kinds parses, that `question` and an empty `deferred` are refused, that
a plan carrying `situation` is refused, and that the command schema's `required` names it
and the plan schema's does not; validator tests that with no IC turn nothing is owed, that
a plan settling each link (a ref, an open task, a reproduce by ref, a deferral) passes,
that a rejected turn's situation is skipped, and that a plan leaving three links
unsettled (an unknown task, a task the plan cancels, a completed task) is rejected with
one reason each; a "Situation grounded" test on a grounded turn and one naming two missing
claims and an inferred claim as proven; planner tests that section 10 is the IC's from the
last accepted turn, a `plan.applied` situation is ignored, a rejected turn is skipped, the
open reassignment ids render under it and no section 11 remains, that the IC's `keep`
keeps a summarized claim in full, and the snapshot (section 10's heading, the two rule
texts, the open-reassignments line); a dispatcher test that a session's brief carries the
IC's situation; the R4-4 run test reads the reassignment from the IC's situation and the
ids line; a new stub run (`test/ic.test.ts`) where cycle 2's command turn carries a
situation with one link settled by the ref `probe` and one deferred, `step` prints the
changed line, the planner's draft without the ref is rejected under "Inferred links are
worked" with the reason, the planner's input carries section 10 as the IC wrote it,
cycle 3's draft with a task of ref `probe` is applied, the three accepted turns carry
their situations and no `plan.applied` does, and `show` prints the situation under the
period; the `run` test's `show` check, the step-output pins in `test/dispatcher.test.ts`
and `test/ic.test.ts`, the IC role lines in `test/providers.test.ts`, the size-up
snapshot and the plan and command fixtures of every test follow.

Not exactly to spec, with reasons:

- `deferred` is a fourth `Settlement` variant, `{ deferred: <why> }`, in the link's
  `settledBy` rather than a flag beside it: the link says either what settles it or why it
  is not worked, one field, and the schema the provider receives says so.
- The `question` settlement goes. It named a question by position in the plan that carried
  the situation, and the IC writing the situation before the planner drafts cannot know
  the planner's positions; an IC that needs Mauria's answer raises the question in its own
  turn, which blocks the incident before any plan is drafted, and marks the link deferred
  with the question as the why.
- The first command turn writes a situation like any other: the field is required on every
  turn, `FirstCommandTurn` included, and the schema's `changed` says "on the first turn,
  what the briefing established"; the role text says the same. Nothing feeds the field from
  the briefing in code, since the IC evaluates the briefing on that turn and its situation
  is what it makes of it. Before the IC's first accepted turn section 10, `show` and every
  brief carry "(none)", as they did before the first applied plan.
- The open reassignments' ids are rendered by the runtime in one line at the end of
  section 10, from the events, rather than left to the IC's prose: the rule "Reassignments
  taken" is still checked from the events, and the planner must name the id in `takes`, so
  the id reaches it whatever the IC wrote. The instructions, why, objective and claims that
  section 11 rendered are no longer in the planner's input; the taking unit's orientation
  still carries them, unchanged, from `unit.reassigned` and `reassignment.taken` (the R4-4
  run test pins it).
- The claim checks move to a command rule of their own, "Situation grounded", rather than
  staying under "Dependencies resolve": the plan no longer carries the situation, and a
  turn naming a claim the incident lacks is the IC's error to fix on the retry.
- A rejected turn's situation is skipped, as its period is: `icSituation` reads the last
  accepted `command.turned`, so a retry's briefing and the plan after it see the situation
  the IC last had accepted.
- A log written before R4-5 carries its situations on `plan.applied`, which nothing reads
  now; such an incident's section 10 and `show` say "(none)" until its IC's next accepted
  turn. No schema version rises, since no table changes.
- The stub fills a default situation on a scripted command turn that has none, as it fills
  default verdicts, so every existing scripted turn keeps its meaning; a test that wants a
  particular situation scripts it.
- `step` prints the turn's `changed` and `hypothesis` lines after the priorities, two lines
  the block does not ask for, so the operator reads the picture the cycle runs on without
  `show`; the tests that pin `step`'s output line by line moved their indices.
- `renderSituation` is exported from `src/planner.ts` for `show`, which had its own copy of
  the rendering; one rendering now, with the open-reassignments line in both places, worded
  "in this plan" for the planner and "in the next plan" for `show`, and "(none)" said and
  indented by the caller (PR 48's review).
- Follow-up, from PR 48's review (finding 5, pre-existing under "Dependencies resolve"): a
  claim with status `rejected` and basis `observed` passes "Situation grounded" in `proven`,
  since basis is what gates and nothing sets `rejected` yet; noted for the PR that first
  sets it.

## R4-10: Unit types: the form, the filled form, the protocol (#49, merged 2026-09-15)

R4-10 of the round 4 plan, ruled by Mauria on 2026-09-15 (12:31 to 13:34): a unit is a
type plus a config; the type is the form (the fields a kind of unit fills) and the protocol
(how a unit of that kind uses what is in the box); the config is the filled form; `base`
is the led unit and `ic` is command, the root; a config keeps its type's protocol; the role
text is a form field defaulting to the type's; more types will be written and saved. Built
on the layout of `src/capabilities/registry.ts`, in four commits: the registry, forms and
`Unit.type`; the protocols and the dispatcher; the validator; the docs. The names in code
are the plan's words: `Unit.type` names the type, and the filled form is the unit's own
fields (there is no `config` column; R4-11 adds the table for saved ones).

The registry (`src/units/registry.ts`): `defineUnitType` registers a `UnitType` by name,
a `description`, `plannable` (whether a plan may create a unit of the type), a `form` (a
zod object; registration refuses one without a `role` field, since every form carries the
role text its session reads) and a `protocol`; `getUnitType`, `listUnitTypes`,
`protocolOf(unit)` (refusing a unit whose type is not registered) and `roleOf(unit)` (the
config's `role`, else the type's) read it. A `Protocol` is the seat its session holds,
the default role text, `reports` (whether the unit files reports the IC answers; false
for command), `rules` (the assignment rules, below), `runsInside` (whether a session task
runs inside the unit's session), `insideRequest` (the request for one that does),
`hasWork` (whether the unit has a turn to take this pass beyond a runnable task; the
dispatcher starts a pass on either; a known cost, below) and `unheard` (the endings of earlier passes its
leader has not heard, carried on the pass's first turn), and
three pass hooks, `open`, `ending` and `close`, each given a `PassContext` (the store, the
incident, the active units, cwd, env, actor, providers, and the runtime's `bookkeeping`:
`validateAssignments`, `applyAssignments`, `raiseRequests`, `strikeTeamRejections`, lent
by the dispatcher so a protocol module imports neither the validator nor the runtime,
which import the registry) and a `PassView` (the unit's runnable tasks not yet attempted,
the unheard endings of earlier passes, the tasks running in sessions of their own, the
endings landed and not yet heard, whether the unit ran anything, is done, or the pass has
halted, the leader's chain `onLeader`, and `unit`, the unit as the pass now holds it, which
a turn queued on the chain reads when the chain reaches it: a task that ran inside the
session records that session on the unit, and a refusal inside it releases the session,
between the queuing and the call), and answering a `Turned` (the unit as it now
stands, the report filed if any, whether the unit is done for the pass, whether the picture
changed) or null. `TaskEnding`, `Landed`, `Reported`, `describeError` and `leaderRequest`
(the session request under `roleOf` and the protocol's seat, replacing `leaderRole(seat)`)
live here too. `src/units/index.ts` registers `base` and `ic` and is a knip entry as
`src/capabilities/index.ts` is.

The base type (`src/units/base.ts`, `BASE_TYPE`): `plannable`, its form `BaseUnitForm`
(declared in `src/models.ts` because `UnitProposal`, and so `ActionPlan`, extends it and
`models.ts` imports nothing: `objective`, `leader`, `equipment`, `bashAllowlist`, and
`role`, optional, with descriptions the planner's schema renders), and the leader's
protocol, which is what `src/leader.ts` and the dispatcher's `leaderTurn` did: `LEADER_ROLE`,
`BASE_RULES`, `LEADER_TURN_SCHEMA`, `runsInsideLeader` (the root check gone; the ic
protocol's `runsInside` is false instead), `holdsCapability`, `unitShare`, `resumedUnits`,
`revisedUnits`, `unitsOwingReport` (`protocolOf(u).reports` in place of `parentId !==
null`), `renderLeaderOrientation`, `endedSinceLastTurn`, `renderTurnPrompt`, the
orientation, `insideRequest`, `reportRefusals`, `refusedSinceLastTurn`, `couldNotResume`,
`declareRequestedTeam`, `leaderTurn` (the root throw gone; the bookkeeping through the
context) and `settle`. Its `hasWork` is a revision brief to read, a resume, or a report
owed, read from the log per unit; its `unheard` is `endedSinceLastTurn`. Its hooks: `open` recomputes the unit's revision brief (R4-3) and
resume (R3-6) from the log and takes that turn on the leader's chain, the brief first with
the answers when both; `ending` files the runtime's `not_met` report for a task refused on
both models (R4-7: done and halted), takes no turn when the leader reported already this
pass, else the leader's turn on the ending with the tasks still running and landed;
`close` asks for the report owed from an earlier pass when the unit ran nothing this pass
and the pass has not halted, and marks the unit done. `src/leader.ts` keeps what every
seat shares: `IC_MODEL`, `IC_PROVIDER`, `fallbackModel`, `RefusedCall`, the actors, the
reassignments, the requests, `revisionOf`, the verdict window, `icSituation` and
`latestReports`.

The ic type (`src/units/ic.ts`, `IC_TYPE`): not plannable; its form `IcUnitForm` is the
IC's `leader` (provider and model), `equipment` (default the four read-only built-ins),
`bashAllowlist` (default the read-only session list) and `role`, with no objective
(`newCommandUnit` fills it from the leader `incident create` chooses and writes the fixed
objective line the root has carried since round 1) and no parent; `commandUnitOf(units)`
finds command by type, which `src/ic.ts` (`commandUnit`, the change report's tasks under
command), `src/runtime.ts` (`applyCommand`'s assignments), `src/validator.ts` (the
warning, `validateCommand`) and `src/commands/incident.ts` (`show`'s IC line, `answer`'s
transfer) use instead of `parentId === null`. Its protocol: seat `ic`, `IC_ROLE` (moved
here), `reports: false`, `rules: [OWN_UNIT_RULE]`, `runsInside` false, `insideRequest`
throws, and the root's pass from R4-6: `hasWork` false (a runnable task alone starts its
pass), `unheard` empty (the change report carries the root's endings), `open` and
`ending` take no turn (a root task refused twice ends as its `task.failed`, R4-7),
`close` marks command done. Its turns are `src/ic.ts` as before (the command turn, the
review, the change report, the handoff, the transfers, the fallback), which the type's
header and a comment on the protocol name.

The dispatcher (`src/dispatcher.ts`): `dispatch` builds the `PassContext` once (the
bookkeeping closes over the validator's and runtime's functions), gates a pass on
`protocolOf(unit).hasWork` or a runnable task (it no longer computes the owed, resumed
and revised units itself; PR 49's design review), seeds the pass's unheard endings from
`protocol.unheard`, and each unit's pass
builds its `PassView`; the pass calls `protocol.open` before the loop, `protocol.ending`
on each landing, `protocol.close` after it, folding each `Turned` into the pass's tally
(`take`: the unit, the report, done, the halt); `runTask` and the inside gate ask
`protocol.runsInside` and `protocol.insideRequest`. The scheduling, the starts, the
landings, the budget check and the halt are unchanged. `grep -n "parentId === null"
src/dispatcher.ts src/units/` prints nothing. Three remain in `src/tree.ts`'s
`renderHierarchy` (the "(command, the root)" and "Reports to: Mauria" lines a task brief
under command renders, R4-6's test pins them), which are facts of the position in the tree
and not of the type, and one in `src/store.ts`'s `withType`, the migration's rule.

The schema: `Unit` gains `type` and `role` (nullable); `UnitProposal` is `BaseUnitForm`
plus `ref`, `parent`, `type` (default `base`, described as the only type a plan may
create) and `takes`; `applyPlan` copies both; `SCHEMA_VERSION` is 7, the `units` table
gains `type` (default `base`) and `role`, migration step 6 adds the columns and sets the
root's type to `ic`, and the `unit.create` mutation's preprocess (`withType`, over
`withLeader`) reads a unit recorded without a type as `ic` when its `parentId` is null and
`base` otherwise, with a null role, so a round 4 log replays to the same rows.

The validator: a new plan rule "Type exists" (fifteen now) refuses a new unit whose type
is not registered, or is registered but not plannable, naming the types a plan may
create; `PLANNER_RULES` carries its line. The leader's three rules become the base
protocol's `BASE_RULES`, each an `AssignmentRule` (`assignmentRule(text, check)` in the
registry: the name is the text before the colon, as the planner's rules are keyed; `Own
unit` is `OWN_UNIT_RULE`, every type's), and `validateLeaderTasks` and `validateCommand`
apply `protocolOf(unit).rules` (`typeRuleRejections`), so `LEADER_CHECKS`,
`LEADER_RULE_CHECKS` and `LeaderRuleName` are gone and a rejection's rule from a type's
rule is a string; "Deterministic only" stays a command rule; `LEADER_RULES` is the texts,
for the role text and the tests. "Closing is clean" refuses a unit of the ic type ("is
command and is never closed"). The planner's preamble says a new unit is a type plus a
config and names `base` as the one type a plan may create.

`incident tree` and the planner's section 3 print each unit's type first in the
parenthetical (`(base; leader claude-code/claude-haiku-4-5; last report: none)`,
`describeLeader` in `src/tree.ts`). DESIGN.md's Vocabulary (the Unit row, and Unit type
and Unit config rows), the ICS mapping row for the Incident Commander, Step 1's tree,
Step 2 (the table and version 6), Step 4 (the IC as command's leader), Step 5 (Type
exists, the rules through the protocol), Step 6 (the hooks) and Step 7 (`tree`) follow;
`docs/architecture.html`'s IC, dispatcher, unit leader and system-prompt nodes and the
validate step, README's layout line and CLAUDE.md's framework paragraph follow.

Tests: `test/units.test.ts` (new) pins the two registered types, their forms' fields,
`plannable`, seat, role and `reports`, the registration refusals (a duplicate name, a form
without `role`), the proposal schema's field order, the `type` default and descriptions,
`protocolOf` and `roleOf` (a unit with its own role text reads it under the type's seat),
`leaderRequest`, the refusal of an unregistered type, `hasWork` and `unheard` per type
(command false and empty with a completed root task; a led unit owing a report true, its
ending listed) and `newCommandUnit`'s filled form.
`test/store.test.ts` migrates a version 6 file (the root `ic`, the rest `base`, roles
null), replays a log whose `unit.create` mutations carry no type to the same snapshot, and
round-trips a unit with its own role text. `test/run.test.ts` builds a store with the
stub through the CLI, strips it to a round 4 one (the columns dropped, the type and role
removed from every `unit.created` mutation with `json_remove`, `user_version` 6), reopens
it, replays its log into a fresh store, and asserts the same snapshot and the same `show`
and `tree` output from both, the tree naming `ic` on command and `base` on the unit.
`test/validator.test.ts` pins Type exists (base passes, an unknown type and `ic` are
refused with their reasons, the default is base), the base protocol's rules keyed as the
role text lists them and command holding Own unit alone; `test/dispatcher.test.ts` pins
that nothing runs inside command through the ic protocol's `runsInside`; the planner
snapshot and the rule count follow; `test/providers.test.ts` reads the roles from
`src/units/index.js`. Every R4-6, R4-7, R4-9, R4-3, R4-4 and R4-5 test passes with the
same events recorded; the existing tests that changed changed only their imports, the
`(type; leader …)` parenthetical where they pin a tree line, the schema version pin (6 to
7), the close reason's wording ("is command and is never closed") and the unit literals,
which now carry `type` and `role`.

Not exactly to spec, with reasons:

- The ic form carries no fallback-model or handoff-threshold field, though the plan block
  lists both: `NOSCOPE_IC_FALLBACK_MODEL` is the retry model of every refused seat, not
  the IC's alone (R4-7), and `NOSCOPE_IC_HANDOFF_TOKENS` is read on each call so a test
  sets it per step; a form field would need a column nothing fills, since `incident
  create` has no flag for either, and R4-11 saves base configs only. Both stay
  environment settings read by the ic protocol's turns in `src/ic.ts`; adding them to the
  form later changes the ic form only, which no saved config uses.
- The base form is declared in `src/models.ts` (`BaseUnitForm`) and bound by
  `src/units/base.ts`, rather than declared beside the type: `UnitProposal` extends it and
  `ActionPlan` needs the proposal, and `models.ts` is the leaf module; the ic form has no
  such consumer and is declared in its type module.
- `UnitProposal.type` defaults to `base` rather than being required: the planner sees the
  field with its default and description, "Type exists" holds what it names, every
  existing plan fixture and stub plan stands, and R4-11's `config` will supply the type
  when a proposal names one.
- The protocol's pass is three hooks around the dispatcher's loop rather than the whole
  pass: the scheduling, the budget, the landings and the halt are the same for every
  type, and moving them into each protocol would have duplicated them; what differs by
  type is the turns, which is what the hooks are.
- The bookkeeping a leader's turn needs (validate and apply its assignments, raise its
  requests, check a strike-team request) is lent through the `PassContext` rather than
  imported by `src/units/base.ts`: the validator imports `src/units/index.ts` to hold a
  unit to its type's rules and to guarantee the types are registered wherever it runs,
  and the runtime imports the validator, so an import the other way would have made a
  cycle where the tree was acyclic.
- The rules are on the protocol with their checks (`AssignmentRule`), not only their
  lines, so the validator holds a unit to whatever its type declares; the ic protocol
  holds `Own unit`, which `validateCommand` applied against the root by name before.
- `runsInsideLeader` in `src/units/base.ts` no longer refuses the root; the ic protocol's
  `runsInside` does, and the dispatcher asks the protocol. The R4-6 test that pinned the
  base function on the root now pins the protocol.
- `renderHierarchy`'s three root checks stay as position checks (above); the plan's
  acceptance names the dispatcher and `src/units/` only.
- The form is not free-standing yet: its fields are the `units` columns, the planner
  renders only the base form's fields (`UnitProposal` extends `BaseUnitForm`), and the ic
  form's equipment, allowlist and role are filled by its defaults alone, since
  `newCommandUnit` takes the leader only. DESIGN.md's Unit type row says so.
- Review (PR 49, correctness, 2026-09-15), applied before merge: the base hooks passed
  the unit they were called with into the turn they queued on the leader's chain, where
  main's `settle` closure read the pass's `let unit` when the chain reached it; a turn
  queued behind a task running inside the session then ran with the unit as it was before
  that task recorded the session, opened a second session with the orientation again and
  wrote a second `leader.started` (and after R4-7's release of a refused inside session,
  would have resumed the released one). `PassView.unit()` returns the pass's current
  unit and every queued `settle` reads it inside the `onLeader` closure; the R4-9 test
  of a turn queued behind an inside task pins `resume: stub-session` on both turns and
  one `leader.started`, and the two other R4-9 inside/outside tests pin the
  `leader.started` count, since the stub's constant session id says nothing about
  identity. Verified by breaking the fix: the pin fails with `resume: null`.
- Known cost, no fix (PR 49's correctness review): `hasWork` reads the unit's owed,
  resumed and revised state from the log per unit per scheduling round, where main
  computed the three sets once per dispatch. Safe because no unit's answer changes
  between the dispatch's start and its own pass's start (its `report.reviewed`,
  `unit.resumed`, `unit.reported` and task endings are written by the IC's turn before
  dispatch or by its own pass), so the later reads give the sets main had; the cost is
  three scans of the log per active unit per round, small at an incident's size.
- For the next type (PR 49's design review): a third type would still touch `Seat` and
  `SEAT_PLACES` in `src/providers/base.ts` (a seat per type's place), the fixed `units`
  columns and `applyPlan`'s field copy in `src/runtime.ts` (a form with other fields has
  nowhere to land), `UnitProposal` extending `BaseUnitForm` in `src/models.ts` rather
  than being built from the registry (a second plannable type is not offered to the
  planner), and "Closing is clean" testing `unit.type === IC_TYPE` in `src/validator.ts`
  (a type that is never closed would need its own flag). None is R4-11's ground.
- Follow-up, not this PR's: `test/stub-claude`'s call ordinal (`NOSCOPE_STUB_CALL_COUNTER`)
  is a read-modify-write on a file, so two stub processes started together can take the
  same ordinal; under a loaded full-suite run the R4-9 test "a runtime report after two
  refusals is not a turn" saw its refusals land on the wrong calls once (pass 1's two
  concurrent stubs both took ordinal 1, so `NOSCOPE_STUB_REFUSE=3,4` missed t-dep). It
  passes alone and passed on the next full run; the stub is unchanged here.

## R4-12: The runtime tag on events (#50, merged 2026-09-15)

R4-12 of the round 4 plan, ruled by Mauria on 2026-09-15 (13:34 to 13:39): what a seat
received is preserved in the Claude Code transcript (every call writes a `prompt_snapshot`
record with the full system prompt, and the user messages are the transcript; transcripts
are kept for 99999 days on her machine), so briefings are not stored; a briefing is made
reproducible by a tag naming the code that rendered it, not by its content. Three
commits: the build step and the version module; the column, the stamp and the migration;
the two commands.

The tag (`src/runtime-version.ts`): `describeRuntime(cwd)` is `git rev-parse HEAD` in the
checkout, `-dirty` when `git status --porcelain --untracked-files=no` lists anything, and
`unknown` when git fails, there is no checkout, or `git rev-parse --show-toplevel` is not
`cwd` itself (compared by real path), so a noscope directory that only sits inside another
repository is not tagged with that repository's HEAD (PR 50's review); `writeRuntimeVersion(dir, checkout)`
writes `{ "runtime": <tag> }` to `dir/runtime-version.json`; `readRuntime(dir)` reads it
back, `unknown` when the file is missing, empty or malformed; `RUNTIME` is the read of
the file beside the module. Run as a script, the module writes the file beside itself
with the tag of the directory above, so `pnpm build` is `tsc -p tsconfig.json && node
dist/runtime-version.js` and bakes `dist/runtime-version.json` into the build; `dist/` is
git-ignored already. A process running from source (vitest) or from a `dist/` without the
file stamps `unknown`.

The store: `Event` gains `runtime` (a non-empty string or null), the `events` table gains
`runtime TEXT`, `write` stamps `RUNTIME` on every event and `insertEvent` inserts it,
`rowToEvent` reads it, and `replay` re-inserts each event with the tag it carried, never
the replaying build's, which is what reproduction depends on. `SCHEMA_VERSION` is 8;
migration step 7 adds the column, and every event from before reads null. The column is
added ahead of step 5 too (`addRuntime`, guarded by `hasColumn`), since step 5 writes a
`leader.released` event and the stamp needs the column; verified by removing the call,
which fails the version 5 test with `no such column`.

`incident events` prints `runtime: <tag>` before the first event and again before any
event whose tag differs from the one before it; `incident review` prints `runtimes: N:
<tag> (events a to b), ...` after the transfers line, one entry per stretch of the log
written by one build, in the order the log switches between them, an untagged stretch
named `none recorded (written before the tag)`, or `runtimes: none` on an empty log
(`describeRuntimeTag` and `runtimesLine` in `src/review.ts`).

Reproduction is documented in DESIGN.md Step 2, with no command: check out the tagged
commit, `pnpm build`, replay the events with `sequence` below the first event the call
wrote (not its answer: an IC call writes `leader.started`, after a handoff the transfer,
and on a refused-then-retried turn `command.failed` and the release, before it answers;
PR 50's review) into a fresh store with `Store.replay` (the system events with them), and
call that build's renderer on it: `renderChangeReport` and `renderLeaderOrientation`,
which the store feeds, and `renderPlannerInput` with the providers from `getProvider`;
`renderTurnPrompt` is left out, since it takes the leader loop's in-memory state. The
transcript is the check. DESIGN.md Step 2 (the `events`
row, version 7, the reproduction paragraph) and Step 7 (`events`, `review`), README's
build paragraph and `docs/architecture.html`'s incident-file node follow.

Tests: `test/runtime-version.test.ts` (new) pins `describeRuntime` on this checkout
against `git rev-parse HEAD` and the tree's dirtiness, `unknown` on a directory that
does not exist and on a directory nested inside this checkout (verified by dropping the
root check, which fails it), `writeRuntimeVersion` into a temp directory read back by `readRuntime`
with the same tag, `unknown` from a missing, empty or malformed file, and `RUNTIME`
non-empty. `test/store.test.ts` pins that every event a store writes, incident and
system, carries `RUNTIME`; that a replay keeps each event's own tag; and the version 7
migration: the events written before read null, one written after carries `RUNTIME`, and
a replay keeps the nulls; the version 5 test drops the `runtime` column too and pins the
migration's own event as tagged. `test/incident-commands.test.ts` pins the `runtime:`
header on `events`; `test/review.test.ts` pins `runtimes: 1: <RUNTIME> (events 0 to N)`
on the stub run and, on a hand-built log, four stretches with the untagged one named. The
schema version pins move from 7 to 8 and the review test's event helper carries
`runtime: null`. `pnpm check` exits 0; the built binary on a scratch store prints the
clean commit's SHA in `events` and `review`.

Not exactly to spec, with reasons:

- The version module is one TypeScript file that is both the reader and the build's
  writer (`node dist/runtime-version.js` after `tsc`), rather than a generated
  `src/runtime-version.ts` or a separate script: a generated source file would have to
  exist before `pnpm typecheck` and `pnpm test`, which CI runs before `pnpm build`, and a
  script outside `src/` would need its own type declaration for the test to import it.
  The JSON is the generated artifact and lives only in `dist/`.
- The dirty check counts tracked files only (`--untracked-files=no`), so an untracked
  scratch file does not mark a build dirty; the plan says "a dirty tree" without saying
  which.
- Under vitest the tag is `unknown` (no build has run beside `src/`), so the store and
  command tests pin `RUNTIME` rather than a SHA; the build test asserts the SHA on the
  file the build step writes, which is what `dist/` carries.
- `Event.runtime` is required in the schema (nullable, not optional), so an event built
  in code says what it carries; the one hand-built event helper in the tests gained
  `runtime: null`.
- R4-11 (saved configs) is being built in parallel and also raises the schema version;
  whichever merges second renumbers its step and pins.

## R4-11: Saved unit configs (#51, merged 2026-09-15)

R4-11 of the round 4 plan, ruled by Mauria on 2026-09-15 (13:00 to 13:34): a unit is a
type plus a config, the config is the filled form, and when the planner keeps filling the
same form with the same answers, that config is saved under a name and deployed by name
without thinking about the fields again, which is ICS resource typing (the planner
outfitting a unit); the role text is part of a saved config. Built on R4-10 (#49) in two
code commits and a docs commit: the table, the config on a unit and the proposal that
names one; then the commands, the offer and the review.

The saved config (`UnitConfig` in `src/models.ts`): a `name`, the `type`, the `form` (the
filled form less the objective and the parent, as JSON keyed by the type: for `base` the
leader, equipment, Bash allowlist and, when the unit has one, the role text; PR 49's
design reviewer's note, so a later type's config is saved the same way), `savedFrom` (the
incident and unit) and `savedAt`. `src/configs.ts` reads a unit's saved form off its
type's form (`savedFormOf`: every form field but `objective`, a null role left out),
keys a form (`formKey`: the type and the form through `stable`, which moved from the
validator to `src/models.ts` so `configs.ts` imports no validator), builds the config
from a unit (`configOf`), finds the saved config a unit's form matches
(`matchingConfig`), counts the units filled the same way by hand across the file
(`unsavedRepeats`), prints a form on one line (`describeForm`), and outfits a plan.

The store (`src/store.ts`): `SCHEMA_VERSION` is 9 (rebased over R4-12's 8 after #50
merged); `units` gains `config` (null when the
form was filled by hand); the `unit_configs` table (`name` primary key, `type`,
`form_json`, `saved_from_incident_id`, `saved_from_unit_id`, `saved_at`; no foreign
keys, since a config outlives its incident and its event replays before any incident's);
migration step 8 adds the column, and the table arrives with the schema; the
`unit.create` mutation's preprocess (`withConfig`, over `withType`) reads a unit recorded
without a config as filled by hand, so a round 4 log replays to the same rows; the
`config.save` mutation, written by `saveUnitConfig` as the system event `config.saved`
(scope `system`, no incident, `EventType` gains it), inserts the row, and `apply` refuses
it under an incident; `listUnitConfigs`, `getUnitConfig` and `listAllUnits` (every
incident's units, for the repeat count) read; `STATE_TABLES` carries each table's
ordering column so `snapshot` orders `unit_configs` by name. The `events` table is
untouched; every event this PR writes carries R4-12's runtime tag as the rest do.

The proposal (`UnitProposal` in `src/models.ts`): `BaseUnitForm.partial` on `leader`,
`equipment` and `bashAllowlist`, extended with `config` (optional, described for the
planner) before `ref`, `parent`, `type` and `takes`, so the planner's schema stays one
strict object with the three fields optional in it; a proposal naming no config and
leaving one of the three unfilled parses and is Config exists's to reject (PR 51's
review: a `superRefine` there made such a draft fail `ActionPlan.parse` before
`plan.proposed` was recorded, so `step` exited 1 and the planner's call was lost from
the log; a rule rejection is recorded and read next cycle). `OutfittedUnit` and
`OutfittedPlan` (`src/configs.ts`) are
the proposal and plan with every form whole; `outfit` fills a proposal's leader,
equipment, Bash allowlist and role from the config it names where the proposal gave none
(a field given beside `config` overrides the config's) and throws on a form still not
whole; `configReasons` says why a proposal has no whole form: no config and a field unfilled,
naming the fields, or a config not saved or of another type.

The validator (`src/validator.ts`): `ValidationContext` gains `configs`
(`store.listUnitConfigs()`); the rule "Config exists" (sixteen now; `PLANNER_RULES`
carries its line) refuses a name not saved, with the names saved, and a config of another
type, with both types; `validatePlan` runs it first on the plan as proposed and, when it
rejects, returns those rejections alone, since a unit whose config cannot outfit it has
no form for the other rules to read; otherwise it outfits the plan, every rule reads the
outfitted plan (`Rule` takes an `OutfittedPlan`; Model known reads the config's model),
and the verdict's `plan` is the outfitted one. `applyPlan` outfits the plan it is given
against the store's configs (idempotent on a whole proposal, so a caller that skipped the
validator gets its units whole) and writes `config` on each new unit.

The planner (`src/planner.ts`): section 8 ends with the saved configs, each by name with
its type and fields, so the ten sections stand; the preamble says section 8 lists them,
to deploy one by name in `config` when it fits, filling only the objective and the parent
and giving a field beside `config` only to override it, and to fill the form by hand only
when none fits.

The commands (`src/commands/config.ts`, a third command group `config` in `src/cli.ts`,
help and dispatch covering it): `config save <incident> <unit-id> <name>` (a name is
saved once: a taken name exits 2, a missing argument 2, an unknown incident or unit 4, and
a unit of a type a plan may not create, command, 2 naming the plannable types, since no
plan could deploy its config and the name would be burned (PR 51's review); prints the
fields and how a plan deploys it), `config list` (one line each: name, type,
fields, when and where from; a sentence when none is saved) and `config show <name>` (in
full, the role text whole; 4 when not saved). `step` (`src/commands/incident.ts`) prints
each proposal's seat as the config it names, the leader it gives, or both
(`proposalSeat`), applies the validator's outfitted plan (`verdict.plan`, so the plan is
outfitted once; PR 51's review), names the saved config on each unit created, and after
the plan is applied prints the offer (`saveOffers`): each new unit of a plannable type filled by hand
is compared with every unit in the file, across incidents, and when the same filled form
has now appeared `SAVE_OFFER_REPEATS` (3) times or more unsaved and no saved config
matches it, one line per distinct form names the unit, the form, the count and the
`config save` command to run; nothing is saved by `step`. `incident review`
(`src/review.ts`) names each unit deployed from a saved config under its cycle
(`configDeployed`, read off the `unit.created` mutation) and counts them at the end
(`units from saved configs`). `incident show` prints every unit on a line under the unit
counts, with `describeLeader`'s parenthetical, which names the saved config a unit was
deployed from (`(base, from config reader; leader …)`) in `show`, `tree` and the
planner's section 3, so a live incident tells a hand-filled unit from a deployed one
(PR 51's review).

Tests: `test/configs.test.ts` (new) pins the saved form, the key, the repeat count, the
matching config, the one-line form, outfitting with an override and its reasons, section
8 listing a saved config, and the three commands with their exits and output.
`test/validator.test.ts` pins Config exists in the failing table and in its own case: an
unknown name and a wrong-typed config refused with the reasons, a unit naming no config
with its three fields unfilled refused naming them and recorded as `plan.rejected`, the
passing plan outfitted with the config's fields, an override, and a config on an unserved
model failing Model known through the outfitted unit. `test/run.test.ts` drives the
acceptance on the stub: a unit filled by hand, `config save`, the next plan naming the
config, the applied unit carrying its fields and the name, `step`, `show`, `tree` and `review` naming
it; and the offer printed on the third repeat and not the second, nothing saved.
`test/store.test.ts` migrates a version 8 file, replays a pre-R4-11 log to the same
snapshot, round-trips a saved config through the row and the log as a system event and a
unit deployed from it, and refuses a second save under a name. `test/units.test.ts` pins
`config` in the proposal's schema and that the three parse as absent without one; the
models test pins the same on `ActionPlan`; `test/configs.test.ts` pins the refusal of
saving command; the planner snapshot and the rule
count, the event type count (51) and the schema version pins (9) follow; the R4-10
round 4 store test also strips the `config` column and key.

Not exactly to spec, with reasons:

- The config is recorded on the unit as a `config` column (and so in the `unit.create`
  mutation), not as a separate event or a field on `plan.applied`: `incident review`
  reads the log, and the `unit.created` mutation is where the unit's other fields are, so
  a replay carries the name with the row.
- "The same filled form" is the type and the saved form (`savedFormOf`) as key-sorted
  JSON (`stable`), compared across every incident in the same database; arrays keep their
  order, so `["Read", "Grep"]` and `["Grep", "Read"]` are two forms, as the planner wrote
  them.
- A saved config is a system event, `config.saved`, so the `unit_configs` table is
  rebuildable from the log like every other state table; the plan block names the table
  only. A replay applies system events first, so a saved config is restored before any
  incident's plan names it.
- A plan naming a config that is not saved, or is of another type, is rejected on Config
  exists alone, and the other rules are not reported for that plan: such a unit has no
  leader, equipment or allowlist for them to read. The planner names a saved config on the
  redraft and then sees the rest.
- The offer prints on the third repeat and on every later one while the form stays
  unsaved (three or more, not exactly three), and stops once a saved config matches the
  form; the acceptance names the second and the third.
- A name is saved once; there is no overwrite or delete command. Changing a config means
  saving another name.
- `step` prints the offer; `incident run` prints it through `step`'s cycle. The offer
  reads the file after the plan is applied, so the unit just created counts.
- `applyPlan` outfits the plan it is given as well as taking the validator's outfitted
  `verdict.plan` from `step`: the tests call it with plain plans, and outfitting a whole
  proposal changes nothing.
- The IC's review turn reads the draft as proposed (a `config` name, not the fields), as
  the planner wrote it; the outfitted form is what the validator and `applyPlan` see.
- `docs/architecture.html`'s command line under the CLI node gains `review`, which it
  omitted, beside the three config commands.
- For the next type (PR 49's design review, still open): a saved form is read back as the
  base form's fields in `outfit`, since `base` is the one type a plan may create; a second
  plannable type needs `UnitProposal` built from the registry first.

## R4-13: Fourth run (#52, merged 2026-09-15)

R4-13 of the round 4 plan, the last row: the first incident's objective run live a fourth
time with every code row of round 4 merged (PRs 40 to 51, the runtime tag `3b2cd7a` on every
event), on `~/.noscope/fourth-run.sqlite`, from roughdraftplus at 6a996e8 with the scratch
document restored before `create`, run 003's objective, constraints and priority, and
`--ic-model claude-opus-5` chosen so that R4-7's fallback would be exercised. Stepped by hand
by the session running the build, which answered the size-up's two questions as the
operator. Written up under "## Fourth run" in `docs/first-incident.md` in the third run's
form: the run, the answer and how it was reached, the measures beside runs 001 to 003 with a
per-seat account of the cost difference, the IC's verdicts by kind with what each cost, the
wall time per cycle beside the tasks' summed seconds, the round-4 changes step by step, and
what the run found in the runtime as candidates for round 5. Docs only; no code changed.

The acceptance holds. Run 004 reached `satisfied` in three operational periods (four `step`s,
the first a rejected command turn) with the same code path named as runs 001 to 003, the
bare `.focus()` at `PageCard.tsx:1884` in `deleteComment` scrolling a selection that already
sat at the document end. The IC neither revised nor reassigned any unit: both reports were
accepted, so R4-3 and R4-4 had no occasion and the write-up says so. The selection's origin,
open since run 003, was not settled: the IC recorded it as a residual at confidence 0.5
(`001-c209`), outside the objective. $15.96 at list rates against run 003's $4.86, the IC on
Opus 5 and then Opus 4.8 ($5.83 against $1.28) and the planner putting every leader and
session task on Opus 5 ($8.12 against $2.93) being the difference.

What the run measured of round 4: R4-8 held on objectives and units and not on questions;
R4-5's "Situation grounded" rejected the IC's first turn for inferred links under invented
claim ids, there being no claims yet; R4-7 captured the category, fell back once and ran
five calls on Opus 4.8 with no refusal; R4-6 ran three deterministic tasks under command
with no leader turn; R4-9 started five tasks together and gained nothing (0.92x in both
cycles that ran tasks) because one unit did the session work each cycle and the code unit's
investigates ran inside its leader's session; R4-1, R4-2, R4-10 and R4-12 did what their
rows say; R4-11 had no occasion with two units.

Docs travelling with the change: `CLAUDE.md`'s "What to read next" row (four runs) and its
note on the refusal (the fallback exercised); `README.md`'s line on `docs/first-incident.md`;
`DESIGN.md`'s Reference row on the refusal (seen a second time, the category captured), the
Model choices rows for the initial IC (the questions clause did not hold) and the fallback
(Opus 4.8 did not refuse), and the Speed section's pointer at the fourth run with the
measured factor.

Not exactly to spec, with reasons:

- The plan's row promises "what each revise or reassign cost and found"; none happened, so
  the verdicts table carries the two accepted verdicts and the three draft verdicts
  (approve, correct, approve) with their costs, and says plainly that no revise or reassign
  occurred.
- The measures table's new column matches the earlier columns' form (fragments beside
  fragments), since the three earlier columns are copied verbatim from the third run's
  table; the tables new to this section are written in full sentences.
- The write-up counts the run's four `step`s as steps 1 to 4 and its operational periods
  as 1 to 3, because the rejected first turn did not advance the period; `incident review`
  prints the same as "cycle 1 rejected", "cycle 1", "cycle 2" and "cycle 3".
- Which of the stream or the transcript carried the refusal category is not recorded on the
  `command.failed` event, so the DESIGN.md row says the category was captured and not which
  source R4-7's provider read it from.
- The fourth run's grep on `node_modules/@tiptap/core` failed because roughdraftplus is a
  pnpm workspace and the package is under `packages/app/node_modules/`; the write-up
  verified the real path by `readlink` on 2026-09-15 rather than from the run's record,
  and says so.

## R5-7: Independent work runs together (#53, merged 2026-09-16)

R5-7 of the round 5 plan. Built: the planner's rule text, the IC's review ask and
`incident review`'s wall-time line each carry the rule that independent work runs
together, and the validator checks the half of it that can be checked.

The planner's `PLANNER_WARNINGS` (`src/planner.ts`) gains "Independent work runs
together", rendered in section 9 under "warned on, and applied anyway": units and tasks
with no dependency between them belong in the same period and start at once, so a unit
that can start now goes in this plan and never the next; a task waits only for a task
whose result it takes, named in its `evidenceFrom.tasks`; a `dependsOn` on a task the
dependent does not read is a wait for nothing; a code reading never waits behind a
reproduce it does not need; a wait the plan needs for another reason is kept and the
rationale says why. The validator's `WARNING_CHECKS` (`src/validator.ts`) checks the
checkable half: each `dependsOn` naming an open task or a ref of this plan whose id the
task does not name in `evidenceFrom.tasks` draws one warning, since the dispatcher holds
the dependent, and its unit's pass, until the dependency completes and the brief carries
nothing from it (`briefContext` attaches only what `evidenceFrom` names); a completed
dependency holds nothing and draws nothing, and one that will never complete is
Dependencies resolve's to reject. The R4-9 sentence in the planner's preamble ("Independent
tasks run at once, across units and within one (only tasks inside a leader's session run
one at a time)...") is untouched; R5-4 owns the inside-the-leader clause.

The IC's review prompt (`renderReviewPrompt` in `src/ic.ts`) ends every review, of a
draft or a redraft, with `SERIALIZED_WORK_ASK` on a line of its own: whether the draft
serializes independent work, a unit or task left for the next period that could start now
or a `dependsOn` on a task whose result the dependent does not name, and to correct or
amend such a draft naming what runs together. The role text (`src/units/ic.ts`) is
unchanged.

`incident review`'s wall-time line (`wallTimeLine` in `src/review.ts`) now reads `wall
time: cycle N s, dispatch N s; K task(s) summing N s, parallel Rx; critical path N s (t1 ->
t2), Px possible`: `criticalPath` walks the `dependsOn` graph of the tasks that recorded
usage in the cycle (a task's seconds summed over its usages, so a refused call's and its
retry's count together) and returns the chain whose seconds sum highest, named in run
order; `possible` is the summed seconds over the chain's, an upper bound on `parallel`,
what the plan's dependencies allowed, which `parallel` never reaches since its span also
holds the leader turns. A dependency that completed in an earlier
cycle held nothing in this one and is off the graph; a task the log has no `dependsOn`
for stands alone. Run 004's period 1 would read `critical path 278.0 s (<the reproduce's task
id>), 1.00x possible` beside its `parallel 0.92x`, which is the evidence the row was written from:
the reproduce was the only session task that ran while the code unit's investigate waited
on a grep that had failed at once; period 2 would read 375 seconds of path under 612 of
work, 1.63x possible against 0.92x measured. `secondsByTask` replaces
`ranInCycle` and the summed `taskSeconds` in `renderReview`, and the "failed before
running" check reads it. DESIGN.md Step 4 (the review's ask), Step 5 (the warning table,
now two rows), Step 6 (the wall-time sentence), Step 7 (the review row) and the Speed
section follow; `docs/architecture.html` follows on cycle steps 4 and 5 and the speed
line. README and CLAUDE.md enumerate neither the warnings nor the line, so they are
unchanged.

Files touched, for the merge order: `src/planner.ts` (one line added to
`PLANNER_WARNINGS`), `src/validator.ts` (one entry added to `WARNING_CHECKS` and its
comment), `src/ic.ts` (a constant above `renderReviewPrompt` and one line in its array),
`src/review.ts` (`wallTimeLine`'s signature and last lines, the new `criticalPath`, the
`task.usage` loop's accumulator, the failed-before-running check), and the tests and docs
named below. Nothing was rewritten.

Tests: the planner snapshot shows the warning in section 9 and the stub-call test pins its
first clause; the validator warns on a `dependsOn` naming an open task the dependent does
not read, records `plan.warned`, and draws nothing for a ref named in `evidenceFrom.tasks`
or a completed task (the passes-every-rule fixture now names the running task it waits on
in `evidenceFrom.tasks`); the IC test pins the ask on the draft's review and the
redraft's; the review test on the scripted run pins the line with its critical path (the
one grep, 1.00x possible), and a review test on a synthesized log with two independent
units prints the reproduce alone as the path (278 s of path under 379 s of work, 1.36x
possible), the grep-then-investigate chain as the path when the reproduce is shortened
(101 s, `a1 -> a2`, 1.59x), and leaves a dependency from the previous cycle off the chain.
`pnpm check` exits 0.

Not exactly to spec, with reasons:

- The plan says "the planner's rule text says"; the text is a warning the validator
  applies, not a sentence in the preamble, because section 9 is where the planner reads
  rules by name, the acceptance says the snapshot shows the rule, and a rule listed under
  "rules the validator applies" that the validator did not apply would be false. The
  validator can check only the wait-for-nothing half (a `dependsOn` with no
  `evidenceFrom.tasks` behind it); whether a unit was left for a later period is not
  visible in one plan, so that half is text and the IC's ask.
- It is a warning and never a rejection, since a plan may order two tasks for a reason the
  runtime cannot see, two reproduces on one dev server for instance; the rationale carries
  the reason and the IC's review weighs it.
- The IC reviews before the validator runs in the current cycle order (R5-3 reverses it),
  so the ask does not point the IC at the validator's warnings; it names the same shape in
  its own words so it holds under either order.
- Review of PR 53 found that run 004 did not exhibit the wait-for-nothing shape: every
  `dependsOn` in its plans was also in `evidenceFrom.tasks` (001-t06 and t07 named t01,
  t02 and t05; t10 and t12 named all of theirs), and the code unit's idle came from a real
  evidence dependency on a grep that failed in 4 milliseconds, which R5-10's row settles.
  The warning guards a shape the runtime cannot otherwise tell from a needed wait; the
  comments, the warning text and DESIGN.md say so rather than crediting it with run 004.
  The warning's reason also offers the rationale as the third way out, so a planner does
  not attach unread evidence to silence it, and `possible` is written as an upper bound on
  `parallel` rather than a value it could reach.
