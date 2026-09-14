# noscope: design and v0 build plan
## Overview
A TypeScript runtime that pursues an objective by building and revising a temporary
organization around it. The durable layer is capabilities, state and history. The
organization is a tree of responsibility recomputed each cycle. One LLM call per cycle
proposes changes to that tree as a structured action plan; deterministic code validates the action plan,
commits it, dispatches the resulting tasks, records results, and repeats.

v0 proves one thing: that an planner restructuring responsibility in response to evidence
produces better investigation than a flat agent picking tools. v0 is read-only, manually
stepped, and visible at every step. Side effects, memory across incidents, recursion, parallel
workers and human participation come after v0 works.

Settled before this document, on the ics-runtime and quipu-cli threads:

| Decision | Because |
|---|---|
| Build fresh, not on glove. | Glove has not been touched in months and the advice that grafted onto it rested on unverified details. |
| A standalone runtime owns the loop, with headless Claude Code as one capability among others. | A skill is advice and cannot enforce the propose-then-validate boundary; code can. |
| Capabilities carry their own system prompt and Claude Code tool list as fields. | A stripped headless session costs about 3k tokens of context against about 40k for a default one, and the model must be passed explicitly because user settings are what select it. |
| {==Model routing: every task to a session-backed capability names its provider and model, any model that provider serves, and capabilities carry no default, so the same capability runs on Haiku for a narrow job and on Opus for a subtle one.==}{>>we're just gonna incorporate model routing. some capabilities will have a fixed model but we should also be able to choose the right model for new capabilities, or use the same capability with different models for different purposes. we may actually need to fully talk about the ICS structure and how we're mapping it over to make sure we're on the same page<<}{id="c1" by="user" at="2026-09-12T20:49:38.101Z"}{>>Changed to model routing; then per your c20, no defaults: the assignment names the model every time, the validator requires it from the allowlist. Wired through Step 2 (assignments.model), Step 3 (the model field), Step 4 (AssignmentProposal.model) and Step 5 (the Model allowed rule). The ICS mapping is now a table right after the vocabulary.<<}{id="r1" by="AI" at="2026-09-12T21:18:00.000Z" re="c1"} | Context load and price scale with the model, and a narrow read-only worker needs no more, while a subtle read needs more; routing per task buys both. |
| New repo under kudzuweb, cloned to `~/Documents/Projects/noscope`. | It keeps the runtime separate from lil-guy-quipu and roughdraftplus, which will later be its users. |
| Equipment is the primitive and is never assigned; a capability is declared equipment plus, when judgment is needed, a headless session with a prompt. | Ruled by Mauria in review, 2026-09-12: one word for the assignable thing, and `send_email` is the shape, the mail equipment plus an Opus session that receives a brief and applies it. "Equipment" rather than "tool" so it is not confused with Claude Code's tools and does not narrow what counts. |
| The repository is `kudzuweb/noscope`, private for now, public later. | Ruled by Mauria 2026-09-12. She expects to use it at work if it proves out, and that is the point at which it goes public. |
| Every session-backed capability can answer "insufficient": its output schema carries an outcome of `answered` or `insufficient`, and an insufficient result names what evidence it would need. `interpret`, the sandboxed capability with no equipment, stays in v0 because of this. | Ruled by Mauria 2026-09-12. A sandboxed "tell me what you think" cannot go and get more, and that is the point: when it says it cannot answer and why, the planner gets a precise next task and Mauria gets a diagnostic on prompts and tasks. |
| Platform-agnostic: a session runs on a provider, and Claude Code is the first provider, not the only one. Codex is the second. | Ruled by Mauria 2026-09-12. She wants to deploy Codex, or anything else, as a capability. Nothing above the session layer knows which provider ran it. |
| Custom equipment reaches a session over MCP, and any external MCP server can itself be equipment. | Ruled by Mauria 2026-09-12. Her reason: MCP means other MCP servers, Craft, GitHub, a browser, can be handed to a capability as equipment with no adapter, and both providers already speak it. The CLI-command path stays as the fallback if headless MCP misbehaves. After v0. |
| TypeScript on Node, with `zod` for contracts and `better-sqlite3` for storage. | Ruled by Mauria 2026-09-12. Node is present wherever noscope can run, because Claude Code and Codex are both Node programs on this machine; it is her language and the language of roughdraftplus and the codebase-scan tooling; the MCP SDK is TypeScript-first. Python was inherited from the ChatGPT conversation, never ruled, and the machine has 3.11 where the draft assumed 3.12. `better-sqlite3` over `node:sqlite` because she would rather carry a dependency than have a built-in change under her; the comparison is in the Reference section. |
| The planner sees each completed result as a summary against its task's contract plus pointers to the evidence, not the full text. | Approved by Mauria 2026-09-12 22:24. It is the cheaper prompt. The signal to widen to full text is the planner proposing the same tree again after new results arrive, which means the summaries are not carrying enough for it to react. |
| Custom equipment reaches a session over MCP with `--tools ""`, so a session can be given nothing but the runtime's equipment. | Tested 2026-09-12 22:30 at Mauria's "test it": with a stdio MCP server passed by `--mcp-config` and `--strict-mcp-config`, the MCP tool stayed callable under no `--tools` flag, `--tools ""`, `--tools "Read"` and `--tools "mcp__noscope__echo"`; the filter touches built-in tools only. With `--tools ""` the session cost 2.5k tokens of context. The spike is `spikes/mcp-tools-filter/run.sh`. |
| The planner has four channels for what it lacks: a task for retrievable facts, a grant request for permission, a capability request for missing means, a question for what only a human knows. The preamble orients every session in the ICS-inspired system and carries the term mapping. | Ruled by Mauria 2026-09-12 22:43. Questions for a human alone were the wrong channel for facts she does not hold but could get retrieved; a capability request separates "I need the means" from "I need your answer". |
| Opus 5 as the planner model, and the validator rules as written in Step 5, are accepted for now. | Mauria, 2026-09-12 22:54: "fine for now". Revisit both after the first incident has run. |
| The umbrella word is `incident`, ICS's own. | Ruled by Mauria 2026-09-12 at 22:13, after `op` was tried and the collision with ICS's Operations Section came up: every term in the preamble is now ICS's, which is the strongest position against training data. The preamble says an incident here is anything asked for and does not mean something went wrong. |
| The organizer is the planner; claim statuses are `asserted`, `verified`, `rejected`; "action plan" stays the term, with "plan" as the everyday short form. | Ruled by Mauria 2026-09-12. The planner drafts the action plan, which is ICS's Planning Section, so the name says what it does and not more. `asserted` says who said it without saying it is true. |
| Saved unit configurations, called SOPs after ICS's standard operating procedures, can be added to any incident. | Ruled by Mauria 2026-09-12. She wants a code review SOP she likes to be one action away on any incident: a unit template with its tasks and prompts ready, where the planner picks the angles that matter for this code. SOP over "protocol" because it is ICS's own word for a pre-written way of doing something, and agents know it. After v0. |
| Mauria is the Agency Administrator, the authority above the Incident Commander, not a Public Information Officer; noscope has no PIO. | Ruled by Mauria 2026-09-12. She delegates authority through grants, sets priorities, and receives briefings; an incident is not charged with keeping anyone else informed. |
| The framework is named `noscope`, one spelling for the repo, the npm package and the command. | Named by Mauria 2026-09-12, after FIRESCOPE, the interagency effort that produced ICS, and for the pun: the whole thing is built so she never has to zoom in. `noscope` is free on PATH, Homebrew and GitHub; PyPI has an unrelated `noscope`, so a PyPI release would be published as `no_scope` with the import name unchanged. |
| Build this first, then use it to work on roughdraft, quipu and the codebase scan. | Sequencing set by Mauria on 2026-09-12. |

Still proposed rather than ruled, and settled by building them: the storage tables in Step 2, the command list in Step 7, and the first incident. Opus 5 as the planner model and the validator rules as written are accepted for now. Everything else in this document is a ruling.
## Vocabulary
| Term | Meaning |
|---|---|
| Incident | An objective pursued over time, with constraints: a project, a single task, a piece of research, anything Mauria asks for. One row; many cycles. ICS's own word; it does not imply that something went wrong here. |
| Unit | A box in the incident's temporary tree that owns one slice of the problem, the way an ICS Branch or Group does. It has a purpose, a parent and children, and it opens, subdivides and closes as the planner's picture of the problem changes. Nothing runs as a unit: tasks run, and their capabilities carry the prompts. The root unit, `command`, owns the objective and is created with the incident. |
| Task | A bounded piece of work owned by one unit and bound to one capability: objective, inputs, expected output, completion criteria, evidence required, dependencies, and for a session-backed capability the model and any instructions. It is the worker's brief, and for a session it is the prompt the session receives. |
| Equipment | A primitive: a function the runtime calls in-process, a Claude Code built-in tool such as Read, Grep or Bash under an allowlist, or later anything else a capability needs to do its work. Registered by name. Never assigned by the planner. |
| Capability | The assignable thing: declared equipment plus, when judgment is needed, a headless session with a system prompt; the model comes from each task. A capability with no session is deterministic and produces verified claims; one with a session produces asserted claims. A capability may include other capabilities. Later, a human. |
| Provider | A program that can run a session: Claude Code first, Codex second, later an HTTP API or a human. A provider maps the session fields onto its own command line and turns its output back into the runtime's result shape. Everything above the session layer is provider-blind. |
| Claim | A statement about reality with epistemic status `asserted`, `verified` or `rejected`, plus provenance and a basis: `observed` when it was seen in code or in output, `inferred` when it was reasoned to from what was seen. LLM output enters as `asserted`; only deterministic verification promotes it. Confidence means the same on every claim: observed, 0.9 to 1; inferred from code, at most 0.7; runtime behavior not reproduced, at most 0.5. |
| Event | One append-only record of something that happened, written in the same transaction as the state change it describes. |
| Action plan | The planner's plan for one cycle: units to create or close, tasks to create or cancel, questions for a human, grant requests, capability requests, incident status. It is proposed by the planner and approved by the validator, and only an approved plan is applied. |
| Cycle | Observe, organize, validate, dispatch, record, stop. `incident step` runs exactly one. |
| SOP, standard operating procedure | A saved unit configuration that can be added to any incident: the unit's purpose, the tasks it opens, each with its capability, instructions and equipment, the angles the planner may choose among for this incident, and the unit's completion criteria. A code review SOP, for example, opens a review unit whose tasks read the change from the angles that matter for it. Capabilities compose work into one assignable result; SOPs compose organization into a unit. Declared in code under `sops/`, applied by command or by the planner. After v0. |
| Incident file | The one place command keeps the state of an incident: objective, constraints, priorities, budget and what is spent, the current tree, findings by status, every decision with its reason, questions waiting on a human, grants given, and pointers to evidence. The planner's input is rendered from it in full; a unit or task receives only its slice plus the objective in one line. Stored across the tables in Step 2 and printed by `incident show`. |
| Budget | A bound on tokens, wall time or both, set on an incident or on a task. The planner sees what remains and plans inside it; the validator rejects a task that does not fit; the dispatcher enforces the time bound and records usage. The costs it reasons with are facts stored on the equipment and capabilities themselves (see `cost` in Step 3), never estimated elsewhere. Unlimited is allowed and is the v0 default. |
| Grant | Permission from Mauria for a capability whose effect is not `read_only`, with the planner's stated reason attached. Least privilege: nothing that writes runs without one. Three levels stack: an incident grant covers every task on that incident for that capability, which is the default; a standing grant in a config file whitelists a capability everywhere, so she stops approving the same thing; and per-task approval can be switched on for a capability when a single use deserves its own yes. Auto-whitelisting after some number of unqualified approvals is a later feature, and whether its count is per incident or global is decided after she has used it. v0 registers only `read_only` capabilities, so no grants are needed until after v0. |

### ICS mapping
Definitions checked against the NIMS Third Edition (FEMA, October 2017) on 2026-09-12.

| ICS term | Here |
|---|---|
| Incident: an occurrence that necessitates a response. | Incident, same word. Here it means anything Mauria asks for, a build as much as a failure. |
| Operations Section: the part of the incident organization that does the tactical work. | No single equivalent. The doing here is tasks run by capabilities under units. |
| Agency Administrator: the executive above the incident who delegates authority to the Incident Commander, sets policy and priorities, and is briefed. | Mauria. Grants are her delegation of authority, `op show` is her briefing, and questions for a human go to her. |
| Safety Officer: on the Command Staff, with independent authority to stop any unsafe act. | The validator's effect policy plus grants: nothing that writes runs without her permission, and the validator can stop an action plan on its own. |
| Public Information Officer and Liaison Officer: what is told outside the incident, and the contact point for other agencies. | None. An incident is not charged with keeping anyone informed; providers and external MCP servers cover the liaison work without a role. |
| Incident Commander: develops objectives, orders and releases resources. Planning Section: collects the situation picture, tracks resources, drafts the Incident Action Plan for the commander to approve. | Command, the root unit with its incident file, holds the objective and priorities as the Incident Commander does. The planner drafts the action plan as the Planning Section does. The validator, and Mauria for grants and questions, approve it, which is the commander's approval of the plan. One model call per cycle in v0; a separate commander call that revises objectives and priorities is after v0, with the cross-incident layer. |
| Section, Branch, Division, Group, Unit: the organizational levels, distinguished by depth and by functional versus geographic responsibility. | All are the one thing called a unit here. Depth is whatever the tree needs, and a unit's purpose says what it is responsible for. |
| Single Resource, Strike Team (same kind and type, one leader), Task Force (mixed kinds for one mission). | A capability is a single resource, and equipment is equipment; the word is ICS's. A capability that includes other capabilities is the strike team or task force. |
| Resource typing: categorizing resources by capability so everyone means the same thing by a name. | The capability registry: name, description, schemas, side effects. |
| Assignment: a task given to a person or team based on the objectives in the Incident Action Plan. | Task, ruled by Mauria as the software word for the same thing. |
| Incident Action Plan and Operational Period: the objectives and tactics for one period, then a new plan. | Action plan, same word: the planner's proposed plan for the next cycle, approved by the validator before it is applied. One cycle is the operational period. |
| The Planning P: objectives, tactics meeting, planning meeting, plan approval, briefing, execute, repeat. | The cycle: observe, organize, validate, dispatch, record. |
| Span of control: one supervisor to five is the guideline, not a rule. | Validator rule: target 5 direct children, maximum 7. |
| Demobilization: the orderly release of a resource when no longer needed. | Closing a unit and cancelling its tasks. |
| Situation Unit and Resources Unit: who tracks what is known and where every resource is. | The store. Claims are the situation; tasks and their statuses are the resource tracking. |
| Unified Command, Staging Area. | No equivalent in v0. |
| No ICS term. | Claim, event, cycle, provider and planner are ours; task is our word for ICS's assignment. |

## Build steps
### Step 1: repository skeleton
TypeScript on Node 24, a pnpm package. Runtime dependencies: `zod` for every contract and the
JSON schemas the planner and sessions receive, `better-sqlite3` for storage, and
`@modelcontextprotocol/sdk` only when custom equipment for sessions arrives after v0.
`better-sqlite3` is a native addon with prebuilt binaries; it is chosen over Node 24's built-in
`node:sqlite`, which works on this machine but is experimental, because a dependency we pin
cannot change under us. `zod` is chosen over TypeBox, which is JSON Schema first with weaker
TypeScript inference, and over plain JSON Schema with a validator, which yields no types and
means writing every schema twice. Every LLM call goes through an installed provider binary,
`claude` or `codex`.

```text
noscope/
├── DESIGN.md
├── README.md
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts            # the command surface
│   ├── runtime.ts        # the cycle
│   ├── store.ts          # SQLite: schema, transactions, queries
│   ├── models.ts         # zod contracts shared by every module
│   ├── planner.ts        # the one provider call per cycle: renders the nine sections, records plan.proposed
│   ├── validator.ts      # action plan rules
│   ├── dispatcher.ts     # runs ready tasks through capabilities
│   ├── verifier.ts       # turns results into claims
│   ├── tree.ts           # renders the unit tree and the event log
│   ├── equipment/
│   │   ├── registry.ts   # defineEquipment and lookup
│   │   ├── filesystem.ts # read_file, stat_path, list_directory, grep_files
│   │   ├── git.ts        # git_status, git_log, git_diff
│   │   ├── shell.ts      # allowlisted read-only commands
│   │   ├── builtin.ts    # names and allowlists for the providers' own tools
│   │   └── index.ts      # the package surface
│   ├── providers/
│   │   ├── base.ts       # the provider interface and the shared session preamble
│   │   ├── claude-code.ts
│   │   ├── codex.ts
│   │   └── index.ts      # the package surface and the provider lookup by name
│   ├── sops/
│   │   └── code-review.ts    # after v0: a saved review unit with its tasks and prompts
│   └── capabilities/
│       ├── registry.ts   # defineCapability, contract, lookup
│       ├── session.ts    # builds a session request and hands it to a provider
│       ├── deterministic.ts  # check_path, read, grep, git_history
│       ├── investigate.ts    # investigate, interpret
│       └── index.ts          # the package surface
└── test/
```

### Step 2: storage
One SQLite file per installation, WAL mode, at `$NOSCOPE_DB` when that is set and otherwise
`~/.noscope/noscope.sqlite`, created on first use; tests point `NOSCOPE_DB` at a temp file.
`NOSCOPE_CLAUDE_BIN` names the Claude Code binary every provider call runs on, the planner's
and each task session's; tests point it at the stub. Current-state tables plus an append-only event
table, updated in the same immediate transaction. No event sourcing: state is read from the
tables, and the events explain how it got there. Every event that changes state records its
mutation in its payload, which is what makes the tables rebuildable from the events.

| Table | Columns |
|---|---|
| `incidents` | `id`, `objective`, `constraints_json`, `priorities_json`, `budget_json`, `questions_json`, `capability_requests_json`, `status` (`open`, `satisfied`, `failed`, `blocked`), `created_at`, `updated_at` |
| `units` | `id`, `incident_id`, `parent_id`, `purpose`, `status` (`active`, `closed`), `created_at`, `closed_at` |
| `tasks` | `id`, `incident_id`, `unit_id`, `capability`, `objective`, `inputs_json`, `expected_output`, `completion_criteria_json`, `evidence_required_json`, `depends_on_json`, `provider`, `model` (both required for a session-backed capability), `instructions`, `budget_json`, `status` (`pending`, `ready`, `running`, `completed`, `failed`, `cancelled`), `result_json`, `created_at`, `completed_at` |
| `claims` | `id`, `incident_id`, `subject`, `predicate`, `object_json`, `status` (`asserted`, `verified`, `rejected`), `basis` (`observed`, `inferred`), `confidence`, `evidence_json`, `provenance_json`, `created_at` |
| `events` | `id`, `scope` (`incident` or `system`), `incident_id` (required for an incident event, null for a system event, enforced by a CHECK), `sequence` (unique per incident, and per the system scope), `type`, `actor`, `payload_json`, `created_at`. A payload carries a `mutation` naming the exact state change the event records, so replay applies that and nothing else; an event with no mutation, such as `plan.proposed`, changes no state. |
| `grants` | `id`, `scope` (`incident` or `standing`), `incident_id` (null for standing), `capability`, `effect`, `reason`, `granted_by`, `per_task` (boolean), `created_at`. Empty in v0. |

Event types in v0: `incident.created`, `incident.blocked`, `incident.closed`, `unit.created`, `unit.closed`,
`task.created`, `task.ready`, `task.started`, `task.completed`, `task.failed`,
`task.cancelled`, `task.insufficient`, `claim.asserted`, `claim.verified`, `claim.rejected`,
`plan.proposed`, `plan.rejected`, `plan.applied`, `task.usage`, `budget.exceeded`,
`question.asked`, `question.answered`, `grant.requested`, `grant.given`, `capability.requested`.

The file records its schema version in `user_version`. A version 1 file (before `basis`)
is migrated in place when opened: verified claims become `observed`, every other claim
`inferred`, since a session claim with no recorded basis is read the conservative way; a
file at any other version is refused.

Capabilities are not a table. The registry is code, and `incident show` prints what is
registered.
### Step 3: equipment and capabilities
Every piece of equipment and every capability is registered by a define call. Equipment is
primitive and the planner never assigns it. Capabilities are what the planner assigns.
The registries describe what can be done, never when.

Equipment kinds in v0:

| Kind | Where it runs |
|---|---|
| Function | In-process, called by a deterministic capability: `read_file`, `stat_path`, `grep_files`, `list_directory`, `git_status`, `git_log`, `git_diff`, `run_readonly`. A session reaches function equipment only through the runtime's own MCP equipment server, after v0: one process per session, advertising exactly the capability's declared function equipment, every call logged as an event. |
| Claude Code built-in tool | Only inside a capability's session, named in that capability's equipment: `Read`, `Grep`, `Glob`, and `Bash` under an allowlist of read-only commands. A capability may instead declare `default` to give its session Claude Code's whole built-in set. |
| External MCP server, after v0 | Only inside a session. Declared as equipment by name and launch command, passed to the provider alongside the runtime's own equipment server. This is how Craft, GitHub, a browser or anything else with an MCP server becomes equipment without an adapter. |

An equipment module is ordinary exported functions, one module per family, no scripts and no
CLI:

```ts
// src/equipment/filesystem.ts

export const grepFiles = defineEquipment({
  name: "grep_files",
  input: z.object({ root: z.string(), pattern: z.string(), glob: z.string().default("*") }),
  output: z.array(Match),
  run: async ({ root, pattern, glob }) => { /* walks root, returns file, line and text per match */ },
});

export const readFile = defineEquipment({ name: "read_file", input: ReadInput, output: FileContents, run: ... });

export const listDirectory = defineEquipment({ name: "list_directory", input: PathInput, output: z.array(Entry), run: ... });
```

A deterministic capability such as `grep` calls `grep_files` directly, in the runtime's own
process, in milliseconds. Equipment shells out only where the thing itself is a command, as
`git_status` runs `git status --porcelain` and parses it. No session calls function equipment
in v0.

```ts
export const investigate = defineCapability({
  name: "investigate",
  description: "Read the files a question points at and return what they show",
  equipment: ["Read", "Grep", "Glob", "Bash"],
  session: { systemPrompt: INVESTIGATE_ROLE, bashAllowlist: READ_ONLY_COMMANDS },
  effect: "read_only",
  input: InvestigateInput,
  output: sessionResult(InvestigateFindings),
});
```

Fields on every capability:

| Field | Meaning |
|---|---|
| `name` | The identifier the planner uses in a plan. |
| `description` | One sentence the planner sees. |
| `equipment` | What this capability may use. A deterministic capability calls it in code; a session-backed one exposes exactly this to its session. |
| `input`, `output` | zod schemas. The validator checks task inputs against the input schema before dispatch, and the output schema is what a session receives as its JSON schema. |
| `effect` | `read_only`, `writes_local` or `writes_external`. v0 registers only `read_only`. |
| `produces` | `verified_claims` for a deterministic capability, whose output is a fact about the machine; `asserted_claims` for a session-backed one. |
| `cost` | Facts that live with the thing so they are at hand whenever it is equipped: rate limit, typical tokens, typical seconds, money per call if any. Equipment declares the same field. The budget logic reads these and nothing else. |

A capability with a session adds the fields that define its setup. The session names a
provider, and the provider renders the fields onto its own command from them:

| Field | Claude Code renders it to | Codex renders it to |
|---|---|---|
| `provider` | The choice of column. | The choice of column. |
| session preamble, fixed in `providers/base.ts` | The first part of `--system-prompt`, identical for every task session on every provider; the planner's call carries its own system prompt in place of it, since it is the Planning Section and not a resource assigned to a task. It orients the session: this is an agentic runtime modeled on the Incident Command System; an incident is any objective Mauria asks to have pursued, not necessarily something gone wrong; a temporary organization of units is built around it and torn down when it is done; the planner drafts an action plan each cycle, a validator approves it, and tasks run through capabilities. Then the mapping of terms, one line each: incident, unit, task, capability, equipment, claim with its statuses, action plan, planner, grant, budget, SOP. Then the session's place: it is a resource assigned to one task inside one unit; the task follows; it reports only against the task's contract; its findings are asserted claims until the runtime verifies them; it cannot change the organization or take on work outside the task; when it lacks something it says so with the outcome `insufficient` and names which kind of thing is missing: a fact a capability could retrieve, permission, means that do not exist yet, or something only a human knows. | Prepended to the prompt, since `codex exec` has no system-prompt flag in its help. |
| `system_prompt` | The rest of `--system-prompt`: the capability's own role text, after the preamble. | Prepended to the prompt after the preamble. |
| `model` | `--model <id>`, always explicit, taken from the task. A capability declares no default. | `-m <model>`, same rule. |
| `equipment` | `--tools "<list>"` naming the Claude Code built-in tools in the capability's equipment, or `--tools default` when the capability declares `default`. | `-s read-only` bounds what the built-in shell can do; per-tool selection is not in the help and is an open item for this provider. |
| `bash_allowlist` | `--allowedTools` entries of the form `Bash(<command> *)`, so read-only tool calls need no approval. | Covered by `-s read-only`; a finer allowlist is an open item. |
| `cwd`, `add_dirs` | The working directory and `--add-dir` entries. | `-C <dir>` and `--add-dir`. |
| `output_schema` | `--json-schema <schema>`, so the result comes back structured. Every session schema carries `outcome: answered \| insufficient`; an insufficient result carries `needed`, a list of what the session lacked, each tagged with its kind (a retrievable fact, permission, missing means, or a human's knowledge), and no claims. | `--output-schema <file>` with the same schema written to a temp file, and `-o <file>` to collect the final message. |

Each provider has a fixed set of isolation flags, so no session inherits Mauria's personal
setup. Claude Code: `--output-format json`, `--setting-sources ""`,
`--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections`, which together drop
a session's context from about 40k tokens to about 3k and keep her CLAUDE.md, skills and
hooks out; `--bare` is not used because it authenticates only with an API key. Sessions are
not made ephemeral: every planner and task session leaves its transcript under Claude Code's
project directory for the session's working directory (`~/.claude/projects/<directory with
slashes as dashes>/<session id>.jsonl`), and the session id is on `plan.proposed`, on
`task.completed`, `task.failed` and `task.insufficient`, and in every asserted claim's
provenance, so a run can
be read back call by call while the runtime is being refined (Mauria, 2026-09-13). Codex: `--ignore-user-config`,
`--ignore-rules`, `--ephemeral`, `--json`, verified present in `codex exec --help` on
2026-09-12 and not yet tested for context size or subscription billing. Permissions come only
from the capability's declaration; with the isolation flags, Mauria's own permission settings
do not load on either provider.

The task is the user message: objective, inputs, expected output, completion
criteria, evidence required, and one line saying what the unit that owns this task is trying to establish as one line of context.

v0 capabilities:

| Capability | Equipment | Session |
|---|---|---|
| `check_path` | `stat_path` | none; produces verified claims |
| `read` | `read_file` | none; produces verified claims |
| `grep` | `grep_files` | none; produces verified claims |
| `git_history` | `git_status`, `git_log` | none; produces verified claims |
| `investigate` | `Read`, `Grep`, `Glob`, `Bash` under the read-only allowlist | yes, model named per task; produces asserted claims with evidence |
| `interpret` | none | yes, model named per task; given evidence and nothing else, produces what it implies as asserted claims, or `insufficient` with what it would need |

The four deterministic capabilities exist so the verifier has something to promote claims
with, and so the planner can ask a precise question without spending a session on it.

A capability may include other capabilities, composed in code. The event log records which
capabilities every incident used under which unit purposes; a composition that recurs across
incidents with the same shape is a candidate for a new capability, and one whose shape varies
with context stays with the planner. The quipu CLI's objective catalog is the first
planned set of such capabilities. v0 registers none.
### Step 4: the planner
One call per cycle, through a provider, as a headless Claude Code call on the subscription, with `--json-schema` so the
response is a validated `ActionPlan` and never prose. Model `claude-opus-5`, no tools,
the same four fixed flags as every session. Tested 2026-09-12 with an
planner-shaped prompt: 3.6k tokens of context and a valid action plan back.
Input, rendered as labeled sections in a stable order so the prefix caches:

1. The incident file's command picture: objective, constraints, priorities, budget remaining, grants given, questions still unanswered.
2. Verified claims.
3. Asserted claims, each with its provenance.
4. The current unit tree with each unit's purpose and status.
5. Tasks completed since the last cycle, with results summarized against their contracts.
6. Tasks that came back `insufficient`, each with what the session said it needed.
7. Open tasks.
8. The capability registry, each with its description and the input fields a task to it must carry (name, type, required or default), and for each provider every model it serves with its cost, so every option is on the table and no task is proposed with inputs the capability cannot take.
9. The rules the validator will apply, so the planner does not propose what will be rejected.

Output:

```ts
const ActionPlan = z.object({
  createUnits: z.array(UnitProposal),            // purpose, parent unit
  closeUnits: z.array(UnitClose),                // unit id, with a reason each
  createTasks: z.array(TaskProposal),// ref, unit, capability, objective, inputs, criteria, dependsOn (task ids or refs in this plan), instructions, provider, model
  cancelTasks: z.array(z.string()),
  claimsToVerify: z.array(z.string()),           // asserted claim ids worth promoting
  incidentStatus: z.enum(["continue", "blocked", "satisfied", "failed"]),
  questionsForHuman: z.array(z.string()),        // things only Mauria can supply; sets incidentStatus to blocked
  grantRequests: z.array(GrantRequest),          // capability, effect, and the reason it is needed; after v0
  capabilityRequests: z.array(CapabilityRequest), // means the planner lacks: what it would need and why; blocks the incident
  applySops: z.array(SopApplication), // SOP name, parent unit, the angles chosen; after v0
  rationale: z.string(),                         // recorded on the action plan event, never acted on
});
```

The planner proposes structure. It never runs a tool, never writes to the store, and never
marks its own conclusions true.

The planner is never without a way to get what it lacks, and each kind of lack has its own
channel:

| The planner lacks | The channel | Who resolves it |
|---|---|---|
| A fact a registered capability can retrieve, from the machine or anything its equipment reaches. | A task. | The runtime, next cycle. |
| Permission for a capability that writes. | A grant request. | Mauria, with `incident grant`. After v0. |
| The means: equipment or a capability that does not exist yet, stated as what it would need and why. | A capability request. | Mauria, by registering it; after v0 the planner itself when the missing equipment is an external MCP server it can declare. A capability request is also the runtime telling her what to build next. |
| Something only a human knows or may decide. | A question for a human. | Mauria, with `incident answer`. |

The incident goes to `blocked` on any of the last three, `incident show` prints them, and
every session is told the same four kinds in its preamble so that an `insufficient` answer
names which one it hit.
### Step 5: the validator
Every action plan passes all of these or is rejected whole, with each failing rule and its
reason recorded as a `plan.rejected` event and fed back as input 9 on the next cycle:

| Rule | Check |
|---|---|
| Capabilities exist | Every task names a registered capability. |
| Units exist | Every task's unit and every new unit's parent is an active unit, or a unit created in this plan; a closed unit takes no new work. A `closeUnits` entry names a unit in the incident. |
| No cycles | The tree stays a tree: no new unit is its own ancestor, and a ref is used once, is not an existing unit id, and does not start with the incident id, so it cannot be mistaken for the id a unit created in the same plan receives. A task ref is held to the same three tests against task ids, and the new tasks' `dependsOn` form no cycle among themselves. |
| No duplicates | No new task repeats an open or completed one, or another new task in the same plan, with the same capability and effective inputs (as the capability's schema parses them) under the same unit. A task the plan cancels does not count. |
| Inputs validate | Task inputs parse against the capability's input schema. |
| Span of control | No unit ends the action plan with more than 7 direct children, units and tasks combined. Target is 5. |
| Effect policy | v0 rejects any capability whose effect is not `read_only`. After v0, a task to a capability whose effect is `writes_local` or `writes_external` passes only with a grant on this incident for that capability. |
| Budget respected | A task's budget, where it sets one, fits inside the incident's remaining budget. A session-backed task carries a time bound and, when the incident bounds tokens, a token bound. A deterministic task runs no model and needs neither. |
| Dependencies resolve | Every `dependsOn` names a task in the incident that is completed or still open and not cancelled in this plan, or the ref of a task created in this plan, so the new task can become ready. Every `cancelTasks` entry names an open task, once; every `claimsToVerify` entry names an asserted claim. |
| Model known | Every task to a session-backed capability names a provider and model pair. The known list is every model the provider serves, never a curated subset, so Mauria can ask for whatever she wants and the planner sees every option. For Claude Code the known list is every Anthropic model currently served: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`; Codex pairs are added when that provider is tested. A task to a deterministic capability has no model field at all, since nothing in it runs a model. |
| Closing is clean | A unit closed in this plan is active, has no running task after the plan's cancels, is closed once, and is given no new unit or task in the same plan. |
| Status is earned | `satisfied` requires every open task completed or cancelled, no new tasks in the plan, and at least one verified claim. `satisfied` or `failed` raises no question, capability request or grant request, since a closed incident answers none. `blocked` raises at least one, since nothing else could unblock it. |

### Step 6: dispatch, record, verify
Ready means every dependency is completed. v0 runs ready tasks sequentially. Each
run writes `task.started`, then the result and `task.completed` or
`task.failed` in one transaction, with a `task.usage` event carrying what the run spent:
the whole input context (the figure a token budget counts) and its split into uncached,
cache-write and cache-read tokens, output tokens, seconds, and the provider's own cost at
list price when it reports one (`total_cost_usd` in the Claude Code envelope). The
planner's call records the same shape, and the model it ran on, on `plan.proposed`. A deterministic run spends no
tokens and costs nothing; a run that fails before the provider answers records no cost,
since none is known, and a spend summed with such an event in it carries no cost, so a
figure is never printed that a failed session would have raised. The spend `incident show`
prints, and a budget counts, is the tasks'; the planner's usage is recorded on
`plan.proposed` and not counted, a design call on the revisit list.

The verifier turns results into claims. A deterministic capability's result becomes a `verified`
claim with the capability and the effective inputs as provenance: the inputs as parsed, with
defaults applied and every path field resolved against the incident's working directory, so
the record says exactly what ran. Path inputs are declared per capability (`paths`) and
resolved before the run, and every claim subject is an absolute path (`/abs/file` or
`/abs/file:line`), so claims about one file from different tasks compare equal and a
session's assertion can match a later deterministic result. A claim can only enter the store
as `asserted` or `verified`, and `verified` on entry requires deterministic provenance. A
deterministic claim enters with basis `observed`; a session names the basis of each of its
claims, and a result without one does not fit the schema. A
session-backed capability's result
becomes `asserted` claims with the session id as provenance; an `insufficient` result becomes
no claims and an `task.insufficient` event carrying what was needed. Promotion of an asserted
claim in v0 happens only when a later deterministic result matches it on subject, predicate
and object; the promotion's `claim.verified` event records the task, its effective inputs,
the matching verified claim and its time, so a promotion can be audited without rerunning
anything. The planner asks for it through `claimsToVerify`, naming the asserted claims it
wants established, and proposes the deterministic task that would establish them.
### Step 7: the command surface
| Command | Does |
|---|---|
| `noscope incident create "<objective>" [--constraint ...]` | Creates the incident and its root unit, `command`. |
| `noscope incident show <id>` | The incident file: objective, constraints, priorities, budget and spend, claims by status, open tasks, decisions with reasons, questions waiting on Mauria, capability requests, grants, registered capabilities. |
| `noscope incident tree <id>` | The unit tree with task marks: done, running, ready, pending. |
| `noscope incident step <id>` | One cycle, then stop. Prints the action plan, the validator's verdict, what ran, what changed. |
| `noscope incident run <id> [--max-cycles N]` | Repeats `step` until the incident leaves `open` or the cap is hit. |
| `noscope incident events <id>` | The event log with timestamps and actors. |
| `noscope incident review <id>` | The After Action Review computed from the event log: each cycle with its verdict, rejections, tasks run (capability, model, tokens with the cache split, seconds, cost, claims), questions and answers; totals by role and model; plan, task and claim counts; the cost, recorded where the provider priced it and bounded at list rates where it did not. Deterministic; the judged review is the session-backed `review` capability, after v0. |
| `noscope incident sop <id> <name>` | Adds an SOP's unit and its tasks to the incident in one action plan. After v0. |
| `noscope incident answer <id> "<text>"` | Answers the planner's open question and returns the incident to `open`. |
| `noscope incident grant <id> <capability> [--per-task]` | Gives a grant for one capability on this incident, recording the planner's reason; `--per-task` makes each task under it ask again. After v0. |
| `noscope grant standing <capability>` | Whitelists a capability everywhere. After v0. |

`step` is the primary command in v0. `run` exists so the milestone can be demonstrated
end to end, not for daily use.

Exit codes, the same for every command:

| Code | Meaning |
|---|---|
| 0 | The command did what it says. |
| 1 | The command failed for a reason outside the incident's record: a provider could not be run, the store could not be opened; stderr names it. |
| 2 | Usage: an unknown command or bad arguments; help goes to stderr. |
| 3 | The command is in the design but not built yet; stderr names what delivers it. |
| 4 | The incident, unit or task named does not exist. |
| 5 | The command could not proceed because the incident is `blocked`, `satisfied` or `failed`. |

Every command receives a context: the working directory, the environment, and where to
write stdout and stderr. Commands are registered in one table with an optional handler; a
command without a handler is the exit-3 stub, so a later PR lands a command by filling in
its handler and touches neither help nor dispatch.
### Step 8: the first incident
A real, read-only investigation on this machine, so every step can be checked by hand:

> Determine why Roughdraft scrolls to the bottom comment after a comment is deleted, instead
> of staying where the deleted comment was, and identify the code path responsible, in
> `~/Documents/Projects/roughdraftplus`.

This is a defect Mauria met during this design's review, so it is known to be real, and the
answer is verifiable by reading the code the incident points at. The interesting output is
not the answer but the tree: whether the planner opens separate units for the delete
handler and the scroll or focus logic, closes the one that turns out irrelevant, and stops
when a verified claim names the code path.
### v0 acceptance
v0 is done when all of these hold on the first incident:

1. `incident create` produces an incident with one root unit, `command`, and one event.
2. The first `step` yields an action plan that creates at least one unit and one task, and the validator accepts it.
3. Tasks run and their results appear as claims with the right status.
4. A later `step` closes a unit that has served its purpose, visible in `tree` and `events`.
5. An action plan that breaks span of control is rejected and the next action plan groups instead.
6. The incident reaches `satisfied` with a verified claim naming the code path.
7. Every state change has a matching event, checked by a test that replays events against the tables.
8. An `interpret` task given too little evidence returns `insufficient` naming what it needs, and the next `step` creates a task that supplies it.
## Reference
### Verified facts the design rests on
| Fact | How it was checked |
|---|---|
| Headless Claude Code runs on the subscription when no API key is set. | A `claude -p` call succeeded on this machine with no `ANTHROPIC_API_KEY` in the environment, 2026-09-12. |
| Default headless context is about 40k tokens in an empty directory and about 56k in the home directory. | Usage fields of test calls, 2026-09-12. |
| `--system-prompt` on its own, without the other four fixed flags, leaves CLAUDE.md and hook output in the session's context. | A probe session answered yes to seeing both, 2026-09-12. |
| The four fixed flags in Step 3 bring context to about 3k and remove both. | Usage fields and a probe answering no to both, 2026-09-12, with `--no-session-persistence` also set; that flag only stops the transcript being written and was dropped 2026-09-13 so runs can be studied. |
| With `--setting-sources ""` the model falls back to Opus 5. | The `modelUsage` field of the test call. |
| `--bare` authenticates only with an API key. | `claude --help`. |
| Codex is installed and `codex exec` has `-m`, `-s read-only`, `-C`, `--add-dir`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--output-schema`, `--json` and `-o`. | `codex exec --help` on this machine, 2026-09-12. Nothing run through it yet. |
| The Claude Agent SDK requires an API key. | The SDK quickstart, read by a docs subagent; not read directly. |
| zod 4 converts a schema to JSON Schema with `z.toJSONSchema`, targets draft-2020-12 by default, and cannot represent dates, maps, sets, transforms or bigints. | The zod.dev JSON Schema page, fetched 2026-09-12. |
| Headless `--tools` filters built-in tools only; MCP tools from `--mcp-config` stay available even with `--tools ""`. | Four test calls against a minimal stdio MCP server, 2026-09-12; `spikes/mcp-tools-filter/run.sh` reproduces them. |
| `--json-schema` returns a schema-valid `structured_output` field, and `--tools ""` plus the five flags then fixed (the four of Step 3 and `--no-session-persistence`, since dropped) work with it. | A test call on the installed version with an planner-shaped prompt and action plan schema, 2026-09-12. |

### Model choices
| Role | Model | Because |
|---|---|---|
| Planner | `claude-opus-5` | The action plan is the judgment in the system; Opus 5 is the default for anything nontrivial, and it ran the test action plan well. |
| `investigate`, `interpret` | Named per task by the planner, any model the provider serves | No defaults, ruled 2026-09-12. Haiku for a narrow read with little equipment; Opus when the read is subtle. |
| Anthropic models Claude Code accepts by full name, as of 2026-09-12 | Current generation: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`. Still served: `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`. | All are known to the validator. The older ones cost the same or more for less, so the planner is told to prefer the current generation unless a task says otherwise. |
| Later builder, reviewer and `send_email`-shaped capabilities | `claude-fable-5-1` or `claude-opus-5` with the equipment the job needs | Not in v0. |

### Custom equipment for sessions (after v0)
The goal is that a session uses whatever equipment it is given without learning anything:
the equipment should look like any other tool call, with a schema, and be callable the
first time.

| Option | How the session sees it | Tradeoffs |
|---|---|---|
| The runtime serves its equipment registry as an MCP server, passed with `--mcp-config` and `--strict-mcp-config`. | As native tools with names and input schemas, exactly like `Read` or `Grep`, invoked without any syntax to learn. | The most obvious for the session, and the schema validates inputs before the equipment runs. Costs: the runtime must implement an MCP stdio server, every session pays its startup, each tool definition adds context tokens, and whether `--tools` filtering also filters MCP tools is untested. |
| The runtime exposes equipment as one CLI command, `noscope equipment <name> --arg value`, and the capability allowlists exactly that command in Bash. | As a shell command it must be told about in the capability's prompt, called through the `Bash` tool, returning JSON on stdout. | Uses only mechanisms verified today, no server to write, and one allowlist entry bounds it. Costs: the session has to learn the command's syntax from the prompt, argument errors surface as text rather than schema rejections, and every call spawns a process. |
| No custom equipment in sessions at all: split the work into a deterministic capability that runs the equipment and a session that interprets its output, sequenced by the planner. | The session never calls equipment; it receives results as evidence in its task. | The purest ICS shape, and it keeps facts on the verified side. Costs: it fails wherever judgment and equipment must interleave, as in `send_email`, where composing needs the model and sending needs the equipment in the same stretch. |
| The Claude Agent SDK's in-process custom tools. | As native tools. | Ruled out: the SDK requires an API key, so it leaves the subscription. |

Ruled: the MCP server, with the CLI command as the fallback if MCP proves awkward in headless
mode. Two reasons. It is the one path both providers already speak, since Codex manages MCP
servers with `codex mcp`. And it makes any external MCP server equipment too: a capability
declares it by name and launch command, and the session gets it next to the runtime's own
server, so Craft, GitHub or a browser needs no adapter. The third option is not an alternative to the first two
but the default shape: a session gets custom equipment only when its judgment and the
equipment must interleave.
### Storage: `better-sqlite3` versus `node:sqlite`
| Consideration | `better-sqlite3` | `node:sqlite` |
|---|---|---|
| Install | A native addon with prebuilt binaries per Node version, and a compile when no prebuilt matches. | Built into Node 24. Nothing to install. Verified working on this machine 2026-09-12. |
| Stability | Mature, years of production use, and pinned by us. | Prints an experimental warning and its API may change between Node versions. |
| Speed and API | Synchronous, the fastest SQLite binding in the Node world. | Synchronous, fast enough for this. |
| Ruling | Chosen 2026-09-12: a dependency we pin cannot change under us. | Not used. |

### The MCP equipment server, once built
One server implementation, one process per session. The session's MCP config launches
`noscope equipment-server` with the capability's equipment list and the task id, so the
server advertises only that equipment; `investigate` might expose `grep_files` and
`read_file` while `send_email` exposes `lookup_contact` and `send_mail`, from the same code.
Because the server is the runtime's own code and knows the task id, every equipment call a
session makes lands in the event log with provenance, the same as a deterministic
capability's. Cost: a Node process start, on the order of tens of milliseconds, an MCP
handshake of a few JSON messages, and one pipe round trip per call, against a session that
already costs seconds. A server per capability would duplicate the registry and turn every
new capability into a new process type.
### Speed
Measured 2026-09-12 on this machine, all with the five flags then fixed (the four of Step 3 and `--no-session-persistence`, dropped 2026-09-13):

| Call | Time |
|---|---|
| A minimal Haiku session that only replies | 3.8 s wall, of which 1.0 s is API time. The rest is process startup, paid by every headless invocation. |
| A Haiku session that makes one Bash call and reports | 4.4 s of API time over two turns, plus startup. |
| The Opus planner returning six units and five tasks | 14.2 s of API time, plus startup. |
| A deterministic capability | Milliseconds. |

So one cycle as written is the planner, about 15 to 20 s, plus its tasks run one
after another, each session-backed one roughly 7 to 30 s and each deterministic one
negligible. An incident that takes five cycles with two sessions each runs three to four minutes.
That is slow for a daemon and right for v0, which is stepped by hand to be watched. The
lever after v0 is running ready tasks in parallel, which turns the sum into a
maximum; the startup cost per session stays unless sessions are reused with `--resume`,
which is untested for this use.
## Open questions
| What is undecided | Needed for v0? | What waits on it, and what the build assumes meanwhile |
|---|---|---|
| A Situation Unit: ICS gives it the job of collecting and summarizing the situation so command sees a picture rather than raw reports. Here it would be a periodic session-backed capability that reads the incident file and writes a situation summary, for keeping perspective across many cycles and for triage when noscope runs with little supervision. Whether it earns a call of its own or folds into the planner's input rendering is the question. | No. | Autonomous incident cannot be designed until this is settled; v0 is stepped by hand and the incident file is the picture. |
| Priorities across incidents: the picture above any one incident, which ICS calls the Multi-Agency Coordination System, so that an incident's command knows what matters system-wide and not only for its own objective. | No. v0 runs one incident at a time. | Multi-incident incident cannot be designed until this exists; the incident file is built so a system-level standing-priorities document can be rendered into it later. |
| The Codex provider's untested parts: per-tool selection and a finer command allowlist beyond `-s read-only`, context size under its isolation flags, and whether it bills the ChatGPT subscription. | No. v0 runs on Claude Code only. | The Codex provider cannot be declared working until one test session runs through it, the same tests run for Claude Code today. |

---
counters:
  comments: 69
comments:
  c26:
    body: will this thing be slow as written?
    by: user
    at: 2026-09-12T21:42:05.935Z
  c52:
    body: show everything that didn't render in chat
    by: user
    at: 2026-09-13T00:42:12.108Z
