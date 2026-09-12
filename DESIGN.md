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
| {==Model routing: a capability declares a default model, and an assignment may override it from an allowlist, so the same capability runs on Haiku for a narrow job and on Opus for a subtle one.==}{>>we're just gonna incorporate model routing. some capabilities will have a fixed model but we should also be able to choose the right model for new capabilities, or use the same capability with different models for different purposes. we may actually need to fully talk about the ICS structure and how we're mapping it over to make sure we're on the same page<<}{id="c1" by="user" at="2026-09-12T20:49:38.101Z"}{>>Changed to model routing: the capability holds a default model, the assignment may override it, the validator checks the override against an allowlist. Wired through Step 2 (assignments.model), Step 3 (the model field), Step 4 (AssignmentProposal.model) and Step 5 (the Model allowed rule). The ICS mapping is now a table right after the vocabulary.<<}{id="r1" by="AI" at="2026-09-12T21:18:00.000Z" re="c1"} | Context load and price scale with the model, and a narrow read-only worker needs no more, while a subtle read needs more; routing per assignment buys both. |
| New repo under kudzuweb, cloned to `~/Documents/Projects/ics-runtime`. | It keeps the runtime separate from lil-guy-quipu and roughdraftplus, which will later be its users. |
| Tools are the primitives and are never assigned; a capability is a declared set of tools plus, when judgment is needed, a headless session with a prompt and a default model. | Ruled by Mauria in review, 2026-09-12: one word for the assignable thing, and `send_email` is the shape, the mail tools plus an Opus session that receives a brief and applies them. |
| Build this first, then use it to work on {==roughdraft, quipu and the codebase scan.==}{>>and also the codebase scan<<}{id="c2" by="user" at="2026-09-12T20:51:14.050Z"}{>>Added.<<}{id="r2" by="AI" at="2026-09-12T21:18:00.000Z" re="c2"} | Sequencing set by Mauria on 2026-09-12. |

Proposed in this document and not yet ruled: SQLite as the store, `pydantic` as the only
dependency, Opus 5 as the organizer model, the model allowlist, the schema, the validator
rules, the CLI surface, and the first case.
## {==Vocabulary==}{>>oh okay here we're talking about it. maybe we will talk about my next proposal later in the document, but i think that capability primitives are good, but that you should also be able to bundle them for reuse. you will not need to think every time about what you need to do certain things, so that should become a capability in itself. you see? fractal. can also be a surface for self-improvement of the system, where we can decide what combo of primitives does that job best. if it's often conditional/contextual we keep it flexible(though we can talk algorithmic shortcuts) but if it isn't really, we make a.. capability bundle. capability function. whatever, you get it.<<}{id="c3" by="user" at="2026-09-12T20:53:14.982Z"}{>>Yes, and renamed per your later ruling: primitives are tools, and the composition is the capability, so there is no separate bundle. A capability may include other capabilities. The event log is the surface for deciding which recurring compositions become new capabilities; that sentence is at the end of Step 3. The quipu CLI objective catalog is the first planned set.<<}{id="r3" by="AI" at="2026-09-12T21:18:00.000Z" re="c3"}

| Term | Meaning |
|---|---|
| Case | An objective pursued over time, with constraints. One row; many cycles. |
| {==Unit==}{>>i don't understand the unit definition or why it carries no prompt, explain in chat<<}{id="c4" by="user" at="2026-09-12T20:59:35.956Z"}{>>Explained in chat; definition rewritten here. Short form: a unit is an ICS box (Branch, Group), not a person. Nothing runs as a unit; assignments run, and their capabilities carry the prompts. A unit exists so the organizer can open, subdivide and close one slice of the problem as a single thing.<<}{id="r4" by="AI" at="2026-09-12T21:18:00.000Z" re="c4"} | A box in the case's temporary tree that owns one slice of the problem, the way an ICS Branch or Group does. It has a purpose, a parent and children, and it opens, subdivides and closes as the organizer's picture of the problem changes. Nothing runs as a unit: assignments run, and their capabilities carry the prompts. The root unit, `command`, owns the objective and is created with the case. |
| Assignment | A bounded piece of work owned by one unit and bound to one capability: objective, inputs, expected output, completion criteria, evidence required, dependencies. It becomes the worker's brief. |
| Tool | A primitive: a Python function the runtime calls in-process, or a Claude Code built-in such as Read, Grep or Bash under an allowlist. Registered by name. Never assigned by the organizer. |
| Capability | The assignable thing: a declared set of tools plus, when judgment is needed, a headless session with a system prompt and a default model. A capability with no session is deterministic and returns verified claims; one with a session returns candidate claims. A capability may include other capabilities. Later, a human. |
| Claim | A statement about reality with epistemic status `candidate`, `verified` or `rejected`, plus provenance. LLM output enters as `candidate`; only deterministic verification promotes it. |
| Event | One append-only record of something that happened, written in the same transaction as the state change it describes. |
| {==Patch==}{>>why is this called patch? are any of these terms from ICS? just curious, answer in chat<<}{id="c5" by="user" at="2026-09-12T21:01:14.077Z"}{>>Not an ICS term; it is the software sense, a proposed set of changes applied to the current state atomically or not at all. ICS has no named artifact for a proposed change to the org chart; reorganization happens through the Planning P and the next Incident Action Plan (verified against NIMS 2017). Which vocabulary is ICS and which is ours is now the table under "ICS mapping" below.<<}{id="r5" by="AI" at="2026-09-12T21:18:00.000Z" re="c5"} | The organizer's proposal for one cycle: units to create or close, assignments to create or cancel, case status. Validated before anything commits. |
| Cycle | Observe, organize, validate, dispatch, record, stop. `case step` runs exactly one. |

### ICS mapping

Definitions checked against the NIMS Third Edition (FEMA, October 2017) on 2026-09-12.

| ICS term | Here |
|---|---|
| Incident: an occurrence that necessitates a response. | Case. |
| Incident Commander: develops objectives, orders and releases resources. | The root unit `command` holds the objective; the organizer does the ordering and releasing by proposing patches. |
| Section, Branch, Division, Group, Unit: the organizational levels, distinguished by depth and by functional versus geographic responsibility. | All are the one thing called a unit here. Depth is whatever the tree needs, and a unit's purpose says what it is responsible for. |
| Single Resource, Strike Team (same kind and type, one leader), Task Force (mixed kinds for one mission). | A capability is a single resource and its tools are its equipment. A capability that includes other capabilities is the strike team or task force. |
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
ics-runtime/
├── DESIGN.md
├── README.md
├── pyproject.toml
├── ics/
│   ├── cli.py            # the command surface
│   ├── runtime.py        # the cycle
│   ├── store.py          # SQLite: schema, transactions, queries
│   ├── models.py         # pydantic contracts shared by every module
│   ├── organizer.py      # the one headless Claude Code call per cycle
│   ├── validator.py      # patch rules
│   ├── dispatcher.py     # runs ready assignments through capabilities
│   ├── verifier.py       # turns results into claims
│   ├── tree.py           # renders the unit tree and the event log
│   ├── tools/
│   │   ├── registry.py   # tool decorator and lookup
│   │   ├── {==filesystem.py ==}{>>so this is python scripts for each tool all in one file or what? how does this interact with tool calls in claude code<<}{id="c6" by="user" at="2026-09-12T21:03:29.083Z"}{>>Now the tools/ package: one module per family of Python tools, each registered by decorator; deterministic capabilities call them in-process and Claude Code is never involved. Claude Code's built-ins (Read, Grep, Bash) are also tools, usable only inside a capability that has a session, where the whole headless session is one capability call. Explained in chat.<<}{id="r6" by="AI" at="2026-09-12T21:18:00.000Z" re="c6"}# read_file, list_directory, grep_files
│   │   ├── git.py        # git_status, git_log, git_diff
│   │   ├── shell.py      # allowlisted read-only commands
│   │   └── builtin.py    # names and allowlists for Claude Code's own tools
│   └── capabilities/
│       ├── registry.py   # capability decorator, contract, lookup
│       ├── session.py    # renders and runs a headless Claude Code session
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
| `assignments` | `id`, `case_id`, `unit_id`, `capability`, `objective`, `inputs_json`, `expected_output`, `completion_criteria_json`, `evidence_required_json`, `depends_on_json`, `model` (null for the capability default), `status` (`pending`, `ready`, `running`, `completed`, `failed`, `cancelled`), `result_json`, `created_at`, `completed_at` |
| `claims` | `id`, `case_id`, `subject`, `predicate`, `object_json`, `status` (`candidate`, `verified`, `rejected`), `confidence`, `provenance_json`, `created_at` |
| `events` | `id`, `case_id`, `sequence`, `type`, `actor`, `payload_json`, `created_at` |

Event types in v0: `case.created`, `case.closed`, `unit.created`, `unit.closed`,
`assignment.created`, `assignment.started`, `assignment.completed`, `assignment.failed`,
`assignment.cancelled`, `claim.proposed`, `claim.verified`, `claim.rejected`,
`patch.proposed`, `patch.rejected`, `patch.applied`.

Capabilities are not a table. The registry is code, and `case show` prints what is
registered.
### Step 3: tools and capabilities

Every tool and every capability is registered by decorator. Tools are primitives and the
organizer never assigns one. Capabilities are what the organizer assigns. The registries
describe what can be done, never when.

Tool kinds:

| Kind | Where it runs |
|---|---|
| Python function | In-process, called by a deterministic capability. `read_file`, `grep_files`, `list_directory`, `git_status`, `git_log`, `git_diff`, `run_readonly`. |
| Claude Code built-in | Only inside a capability's session, named in that capability's tool set: `Read`, `Grep`, `Glob`, and `Bash` under an allowlist of read-only commands. |

```python
@capability(
    name="investigate",
    description="Read the files a question points at and return what they show",
    tools=["Read", "Grep", "Glob", "Bash"],
    bash_allowlist=["ls", "cat", "head", "tail", "wc", "find", "stat"],
    session=Session(system_prompt=INVESTIGATE_PROMPT, model="claude-haiku-4-5"),
    side_effects="none",
)
class Investigate(Capability): ...
```

{==Fields on every capability:==}{>>table didnt render, show in chat pls<<}{id="c7" by="user" at="2026-09-12T21:05:38.025Z"}{>>Shown in chat. Table unchanged. The rendering loss is Roughdraft's, parked at your call and logged as papercut pc-490f5c.<<}{id="r7" by="AI" at="2026-09-12T21:18:00.000Z" re="c7"}

| Field | Meaning |
|---|---|
| `name` | The identifier the organizer uses in a patch. |
| `description` | One sentence the organizer sees. |
| `tools` | The declared set of tools this capability may use. A deterministic capability calls them in code; a session-backed one exposes exactly these to its session. |
| `input_schema`, `output_schema` | Pydantic models. The validator checks assignment inputs against the input schema before dispatch. |
| `side_effects` | `none`, `local_reversible` or `external`. v0 registers only `none`. |
| `returns` | `verified` for a deterministic capability, whose output is a fact about the machine; `candidate` for a session-backed one. |

A capability with a session adds the fields that define its setup, and the runtime renders
the headless com{==mand from them:==}{>>table didnt render, show in chat pls<<}{id="c8" by="user" at="2026-09-12T21:05:54.875Z"}{>>Shown in chat. This is now the session fields table; the model row is a default the assignment can override.<<}{id="r8" by="AI" at="2026-09-12T21:18:00.000Z" re="c8"}

| Field | Renders to |
|---|---|
| `system_prompt` | `--system-prompt <text>` |
| `model` | `--model <id>`, always explicit. The capability's default; an assignment may override it from the allowlist in Step 5. |
| `tools` | `--tools "<list>"`, the built-ins in the capability's tool set |
| `bash_allowlist` | `--allowedTools` entries of the form `Bash(<command> *)`, so read-only tool calls need no approval |
| `cwd`, `add_dirs` | The working directory and `--add-dir` entries |
| `output_schema` | `--json-schema <schema>`, so the result comes back structured |

Fixed flags on every session: `--output-format json`, `--no-session-persistence`,
`--setting-sources ""`, `--disable-slash-commands`,
`--exclude-dynamic-system-prompt-sections`. Those five are what drop a session's context from
about 40k tokens to about 3k and keep Mauria's personal CLAUDE.md, skills and hooks out of it.
`--bare` is not used because it authenticates only with an API key.

The assignment is the user message: objective, inputs, expected output, completion
criteria, evidence required, and the owning unit's purpose as one line of context.

v0 {==capabilities:==}{>>table didnt render, show in chat pls<<}{id="c9" by="user" at="2026-09-12T21:06:00.948Z"}{>>Shown in chat. Rewritten under the tools ruling: the table now lists capabilities with their tool sets and whether they have a session.<<}{id="r9" by="AI" at="2026-09-12T21:18:00.000Z" re="c9"}

| Capability | Tools | Session |
|---|---|---|
| `check_path` | `list_directory` | none; returns verified |
| `read` | `read_file` | none; returns verified |
| `grep` | `grep_files` | none; returns verified |
| `git_history` | `git_log`, `git_diff` | none; returns verified |
| `investigate` | `Read`, `Grep`, `Glob`, `Bash` under the read-only allowlist | `claude-haiku-4-5` by default; returns candidate claims with evidence |
| `interpret` | none | `claude-haiku-4-5` by default; given evidence, returns what it implies as candidate claims |

The four deterministic capabilities exist so the verifier has something to promote claims
with, and so the organizer can ask a precise question without spending a session on it.

A capability may include other capabilities, composed in code. The event log records which
capabilities every case used under which unit purposes; a composition that recurs across
cases with the same shape is a candidate for a new capability, and one whose shape varies
with context stays with the organizer. The quipu CLI's objective catalog is the first
planned set of such capabilities. v0 registers none.

### Step 4: the organizer

One call per cycle, {==as a headless Claude Code call on the subscription==}{>>aht aht, subscription-based solutions only for now<<}{id="c10" by="user" at="2026-09-12T21:06:34.909Z"}{>>Changed and tested 2026-09-12: the organizer ran as headless Opus 5 with the five stripped flags, no tools and a JSON schema, 3.6k tokens of context, and returned a schema-valid patch with four units and four assignments in the structured_output field. The anthropic SDK dependency is gone from Step 1.<<}{id="r10" by="AI" at="2026-09-12T21:18:00.000Z" re="c10"}, with `--json-schema` so the
response is a validated `OrganizationPatch` and never prose. Model `claude-opus-5`, no tools,
the same five fixed flags as every session. Tested 2026-09-12 with an
organizer-shaped prompt: 3.6k tokens of context and a valid patch back.
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
    create_assignments: list[AssignmentProposal]  # unit, capability, objective, inputs, criteria, optional model
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
| Model allowed | An assignment's model override, if any, is on the allowlist: `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5-1`. Deterministic capabilities take no override. |
| Closing is clean | A closed unit has no running assignments. |
| Status is earned | `satisfied` requires every open assignment completed or cancelled and at least one verified claim. |

### Step 6: dispatch, record, verify

Ready means every dependency is completed. v0 runs ready assignments sequentially. Each
run writes `assignment.started`, then the result and `assignment.completed` or
`assignment.failed` in one transaction.

The verifier turns results into claims. {==A deterministic capability's==}{>>a what?<<}{id="c13" by="user" at="2026-09-12T21:10:37.522Z"}{>>Was "function capability", then "plain Python capability"; under the tools ruling it is a deterministic capability, one with no session, composing Python tools in code. Renamed everywhere.<<}{id="r13" by="AI" at="2026-09-12T21:18:00.000Z" re="c13"} result becomes a `verified`
claim with the capability and inputs as provenance. A session-backed capability's result
becomes `candidate` claims with the session id as provenance. Promotion of a candidate in
v0 happens only when a later deterministic result matches it; the organizer can request
that through `claims_to_verify`, which schedules the deterministic check as an assignment.
### Step 7: the command surface

| Command | Does |
|---|---|
| `ics case create "<objective>" [--constraint ...]` | Creates the case and its root unit, `command`. |
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

1. `case create` produces a case with one {==root unit, `command`,==}{>>what is a command unit<<}{id="c15" by="user" at="2026-09-12T21:12:39.322Z"}{>>The root of the unit tree, created with the case, owning the objective. Now defined in the Unit row of the vocabulary and named "root unit" here.<<}{id="r15" by="AI" at="2026-09-12T21:18:00.000Z" re="c15"} and one event.
2. The first `step` yields a patch that creates at least one unit and one assignment, and the validator accepts it.
3. Assignments run and their results appear as claims with the right status.
4. A later `step` closes a unit that has served its purpose, visible in `tree` and `events`.
5. A patch that breaks span of control is rejected and the next patch groups instead.
6. The case reaches `satisfied` with a verified claim naming the code path.
7. Every state change has a matching event, checked by a test that replays events against the tables.
## {==Reference==}{>>none of these tables rendered<<}{id="c16" by="user" at="2026-09-12T21:13:03.222Z"}{>>Roughdraft rendering, parked at your call and logged as papercut pc-490f5c. The three tables are the verified facts, the model choices and the open questions; content updated below for the headless organizer and the --json-schema test.<<}{id="r16" by="AI" at="2026-09-12T21:18:00.000Z" re="c16"}

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
| `--json-schema` returns a schema-valid `structured_output` field, and `--tools ""` plus the five fixed flags work with it. | A test call on the installed version with an organizer-shaped prompt and patch schema, 2026-09-12. |

### Model choices

| Role | Model | Because |
|---|---|---|
| Organizer | `claude-opus-5` | The patch is the judgment in the system; Opus 5 is the default for anything nontrivial, and it ran the test patch well. |
| `investigate`, `interpret` | `claude-haiku-4-5` by default | Narrow brief, few tools, small context; the cheapest floor. The organizer overrides per assignment when a read needs more. |
| Later builder, reviewer and `send_email`-shaped capabilities | `claude-fable-5-1` or `claude-opus-5` with the tools the job needs | Not in v0. |

## Open questions

| Question | Blocks |
|---|---|
| Whether the organizer should see the full text of completed results or only their summaries against the contract. | Step 4's input rendering. Start with summaries plus evidence pointers; widen if the tree stops changing shape. |
| Whether `interpret` is worth having in v0 or whether `investigate` covers it. | Step 3's registry. Drop it if the first case never needs it. |
| How a session-backed capability gets Python tools, not only Claude Code built-ins. The candidate is the runtime serving its tool registry as an MCP server passed by `--mcp-config` with `--strict-mcp-config`; untested. | Any session-backed capability that needs a Python tool. v0 avoids it by giving sessions built-ins only. |
| The repo's GitHub name and whether it is public. | The push, not the build. |

---
counters:
  comments: 16
