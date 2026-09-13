# Build record

One entry per PR, appended when the PR merges: what was built, why, and whether it matches
`BUILD-PLAN.md` and `DESIGN.md` exactly. Where it does not, the deviation and its reason are
here, and the design or plan was updated in the same PR.

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

