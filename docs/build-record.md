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
