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
none) under the unchanged `IC_ROLE`; `renderTransferBriefing` opens its user message with
the transfer (who it takes command from, under the same role text, at what context), the document rendered section
by section (`renderHandoffDocument`) and the evaluation instruction (say in the rationale
what is accepted, rewritten and discarded, and why), then the change report and the file
as on any command turn, or, before a review, the file and then the draft (`reviewTurn`
already re-briefs a session with no id; it now takes the handoff too). `command.transferred`
(`kind: "handoff"`, `unitId`, `outgoingSessionId`, `incomingSessionId`, `contextTokens`,
`threshold`, `document`) is written by `icCall`'s `started` with the successor's
`leader.started`, the moment its id is known, after `command.turned` or `plan.reviewed` in
the same transaction. `step` prints the handoff (session, context, threshold), the
transfer after the successor's turn, a lost outgoing session, and a pending handoff
resumed. `incident show` prints `IC: <provider>/<model>, session <id or none yet>; N
transfer(s) of command`. `incident review` prices the handoff call under `ic` in its cycle
(`wrote its handoff after N tokens of context`), lists each `command.transferred` with its
kind, both sessions, the context that triggered it and the document's length in JSON
characters, and ends with `transfers of command: N (kinds)`. The stub recognises the
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
session whose system prompt is the IC's and whose briefing opens with the transfer, the
document and the evaluation instruction before the change report, a new session id on the
root unit, `leader.released` with the document and the call's usage before
`command.turned`, `command.transferred` right after it and before `leader.started`, `show`
naming the new session with one transfer and `review` pricing the handoff and listing the
transfer; below the threshold two steps make no handoff call, write no release or
transfer and keep the session; a command turn at 6,500 hands off before the review, whose
fresh session is briefed with the transfer and the document before the file and the draft,
with `leader.released`, `plan.reviewed`, `command.transferred`, `leader.started` in that
order, and the next step resumes the successor; an outgoing session that cannot be resumed
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
`contextTokens` 9,357 on the live fixture and 1,500 on the stub. The models test counts 40
event types.

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
- The evaluation instruction asks for the evaluation in the command turn's `rationale`
  rather than adding a field to `CommandTurn`, since R3-8, built in parallel, owns the
  first briefing's evaluation and any field it adds; the rebase can point both at one.
- `command.transferred` is defined here with `kind: "handoff"` and a payload of
  `unitId`, `outgoingSessionId`, `incomingSessionId`, `contextTokens`, `threshold` and
  `document`; R3-8 defines the same event with `kind: "initial"` and the briefing as its
  document, and the rebase reconciles the two definitions to one.
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
