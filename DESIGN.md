# noscope: design and v0 build plan
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
| Capabilities carry their own system prompt and Claude Code tool list as fields. | A stripped headless session costs about 3k tokens of context against about 40k for a default one, and the model must be passed explicitly because user settings are what select it. |
| {==Model routing: every assignment to a session-backed capability names its model from an allowlist, and capabilities carry no default, so the same capability runs on Haiku for a narrow job and on Opus for a subtle one.==}{>>we're just gonna incorporate model routing. some capabilities will have a fixed model but we should also be able to choose the right model for new capabilities, or use the same capability with different models for different purposes. we may actually need to fully talk about the ICS structure and how we're mapping it over to make sure we're on the same page<<}{id="c1" by="user" at="2026-09-12T20:49:38.101Z"}{>>Changed to model routing; then per your c20, no defaults: the assignment names the model every time, the validator requires it from the allowlist. Wired through Step 2 (assignments.model), Step 3 (the model field), Step 4 (AssignmentProposal.model) and Step 5 (the Model allowed rule). The ICS mapping is now a table right after the vocabulary.<<}{id="r1" by="AI" at="2026-09-12T21:18:00.000Z" re="c1"} | Context load and price scale with the model, and a narrow read-only worker needs no more, while a subtle read needs more; routing per assignment buys both. |
| New repo under kudzuweb, cloned to `~/Documents/Projects/noscope`. | It keeps the runtime separate from lil-guy-quipu and roughdraftplus, which will later be its users. |
| Equipment is the primitive and is never assigned; a capability is declared equipment plus, when judgment is needed, a headless session with a prompt. | Ruled by Mauria in review, 2026-09-12: one word for the assignable thing, and `send_email` is the shape, the mail equipment plus an Opus session that receives a brief and applies it. "Equipment" rather than "tool" so it is not confused with Claude Code's tools and does not narrow what counts. |
| The repository is `kudzuweb/noscope`, private for now, public later. | Ruled by Mauria 2026-09-12. She expects to use it at work if it proves out, and that is the point at which it goes public. |
| Every session-backed capability can answer "insufficient": its output schema carries an outcome of `answered` or `insufficient`, and an insufficient result names what evidence it would need. `interpret`, the sandboxed capability with no equipment, stays in v0 because of this. | Ruled by Mauria 2026-09-12. A sandboxed "tell me what you think" cannot go and get more, and that is the point: when it says it cannot answer and why, the organizer gets a precise next assignment and Mauria gets a diagnostic on prompts and assignments. |
| Platform-agnostic: a session runs on a provider, and Claude Code is the first provider, not the only one. Codex is the second. | Ruled by Mauria 2026-09-12. She wants to deploy Codex, or anything else, as a capability. Nothing above the session layer knows which provider ran it. |
| The framework is named `noscope`, one spelling for the repo, the Python package and the command. | Named by Mauria 2026-09-12, after FIRESCOPE, the interagency effort that produced ICS, and for the pun: the whole thing is built so she never has to zoom in. `noscope` is free on PATH, Homebrew and GitHub; PyPI has an unrelated `noscope`, so a PyPI release would be published as `no_scope` with the import name unchanged. |
| Build this first, then use it to work on roughdraft, quipu and the codebase scan. | Sequencing set by Mauria on 2026-09-12. |

Proposed in this document and not yet ruled: SQLite as the store, `pydantic` as the only
dependency, Opus 5 as the organizer model, the model allowlist, the schema, the validator
rules, the CLI surface, and the first case.
## Vocabulary
| Term | Meaning |
|---|---|
| Case | An objective pursued over time, with constraints. One row; many cycles. |
| Unit | A box in the case's temporary tree that owns one slice of the problem, the way an ICS Branch or Group does. It has a purpose, a parent and children, and it opens, subdivides and closes as the organizer's picture of the problem changes. Nothing runs as a unit: assignments run, and their capabilities carry the prompts. The root unit, `command`, owns the objective and is created with the case. |
| Assignment | A bounded piece of work owned by one unit and bound to one capability: objective, inputs, expected output, completion criteria, evidence required, dependencies, and for a session-backed capability the model and any instructions. It is the worker's brief, and for a session it is the prompt the session receives. |
| Equipment | A primitive: a Python function the runtime calls in-process, a Claude Code built-in tool such as Read, Grep or Bash under an allowlist, or later anything else a capability needs to do its work. Registered by name. Never assigned by the organizer. |
| Capability | The assignable thing: declared equipment plus, when judgment is needed, a headless session with a system prompt; the model comes from each assignment. A capability with no session is deterministic and produces verified claims; one with a session produces candidate claims. A capability may include other capabilities. Later, a human. |
| Provider | A program that can run a session: Claude Code first, Codex second, later an HTTP API or a human. A provider maps the session fields onto its own command line and turns its output back into the runtime's result shape. Everything above the session layer is provider-blind. |
| Claim | A statement about reality with epistemic status `candidate`, `verified` or `rejected`, plus provenance. LLM output enters as `candidate`; only deterministic verification promotes it. |
| Event | One append-only record of something that happened, written in the same transaction as the state change it describes. |
| {==Patch==}{>>why is this called patch? are any of these terms from ICS? just curious, answer in chat<<}{id="c5" by="user" at="2026-09-12T21:01:14.077Z"}{>>Not an ICS term; it is the software sense, a proposed set of changes applied to the current state atomically or not at all. ICS has no named artifact for a proposed change to the org chart; reorganization happens through the Planning P and the next Incident Action Plan (verified against NIMS 2017). Which vocabulary is ICS and which is ours is now the table under "ICS mapping" below.<<}{id="r5" by="AI" at="2026-09-12T21:18:00.000Z" re="c5"}{>>assignments can carry prompts too right?<<}{id="c18" by="user" at="2026-09-12T21:31:37.045Z" re="r5"}{>>Yes. The assignment is the prompt a session receives as its user message: objective, inputs, expected output, criteria, evidence required, and now a free-text instructions field. The capability's system prompt is the fixed setup; the assignment is everything specific to this piece of work. Added to the vocabulary, the assignments table and the patch schema.<<}{id="r27" by="AI" at="2026-09-12T21:50:00.000Z" re="c18"}{>>shouldn't there also be a field containing something that plays the role of system prompt so the session knows what kind of role it's playing and that it's in an ICS framework? or is that the wrong level for that info? i want them to stay on the rails lol<<}{id="c27" by="user" at="2026-09-12T22:09:11.352Z" re="r27"} | The organizer's proposal for one cycle: units to create or close, assignments to create or cancel, case status. Validated before anything commits. |
| Cycle | Observe, organize, validate, dispatch, record, stop. `case step` runs exactly one. |

### ICS mapping
Definitions checked against the NIMS Third Edition (FEMA, October 2017) on 2026-09-12.

| ICS term | Here |
|---|---|
| Incident: an occurrence that necessitates a response. | Case. |
| Incident Commander: develops objectives, orders and releases resources. | The root unit `command` holds the objective; the organizer does the ordering and releasing by proposing patches. |
| Section, Branch, Division, Group, Unit: the organizational levels, distinguished by depth and by functional versus geographic responsibility. | All are the one thing called a unit here. Depth is whatever the tree needs, and a unit's purpose says what it is responsible for. |
| Single Resource, Strike Team (same kind and type, one leader), Task Force (mixed kinds for one mission). | A capability is a single resource, and equipment is equipment; the word is ICS's. A capability that includes other capabilities is the strike team or task force. |
| Resource typing: categorizing resources by capability so everyone means the same thing by a name. | The capability registry: name, description, schemas, side effects. |
| Assignment: a task given to a person or team based on the objectives in the Incident Action Plan. | Assignment, same word and meaning. |
| Incident Action Plan and Operational Period: the objectives and tactics for one period, then a new plan. | The applied patch plus the current tree is the plan; one cycle is the operational period. |
| The Planning P: objectives, tactics meeting, planning meeting, plan approval, briefing, execute, repeat. | The cycle: observe, organize, validate, dispatch, record. |
| Span of control: one supervisor to five is the guideline, not a rule. | Validator rule: target 5 direct children, maximum 7. |
| Demobilization: the orderly release of a resource when no longer needed. | Closing a unit and cancelling its assignments. |
| Situation Unit and Resources Unit: who tracks what is known and where every resource is. | The store. Claims are the situation; assignments and their statuses are the resource tracking. |
| Unified Command, Staging Area. | No equivalent in v0. |
| No ICS term. | Patch, claim, event, cycle are ours. |

## Build steps
### Step 1: repository skeleton
Python 3.12 or later. One dependency, `pydantic`, for every contract. Everything else is the
standard library plus the installed `claude` binary, which every LLM call goes through.

```text
noscope/
├── DESIGN.md
├── README.md
├── pyproject.toml
├── noscope/
│   ├── cli.py            # the command surface
│   ├── runtime.py        # the cycle
│   ├── store.py          # SQLite: schema, transactions, queries
│   ├── models.py         # pydantic contracts shared by every module
│   ├── organizer.py      # the one headless Claude Code call per cycle
│   ├── validator.py      # patch rules
│   ├── dispatcher.py     # runs ready assignments through capabilities
│   ├── verifier.py       # turns results into claims
│   ├── tree.py           # renders the unit tree and the event log
│   ├── equipment/
│   │   ├── registry.py   # equipment decorator and lookup
│   │   ├── filesystem.py # read_file, list_directory, grep_files
│   │   ├── git.py        # git_status, git_log, git_diff
│   │   ├── shell.py      # allowlisted read-only commands
│   │   └── builtin.py    # names and allowlists for Claude Code's own tools
│   ├── providers/
│   │   ├── base.py       # the provider interface and the shared session preamble
│   │   ├── claude_code.py
│   │   └── codex.py
│   └── capabilities/
│       ├── registry.py   # capability decorator, contract, lookup
│       ├── session.py    # builds a session request and hands it to a provider
│       ├── deterministic.py  # check_path, read, grep, git_history
│       └── investigate.py    # investigate, interpret
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
| `assignments` | `id`, `case_id`, `unit_id`, `capability`, `objective`, `inputs_json`, `expected_output`, `completion_criteria_json`, `evidence_required_json`, `depends_on_json`, `model` (required for a session-backed capability), `instructions`, `status` (`pending`, `ready`, `running`, `completed`, `failed`, `cancelled`), `result_json`, `created_at`, `completed_at` |
| `claims` | `id`, `case_id`, `subject`, `predicate`, `object_json`, `status` (`candidate`, `verified`, `rejected`), `confidence`, `provenance_json`, `created_at` |
| `events` | `id`, `case_id`, `sequence`, `type`, `actor`, `payload_json`, `created_at` |

Event types in v0: `case.created`, `case.closed`, `unit.created`, `unit.closed`,
`assignment.created`, `assignment.started`, `assignment.completed`, `assignment.failed`,
`assignment.cancelled`, `assignment.insufficient`, `claim.proposed`, `claim.verified`, `claim.rejected`,
`patch.proposed`, `patch.rejected`, `patch.applied`.

Capabilities are not a table. The registry is code, and `case show` prints what is
registered.
### Step 3: equipment and capabilities
Every piece of equipment and every capability is registered by decorator. Equipment is
primitive and the organizer never assigns it. Capabilities are what the organizer assigns.
The registries describe what can be done, never when.

Equipment kinds in v0:

| Kind | Where it runs |
|---|---|
| Python function | In-process, called by a deterministic capability. `read_file`, `grep_files`, `list_directory`, `git_status`, `git_log`, `git_diff`, `run_readonly`. |
| Claude Code built-in tool | Only inside a capability's session, named in that capability's equipment: `Read`, `Grep`, `Glob`, and `Bash` under an allowlist of read-only commands. A capability may instead declare `default` to give its session Claude Code's whole built-in set. |

A Python equipment module is ordinary functions, one module per family, no scripts and no
CLI:

```python
# equipment/filesystem.py

@equipment(name="grep_files")
def grep_files(root: Path, pattern: str, glob: str = "*") -> list[Match]:
    ...  # walks root, returns file, line and text for each match

@equipment(name="read_file")
def read_file(path: Path, max_bytes: int = 200_000) -> FileContents: ...

@equipment(name="list_directory")
def list_directory(path: Path) -> list[Entry]: ...
```

A deterministic capability such as `grep` calls `grep_files` directly, in the runtime's own
process, in milliseconds. Equipment shells out only where the thing itself is a command, as
`git_status` runs `git status --porcelain` and parses it. No session calls Python equipment
in v0.

```python
@capability(
    name="investigate",
    description="Read the files a question points at and return what they show",
    equipment=["Read", "Grep", "Glob", "Bash"],
    bash_allowlist=["ls", "cat", "head", "tail", "wc", "find", "stat"],
    session=Session(system_prompt=INVESTIGATE_PROMPT),
    effect="read_only",
)
class Investigate(Capability): ...
```

Fields on every capability:

| Field | Meaning |
|---|---|
| `name` | The identifier the organizer uses in a patch. |
| `description` | One sentence the organizer sees. |
| `equipment` | What this capability may use. A deterministic capability calls it in code; a session-backed one exposes exactly this to its session. |
| `input_schema`, `output_schema` | Pydantic models. The validator checks assignment inputs against the input schema before dispatch. |
| `effect` | `read_only`, `writes_local` or `writes_external`. v0 registers only `read_only`. |
| `produces` | `verified_claims` for a deterministic capability, whose output is a fact about the machine; `candidate_claims` for a session-backed one. |

A capability with a session adds the fields that define its setup. The session names a
provider, and the provider renders the fields onto its own command from them:

| Field | Claude Code renders it to | Codex renders it to |
|---|---|---|
| `provider` | The choice of column. | The choice of column. |
| session preamble, fixed in `providers/base.py` | The first part of `--system-prompt`, identical for every session on every provider: this session is a resource assigned into a case run by this runtime; the assignment follows; report only against the assignment's contract; findings are candidate claims until the runtime verifies them; the session cannot change the organization or take on work outside the assignment. | Prepended to the prompt, since `codex exec` has no system-prompt flag in its help. |
| `system_prompt` | The rest of `--system-prompt`: the capability's own role text, after the preamble. | Prepended to the prompt after the preamble. |
| `model` | `--model <id>`, always explicit, taken from the assignment. A capability declares no default. | `-m <model>`, same rule. |
| `equipment` | `--tools "<list>"` naming the Claude Code built-in tools in the capability's equipment, or `--tools default` when the capability declares `default`. | `-s read-only` bounds what the built-in shell can do; per-tool selection is not in the help and is an open item for this provider. |
| `bash_allowlist` | `--allowedTools` entries of the form `Bash(<command> *)`, so read-only tool calls need no approval. | Covered by `-s read-only`; a finer allowlist is an open item. |
| `cwd`, `add_dirs` | The working directory and `--add-dir` entries. | `-C <dir>` and `--add-dir`. |
| `output_schema` | `--json-schema <schema>`, so the result comes back structured. Every session schema carries `outcome: answered \| insufficient`; an insufficient result carries `needed`, a list of the evidence or access the session lacked, and no claims. | `--output-schema <file>` with the same schema written to a temp file, and `-o <file>` to collect the final message. |

Each provider has a fixed set of isolation flags, so no session inherits Mauria's personal
setup. Claude Code: `--output-format json`, `--no-session-persistence`,
`--setting-sources ""`, `--disable-slash-commands`,
`--exclude-dynamic-system-prompt-sections`, which together drop a session's context from about
40k tokens to about 3k and keep her CLAUDE.md, skills and hooks out; `--bare` is not used
because it authenticates only with an API key. Codex: `--ignore-user-config`,
`--ignore-rules`, `--ephemeral`, `--json`, verified present in `codex exec --help` on
2026-09-12 and not yet tested for context size or subscription billing. Permissions come only
from the capability's declaration; with the isolation flags, Mauria's own permission settings
do not load on either provider.

The assignment is the user message: objective, inputs, expected output, completion
criteria, evidence required, and the owning unit's purpose as one line of context.

v0 capabilities:

| Capability | Equipment | Session |
|---|---|---|
| `check_path` | `list_directory` | none; produces verified claims |
| `read` | `read_file` | none; produces verified claims |
| `grep` | `grep_files` | none; produces verified claims |
| `git_history` | `git_log`, `git_diff` | none; produces verified claims |
| `investigate` | `Read`, `Grep`, `Glob`, `Bash` under the read-only allowlist | yes, model named per assignment; produces candidate claims with evidence |
| `interpret` | none | yes, model named per assignment; given evidence and nothing else, produces what it implies as candidate claims, or `insufficient` with what it would need |

The four deterministic capabilities exist so the verifier has something to promote claims
with, and so the organizer can ask a precise question without spending a session on it.

A capability may include other capabilities, composed in code. The event log records which
capabilities every case used under which unit purposes; a composition that recurs across
cases with the same shape is a candidate for a new capability, and one whose shape varies
with context stays with the organizer. The quipu CLI's objective catalog is the first
planned set of such capabilities. v0 registers none.
### Step 4: the organizer
One call per cycle, through a provider, {==as a headless Claude Code call on the subscription==}{>>aht aht, subscription-based solutions only for now<<}{id="c10" by="user" at="2026-09-12T21:06:34.909Z"}{>>Changed and tested 2026-09-12: the organizer ran as headless Opus 5 with the five stripped flags, no tools and a JSON schema, 3.6k tokens of context, and returned a schema-valid patch with four units and four assignments in the structured_output field. The anthropic SDK dependency is gone from Step 1.<<}{id="r10" by="AI" at="2026-09-12T21:18:00.000Z" re="c10"}{>>great, so we can decide what tools an instance needs if we want or give it the default set any session would have?<<}{id="c23" by="user" at="2026-09-12T21:39:07.240Z" re="r10"}{>>Yes. Name the built-ins individually, or declare default and the session gets Claude Code's full built-in set (verified in claude --help: --tools "default"). Either way --setting-sources "" keeps your MCP servers, skills and hooks out unless a capability adds them explicitly. Added to the equipment kinds table and the session fields.<<}{id="r32" by="AI" at="2026-09-12T21:50:00.000Z" re="c23"}{>>hell yeah, i love this control layer. they can only ever do what they need to do. and we could give them custom equipment and tell the session to use that right?<<}{id="c28" by="user" at="2026-09-12T22:14:00.113Z" re="r32"}{>>Yes. Two ways to hand a session custom equipment, both in the open questions now: the runtime serves its equipment registry to the session as an MCP server (untested), or the runtime exposes equipment as one CLI command, noscope equipment <name>, and the capability allowlists exactly that command in Bash, which uses only mechanisms already verified today. The capability's system_prompt then tells the session to use it. v0 needs neither.<<}{id="r36" by="AI" at="2026-09-12T22:22:00.000Z" re="c28"}{>>cool. add a column to open questions that says if it's needed for this version<<}{id="c31" by="user" at="2026-09-12T22:31:50.827Z" re="r36"}{>>Added a "Needed for v0?" column. Only the organizer-input question is; the other three are after v0.<<}{id="r39" by="AI" at="2026-09-12T22:35:00.000Z" re="c31"}, with `--json-schema` so the
response is a validated `OrganizationPatch` and never prose. Model `claude-opus-5`, no tools,
the same five fixed flags as every session. Tested 2026-09-12 with an
organizer-shaped prompt: 3.6k tokens of context and a valid patch back.
Input, rendered as labeled sections in a stable order so the prefix caches:

1. The case objective and constraints.
2. Verified claims.
3. Candidate claims, each with its provenance.
4. The current unit tree with each unit's purpose and status.
5. Assignments completed since the last cycle, with results summarized against their contracts.
6. Assignments that came back `insufficient`, each with what the session said it needed.
7. Open assignments.
8. The capability registry, names and descriptions only.
9. The rules the validator will apply, so the organizer does not propose what will be rejected.

Output:

```python
class OrganizationPatch(BaseModel):
    create_units: list[UnitProposal]          # purpose, parent unit
    close_units: list[str]                    # unit ids, with a reason each
    create_assignments: list[AssignmentProposal]  # unit, capability, objective, inputs, criteria, instructions, model
    cancel_assignments: list[str]
    claims_to_verify: list[str]               # candidate claim ids worth promoting
    case_status: Literal["continue", "blocked", "satisfied", "failed"]
    rationale: str                            # recorded on the patch event, never acted on
```

The organizer proposes structure. It never runs a tool, never writes to the store, and never
marks its own conclusions true.
### Step 5: the validator
Every patch passes all of these or is rejected whole, with the failing rule recorded as a
`patch.rejected` event and fed back as input 9 on the next cycle:

| Rule | Check |
|---|---|
| Capabilities exist | Every assignment names a registered capability. |
| Units exist | Every assignment's unit and every new unit's parent exist or are created in this patch. |
| No cycles | The tree stays a tree. |
| No duplicates | No new assignment repeats an open or completed one with the same capability and inputs under the same unit. |
| Inputs validate | Assignment inputs parse against the capability's input schema. |
| Span of control | No unit ends the patch with more than 7 direct children, units and assignments combined. Target is 5. |
| Effect policy | v0 rejects any capability whose effect is not `read_only`. |
| Dependencies resolve | Every `depends_on` names an assignment in the case. |
| Model named | Every assignment to a session-backed capability names a provider and model pair on the allowlist. v0's allowlist is Claude Code with `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5-1`; Codex pairs are added when that provider is tested. An assignment to a deterministic capability names none. |
| Closing is clean | A closed unit has no running assignments. |
| Status is earned | `satisfied` requires every open assignment completed or cancelled and at least one verified claim. |

### Step 6: dispatch, record, verify
Ready means every dependency is completed. v0 runs ready assignments sequentially. Each
run writes `assignment.started`, then the result and `assignment.completed` or
`assignment.failed` in one transaction.

The verifier turns results into claims. A deterministic capability's result becomes a `verified`
claim with the capability and inputs as provenance. A session-backed capability's result
becomes `candidate` claims with the session id as provenance; an `insufficient` result becomes
no claims and an `assignment.insufficient` event carrying what was needed. Promotion of a candidate in
v0 happens only when a later deterministic result matches it; the organizer can request
that through `claims_to_verify`, which schedules the deterministic check as an assignment.
### Step 7: the command surface
| Command | Does |
|---|---|
| `noscope case create "<objective>" [--constraint ...]` | Creates the case and its root unit, `command`. |
| `noscope case show <id>` | Objective, status, claims by status, open assignments, registered capabilities. |
| `noscope case tree <id>` | The unit tree with assignment marks: done, running, ready, pending. |
| `noscope case step <id>` | One cycle, then stop. Prints the patch, the validator's verdict, what ran, what changed. |
| `noscope case run <id> [--max-cycles N]` | Repeats `step` until the case leaves `open` or the cap is hit. |
| `noscope case events <id>` | The event log with timestamps and actors. |

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

1. `case create` produces a case with one root unit, `command`, and one event.
2. The first `step` yields a patch that creates at least one unit and one assignment, and the validator accepts it.
3. Assignments run and their results appear as claims with the right status.
4. A later `step` closes a unit that has served its purpose, visible in `tree` and `events`.
5. A patch that breaks span of control is rejected and the next patch groups instead.
6. The case reaches `satisfied` with a verified claim naming the code path.
7. Every state change has a matching event, checked by a test that replays events against the tables.
8. An `interpret` assignment given too little evidence returns `insufficient` naming what it needs, and the next `step` creates an assignment that supplies it.
## Reference
### Verified facts the design rests on
| Fact | How it was checked |
|---|---|
| Headless Claude Code runs on the subscription when no API key is set. | A `claude -p` call succeeded on this machine with no `ANTHROPIC_API_KEY` in the environment, 2026-09-12. |
| Default headless context is about 40k tokens in an empty directory and about 56k in the home directory. | Usage fields of test calls, 2026-09-12. |
| `--system-prompt` on its own, without the other four fixed flags, leaves CLAUDE.md and hook output in the session's context. | A probe session answered yes to seeing both, 2026-09-12. |
| The five fixed flags in Step 3 bring context to about 3k and remove both. | Usage fields and a probe answering no to both, 2026-09-12. |
| With `--setting-sources ""` the model falls back to Opus 5. | The `modelUsage` field of the test call. |
| `--bare` authenticates only with an API key. | `claude --help`. |
| Codex is installed and `codex exec` has `-m`, `-s read-only`, `-C`, `--add-dir`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--output-schema`, `--json` and `-o`. | `codex exec --help` on this machine, 2026-09-12. Nothing run through it yet. |
| The Claude Agent SDK requires an API key. | The SDK quickstart, read by a docs subagent; not read directly. |
| `--json-schema` returns a schema-valid `structured_output` field, and `--tools ""` plus the five fixed flags work with it. | A test call on the installed version with an organizer-shaped prompt and patch schema, 2026-09-12. |

### Model choices
| Role | Model | Because |
|---|---|---|
| Organizer | `claude-opus-5` | The patch is the judgment in the system; Opus 5 is the default for anything nontrivial, and it ran the test patch well. |
| `investigate`, `interpret` | Named per assignment by the organizer, from the allowlist | No defaults, ruled 2026-09-12. Haiku for a narrow read with little equipment; Opus when the read is subtle. |
| Later builder, reviewer and `send_email`-shaped capabilities | `claude-fable-5-1` or `claude-opus-5` with the equipment the job needs | Not in v0. |

### Custom equipment for sessions (after v0)

The goal is that a session uses whatever equipment it is given without learning anything:
the equipment should look like any other tool call, with a schema, and be callable the
first time.

| Option | How the session sees it | Tradeoffs |
|---|---|---|
| The runtime serves its equipment registry as an MCP server, passed with `--mcp-config` and `--strict-mcp-config`. | As native tools with names and input schemas, exactly like `Read` or `Grep`, invoked without any syntax to learn. | The most obvious for the session, and the schema validates inputs before the equipment runs. Costs: the runtime must implement an MCP stdio server, every session pays its startup, each tool definition adds context tokens, and whether `--tools` filtering also filters MCP tools is untested. |
| The runtime exposes equipment as one CLI command, `noscope equipment <name> --arg value`, and the capability allowlists exactly that command in Bash. | As a shell command it must be told about in the capability's prompt, called through the `Bash` tool, returning JSON on stdout. | Uses only mechanisms verified today, no server to write, and one allowlist entry bounds it. Costs: the session has to learn the command's syntax from the prompt, argument errors surface as text rather than schema rejections, and every call spawns a process. |
| No custom equipment in sessions at all: split the work into a deterministic capability that runs the equipment and a session that interprets its output, sequenced by the organizer. | The session never calls equipment; it receives results as evidence in its assignment. | The purest ICS shape, and it keeps facts on the verified side. Costs: it fails wherever judgment and equipment must interleave, as in `send_email`, where composing needs the model and sending needs the equipment in the same stretch. |
| The Claude Agent SDK's in-process custom tools. | As native tools. | Ruled out: the SDK requires an API key, so it leaves the subscription. |

The leading candidate is the MCP server, with the CLI command as the fallback if MCP
proves awkward in headless mode. Platform independence strengthens the MCP choice: it is the
one path both providers already speak, since Codex manages MCP servers with `codex mcp`. The third option is not an alternative to the first two
but the default shape: a session gets custom equipment only when its judgment and the
equipment must interleave.

### Speed
Measured 2026-09-12 on this machine, all with the five fixed flags:

| Call | Time |
|---|---|
| A minimal Haiku session that only replies | 3.8 s wall, of which 1.0 s is API time. The rest is process startup, paid by every headless invocation. |
| A Haiku session that makes one Bash call and reports | 4.4 s of API time over two turns, plus startup. |
| The Opus organizer returning six units and five assignments | 14.2 s of API time, plus startup. |
| A deterministic capability | Milliseconds. |

So one cycle as written is the organizer, about 15 to 20 s, plus its assignments run one
after another, each session-backed one roughly 7 to 30 s and each deterministic one
negligible. A case that takes five cycles with two sessions each runs three to four minutes.
That is slow for a daemon and right for v0, which is stepped by hand to be watched. The
lever after v0 is running ready assignments in parallel, which turns the sum into a
maximum; the startup cost per session stays unless sessions are reused with `--resume`,
which is untested for this use.
## {==Open questions==}{>>i don't understand your suggestions under "blocks", too compressed<<}{id="c30" by="user" at="2026-09-12T22:19:17.566Z"}{>>Rewritten: each row now says what is undecided, which step cannot be finished until it is, and what the build assumes in the meantime.<<}{id="r38" by="AI" at="2026-09-12T22:22:00.000Z" re="c30"}{>>this is no longer rendering, i'll need to see it in chat<<}{id="c32" by="user" at="2026-09-12T22:32:42.594Z" re="r38"}{>>Shown in chat, with the new column.<<}{id="r40" by="AI" at="2026-09-12T22:35:00.000Z" re="c32"}
| What is undecided | Needed for v0? | What waits on it, and what the build assumes meanwhile |
|---|---|---|
| Whether the organizer should see the full text of every completed result, or only a summary of each result against its assignment's contract plus pointers to the evidence. | Yes. | Step 4 cannot fix the organizer's input rendering until this is decided. The build starts with summaries plus evidence pointers, because that is the cheaper prompt. The signal to widen is the organizer proposing the same tree again after new results arrive, which means the summaries are not carrying enough for it to react. |
| The Codex provider's untested parts: per-tool selection and a finer command allowlist beyond `-s read-only`, context size under its isolation flags, and whether it bills the ChatGPT subscription. | No. v0 runs on Claude Code only. | The Codex provider cannot be declared working until one test session runs through it, the same tests run for Claude Code today. |
| How a session-backed capability gets custom Python equipment, not only Claude Code's built-in tools. The options and their tradeoffs are under "Custom equipment for sessions" in the Reference section. | No. v0 sessions use built-in tools only. | Any session-backed capability that needs Python equipment cannot be written until one path is chosen and tested. The leading candidate is the runtime serving its equipment registry as an MCP server, because the session then sees each piece of equipment as a native tool with a schema and nothing to learn. |

---
counters:
  comments: 32
comments:
  c26:
    body: will this thing be slow as written?
    by: user
    at: 2026-09-12T21:42:05.935Z
