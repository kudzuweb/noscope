# ics-runtime: design and v0 build plan

## Overview

A Python runtime that pursues an objective by building and revising a temporary
organization around it. The durable layer is capabilities, state and history. The
organization is a tree of responsibility recomputed each cycle. One LLM call per cycle
proposes changes to that tree as a structured patch; deterministic code validates the patch,
commits it, dispatches the resulting assignments, records results, and repeats.

v0 proves one thing: that an organizer restructuring responsibility in response to evidence
produces better investigation than a flat agent picking tools. v0 is read-only, manually
stepped, and visible at every step. Side effects, memory across cases, recursion, parallel
workers and human participation come after v0 works.

Settled before this document, on the ics-runtime and quipu-cli threads:

| Decision | Because |
|---|---|
| Build fresh, not on glove. | Glove has not been touched in months and the advice that grafted onto it rested on unverified details. |
| A standalone Python runtime owns the loop, with headless Claude Code as one capability among others. | A skill is advice and cannot enforce the propose-then-validate boundary; code can. |
| Capabilities carry their own system prompt, model and tool list as fields. | A stripped headless session costs about 3k tokens of context against about 40k for a default one, and the model must be passed explicitly because user settings are what select it. |
| Narrow capabilities may run on Haiku. | Context load and price scale with the model, and a two-tool read-only worker needs no more. |
| New repo under kudzuweb, cloned to `~/Documents/Projects/ics-runtime`. | It keeps the runtime separate from lil-guy-quipu and roughdraftplus, which will later be its users. |
| Build this first, then use it to work on roughdraft and quipu. | Sequencing set by Mauria on 2026-09-12. |

Proposed in this document and not yet ruled: SQLite as the store, the `anthropic` SDK plus
`pydantic` as the only dependencies, Opus 5 as the organizer model, the schema, the
validator rules, the CLI surface, and the first case.

## Vocabulary

| Term | Meaning |
|---|---|
| Case | An objective pursued over time, with constraints. One row; many cycles. |
| Unit | A node of responsibility in the case's temporary tree. It has a purpose and a parent, opens and closes, and carries no prompt. The root unit is `command`. |
| Assignment | A bounded piece of work owned by one unit and bound to one capability: objective, inputs, expected output, completion criteria, evidence required, dependencies. It becomes the worker's brief. |
| Capability | Something that can perform work: a Python function, a shell command, a headless Claude Code session, later a human. Registered in code with name, description, schemas, side-effect level, and for Claude-backed ones the system prompt, model and tool list. |
| Claim | A statement about reality with epistemic status `candidate`, `verified` or `rejected`, plus provenance. LLM output enters as `candidate`; only deterministic verification promotes it. |
| Event | One append-only record of something that happened, written in the same transaction as the state change it describes. |
| Patch | The organizer's proposal for one cycle: units to create or close, assignments to create or cancel, case status. Validated before anything commits. |
| Cycle | Observe, organize, validate, dispatch, record, stop. `case step` runs exactly one. |

## Build steps

### Step 1: repository skeleton

Python 3.12 or later. Dependencies: `anthropic` for the organizer call and `pydantic` for
every contract. Everything else is the standard library.

```text
ics-runtime/
├── DESIGN.md
├── README.md
├── pyproject.toml
├── ics/
│   ├── cli.py            # the command surface
│   ├── runtime.py        # the cycle
│   ├── store.py          # SQLite: schema, transactions, queries
│   ├── models.py         # pydantic contracts shared by every module
│   ├── organizer.py      # the one LLM call per cycle
│   ├── validator.py      # patch rules
│   ├── dispatcher.py     # runs ready assignments through capabilities
│   ├── verifier.py       # turns results into claims
│   ├── tree.py           # renders the unit tree and the event log
│   └── capabilities/
│       ├── registry.py   # decorator and lookup
│       ├── filesystem.py # read_file, list_directory, grep_files
│       ├── git.py        # git_status, git_log, git_diff
│       ├── shell.py      # allowlisted read-only commands
│       └── claude.py     # headless Claude Code as a capability kind
└── tests/
```

### Step 2: storage

One SQLite file per installation, WAL mode. Current-state tables plus an append-only event
table, updated in the same transaction. No event sourcing: state is read from the tables,
and the events explain how it got there.

| Table | Columns |
|---|---|
| `cases` | `id`, `objective`, `constraints_json`, `status` (`open`, `satisfied`, `failed`, `blocked`), `created_at`, `updated_at` |
| `units` | `id`, `case_id`, `parent_id`, `purpose`, `status` (`active`, `closed`), `created_at`, `closed_at` |
| `assignments` | `id`, `case_id`, `unit_id`, `capability`, `objective`, `inputs_json`, `expected_output`, `completion_criteria_json`, `evidence_required_json`, `depends_on_json`, `status` (`pending`, `ready`, `running`, `completed`, `failed`, `cancelled`), `result_json`, `created_at`, `completed_at` |
| `claims` | `id`, `case_id`, `subject`, `predicate`, `object_json`, `status` (`candidate`, `verified`, `rejected`), `confidence`, `provenance_json`, `created_at` |
| `events` | `id`, `case_id`, `sequence`, `type`, `actor`, `payload_json`, `created_at` |

