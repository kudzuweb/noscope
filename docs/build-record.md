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