Event types in v0: `case.created`, `case.closed`, `unit.created`, `unit.closed`,
`assignment.created`, `assignment.started`, `assignment.completed`, `assignment.failed`,
`assignment.cancelled`, `claim.proposed`, `claim.verified`, `claim.rejected`,
`patch.proposed`, `patch.rejected`, `patch.applied`.

Capabilities are not a table. The registry is code, and `case show` prints what is
registered.

### Step 3: the capability contract

Every capability is a Python object registered by decorator. The registry describes what
can be done, never when.

```python
@capability(
    name="grep_files",
    description="Search files under a directory for a pattern",
    side_effects="none",
)
def grep_files(inputs: GrepInputs) -> GrepResult: ...
```

Fields on every capability:

| Field | Meaning |
|---|---|
| `name` | The identifier the organizer uses in a patch. |
| `description` | One sentence the organizer sees. |
| `input_schema`, `output_schema` | Pydantic models. The validator checks assignment inputs against the input schema before dispatch. |
| `side_effects` | `none`, `local_reversible` or `external`. v0 registers only `none`. |
| `returns` | `verified` for deterministic capabilities whose output is a fact about the machine, `candidate` for anything an LLM produced. |

A Claude-backed capability adds the fields that define its setup, and the runtime renders
the headless command from them:

| Field | Renders to |
|---|---|
| `system_prompt` | `--system-prompt <text>` |
| `model` | `--model <id>`, always explicit |
| `tools` | `--tools "<list>"` |
| `allowed_tools` | `--allowedTools <list>`, so read-only tool calls need no approval |
| `cwd`, `add_dirs` | The working directory and `--add-dir` entries |
| `output_schema` | `--json-schema <schema>`, so the result comes back structured |

Fixed flags on every Claude-backed invocation: `--output-format json`,
`--no-session-persistence`, `--setting-sources ""`, `--disable-slash-commands`,
`--exclude-dynamic-system-prompt-sections`. Those five are what drop a worker's context from
about 40k tokens to about 3k and keep Mauria's personal CLAUDE.md, skills and hooks out of it.
`--bare` is not used because it authenticates only with an API key.

The assignment is the user message: objective, inputs, expected output, completion
criteria, evidence required, and the owning unit's purpose as one line of context.

v0 capabilities:

| Capability | Kind | Model |
|---|---|---|
| `read_file`, `list_directory`, `grep_files` | Function | none |
| `git_status`, `git_log`, `git_diff` | Function | none |
| `run_readonly` | Shell, allowlist of `ls`, `cat`, `head`, `tail`, `wc`, `find`, `stat` | none |
| `investigate` | Claude-backed, tools `Read,Grep,Glob,Bash` with Bash allowlisted to the same read-only commands, returns candidate claims with evidence | `claude-haiku-4-5` |
| `interpret` | Claude-backed, no tools, given evidence and asked what it implies, returns candidate claims | `claude-haiku-4-5` |

### Step 4: the organizer

One call per cycle, through the Anthropic API with structured output, so the response is a
validated `OrganizationPatch` and never prose. Model `claude-opus-5` with adaptive thinking.
Input, rendered as labeled sections in a stable order so the prefix caches:

1. The case objective and constraints.
2. Verified claims.
3. Candidate claims, each with its provenance.
4. The current unit tree with each unit's purpose and status.
5. Assignments completed since the last cycle, with results summarized against their contracts.
6. Open assignments.
7. The capability registry, names and descriptions only.
8. The rules the validator will apply, so the organizer does not propose what will be rejected.

Output:

```python
class OrganizationPatch(BaseModel):
    create_units: list[UnitProposal]          # purpose, parent unit
    close_units: list[str]                    # unit ids, with a reason each
    create_assignments: list[AssignmentProposal]
    cancel_assignments: list[str]
    claims_to_verify: list[str]               # candidate claim ids worth promoting
    case_status: Literal["continue", "blocked", "satisfied", "failed"]
    rationale: str                            # recorded on the patch event, never acted on
```

The organizer proposes structure. It never runs a tool, never writes to the store, and never
marks its own conclusions true.

### Step 5: the validator

Every patch passes all of these or is rejected whole, with the failing rule recorded as a
`patch.rejected` event and fed back as input 8 on the next cycle:

| Rule | Check |
|---|---|
| Capabilities exist | Every assignment names a registered capability. |
| Units exist | Every assignment's unit and every new unit's parent exist or are created in this patch. |
| No cycles | The tree stays a tree. |
| No duplicates | No new assignment repeats an open or completed one with the same capability and inputs under the same unit. |
| Inputs validate | Assignment inputs parse against the capability's input schema. |
| Span of control | No unit ends the patch with more than 7 direct children, units and assignments combined. Target is 5. |
| Side-effect policy | v0 rejects any capability whose side effects are not `none`. |
| Dependencies resolve | Every `depends_on` names an assignment in the case. |
| Closing is clean | A closed unit has no running assignments. |
| Status is earned | `satisfied` requires every open assignment completed or cancelled and at least one verified claim. |

### Step 6: dispatch, record, verify

Ready means every dependency is completed. v0 runs ready assignments sequentially. Each
run writes `assignment.started`, then the result and `assignment.completed` or
`assignment.failed` in one transaction.

The verifier turns results into claims. A function capability's result becomes a `verified`
claim with the capability and inputs as provenance. A Claude-backed capability's result
becomes `candidate` claims with the session id as provenance. Promotion of a candidate in
v0 happens only when a later deterministic result matches it; the organizer can request
that through `claims_to_verify`, which schedules the deterministic check as an assignment.

### Step 7: the command surface

| Command | Does |
|---|---|
| `ics case create "<objective>" [--constraint ...]` | Creates the case and its `command` unit. |
| `ics case show <id>` | Objective, status, claims by status, open assignments, registered capabilities. |
| `ics case tree <id>` | The unit tree with assignment marks: done, running, ready, pending. |
| `ics case step <id>` | One cycle, then stop. Prints the patch, the validator's verdict, what ran, what changed. |
| `ics case run <id> [--max-cycles N]` | Repeats `step` until the case leaves `open` or the cap is hit. |
| `ics case events <id>` | The event log with timestamps and actors. |

`step` is the primary command in v0. `run` exists so the milestone can be demonstrated
end to end, not for daily use.

### Step 8: the first case

A real, read-only investigation on this machine, so every step can be checked by hand:

> Determine why saving a document in Roughdraft drops blank lines and adds trailing
> whitespace, and identify the code path responsible, in `~/Documents/Projects/roughdraftplus`.

This is upstream issues 98 and 100, already known to be real, and the answer is
verifiable by reading the code the case points at. The interesting output is not the answer
but the tree: whether the organizer opens separate units for the save path and the
formatter, closes the one that turns out irrelevant, and stops when a verified claim names
the code path.

### v0 acceptance

v0 is done when all of these hold on the first case:

1. `case create` produces a case with one `command` unit and one event.
2. The first `step` yields a patch that creates at least one unit and one assignment, and the validator accepts it.
3. Assignments run and their results appear as claims with the right status.
4. A later `step` closes a unit that has served its purpose, visible in `tree` and `events`.
5. A patch that breaks span of control is rejected and the next patch groups instead.
6. The case reaches `satisfied` with a verified claim naming the code path.
7. Every state change has a matching event, checked by a test that replays events against the tables.

## Reference

### Verified facts the design rests on

| Fact | How it was checked |
|---|---|
| Headless Claude Code runs on the subscription when no API key is set. | A `claude -p` call succeeded on this machine with no `ANTHROPIC_API_KEY` in the environment, 2026-09-12. |
| Default headless context is about 40k tokens in an empty directory and about 56k in the home directory. | Usage fields of test calls, 2026-09-12. |
| `--system-prompt` alone leaves CLAUDE.md and hook output in the worker's context. | A probe worker answered yes to seeing both, 2026-09-12. |
| The five fixed flags in Step 3 bring context to about 3k and remove both. | Usage fields and a probe answering no to both, 2026-09-12. |
| With `--setting-sources ""` the model falls back to Opus 5. | The `modelUsage` field of the test call. |
| `--bare` authenticates only with an API key. | `claude --help`. |
| The Claude Agent SDK requires an API key. | The SDK quickstart, read by a docs subagent; not read directly. |
| `--json-schema` returns a `structured_output` field. | The headless docs, read by a docs subagent; not read directly. |
| Structured output through the API is `output_config.format` with `client.messages.parse()`. | The claude-api skill's current reference. |

### Model choices

| Role | Model | Because |
|---|---|---|
| Organizer | `claude-opus-5` | The patch is the judgment in the system, and the skill's default for anything nontrivial is Opus 5. |
| `investigate`, `interpret` | `claude-haiku-4-5` | Narrow brief, two tools, small context; the cheapest floor. Raise per capability if results are thin. |
| Later builder and reviewer capabilities | `claude-fable-5-1` or `claude-opus-5` with full repo, skills and hooks | Not in v0. |

## Open questions

| Question | Blocks |
|---|---|
| Whether `--json-schema` and `--tools` behave as documented on the installed version; the docs were read secondhand. | Step 3's Claude-backed capability. Answered by one test call before writing `claude.py`. |
| Whether the organizer should see the full text of completed results or only their summaries against the contract. | Step 4's input rendering. Start with summaries plus evidence pointers; widen if the tree stops changing shape. |
| Whether `interpret` is worth having in v0 or whether `investigate` covers it. | Step 3's registry. Drop it if the first case never needs it. |
| The repo's GitHub name and whether it is public. | The push, not the build. |
