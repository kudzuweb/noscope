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
| The repository is `kudzuweb/noscope`, public since 2026-09-15. | Ruled by Mauria 2026-09-12 as private until she used it at work, and made public on 2026-09-15 for that use, after round 3 proved out. `CLAUDE.md` at the root orients any Claude pointed at the repository. |
| Every session-backed capability can answer "insufficient": its output schema carries an outcome of `answered` or `insufficient`, and an insufficient result names what evidence it would need. `interpret`, the sandboxed capability with no equipment, stays in v0 because of this. | Ruled by Mauria 2026-09-12. A sandboxed "tell me what you think" cannot go and get more, and that is the point: when it says it cannot answer and why, the planner gets a precise next task and Mauria gets a diagnostic on prompts and tasks. |
| Platform-agnostic: a session runs on a provider, and Claude Code is the first provider, not the only one. Codex is the second. | Ruled by Mauria 2026-09-12. She wants to deploy Codex, or anything else, as a capability. Nothing above the session layer knows which provider ran it. |
| Custom equipment reaches a session over MCP, and any external MCP server can itself be equipment. | Ruled by Mauria 2026-09-12. Her reason: MCP means other MCP servers, Craft, GitHub, a browser, can be handed to a capability as equipment with no adapter, and both providers already speak it. The CLI-command path stays as the fallback if headless MCP misbehaves. The first external equipment, two browsers, landed in round 2 (R2-7); the runtime's own equipment server stays after v0. |
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
| Unit | A box in the incident's temporary tree that owns one slice of the problem, the way an ICS Branch or Group does. It has an objective, a parent and children, and it opens, subdivides and closes as the planner's picture of the problem changes. A unit is a type plus a config (round 4, R4-10, ruled 2026-09-15): the type is the form and the protocol, the config is the filled form, and the unit's `type` names which. Every unit has a leader (round 3, R3-4): a session on the provider and model the unit names, holding the unit's declared equipment and Bash allowlist, created when the unit first has a ready task, resumed for each task that runs inside it and for each turn, and demobilized when the unit closes. Under the `base` type the leader runs the unit's tasks in order and reports against the objective; the root unit, `command`, is the one unit of the `ic` type, owns the incident objective, is created with the incident, and its leader is the Incident Commander. A unit is `waiting` (R3-6) from the report on which its leader raised a resource request until Mauria answers it: it runs nothing and takes no new task, its pending tasks stay pending, and the other units and the incident go on. |
| Unit type | The form and the protocol of a kind of unit, registered by name in `src/units/` as capabilities are (R4-10). The form is a zod schema of the fields a config of the type fills, every form carrying a `role` field for the role text its session reads (defaulting to the type's own), with descriptions the planner's schema renders. The protocol is how a unit of the type uses what is in the box: the seat and role text its session holds, whether it files reports the IC answers, whether a task runs inside its session, the rules its assignments are held to, and the turns it takes around its tasks in a pass. Two types exist: `base`, the led unit (`src/units/base.ts`: the form is the planner's unit proposal less the ref and the parent, objective, leader, equipment, Bash allowlist and role; the protocol is the leader's turns), and `ic`, command (`src/units/ic.ts`: the form is the IC's provider and model, its equipment and allowlist for deterministic tasks and its role, with no objective, since the incident's is its objective; the protocol is the IC's turns in `src/ic.ts` plus the root's pass). A plan may create a unit of `base` only; the runtime creates the one `ic` unit with the incident. More types will be written and saved, so the registry, the table and the code permit that. |
| Unit config | A type's form filled: the values chosen for one incident, held on the unit's row (R4-10). A config keeps its type's protocol, since it occupies the same place in the hierarchy and reports the same way; what varies between configs of a type is the form's values, the role text included. A saved config (R4-11) is a filled form less the objective, kept under a name and deployed by name in a plan. |
| Task | A bounded piece of work owned by one unit and bound to one capability: objective, inputs, expected output, completion criteria, evidence required, dependencies, what it reads by reference (`evidenceFrom`: claims by id, and tasks whose results it needs), and for a session-backed capability the model and any instructions. It is the worker's brief, and for a session it is the prompt the session receives: the incident's objective, the current hypothesis and the claims it rests on, the hierarchy around the owning unit, then the task, then the referenced claims and results attached by the runtime. A task on its unit leader's provider and model whose capability needs no equipment or Bash command beyond the unit's runs inside the leader's session, as one resumed call with the brief and the capability's schema; any other session task runs in a session of its own, and a deterministic task in process, and either result reaches the leader on its next turn. A session task may also declare a strike team (`strikeTeam`, round 3, R3-5). |
| Strike team | Several subagents of one kind and model sent on one task (ICS: same kind and type, one leader). Whoever defines the task defines the team with it: a task's `strikeTeam` entry names the kind, its model, its tools, the member's system prompt, how many the leader intends to send and why; the unit's leader may also ask for one in a turn (`requestStrikeTeam`), which the runtime declares on the task that runs next. No preset kinds and no default kind exist (ruled 2026-09-14), so the record shows what leaders ask for. The validator checks the model against the provider's list, the tools against the read-only built-ins, and the count against the task's token bound, and nothing else. The kinds are defined for the call that runs the task alone, and every member's run is filed as `subagent.ran` under that task. |
| Task force | A task that declares more than one kind: the same field with several entries, the mixed-kind team ICS sends for one mission. |
| Equipment | A primitive: a function the runtime calls in-process, a Claude Code built-in tool such as Read, Grep or Bash under an allowlist, or later anything else a capability needs to do its work. Registered by name. Never assigned by the planner. |
| Capability | The assignable thing: declared equipment plus, when judgment is needed, a headless session with a system prompt; the model comes from each task. A capability with no session is deterministic and produces verified claims; one with a session produces asserted claims. A capability may include other capabilities. Later, a human. |
| Provider | A program that can run a session: Claude Code first, Codex second, later an HTTP API or a human. A provider maps the session fields onto its own command line and turns its output back into the runtime's result shape. Everything above the session layer is provider-blind. |
| Claim | A statement about reality with a status, a basis and provenance. The status is a label for the source and gates nothing: `verified` when deterministic equipment produced it, `asserted` when a session did; `rejected` is in the enum and nothing sets it yet. The basis is what the validator keys on: `observed` when it was seen in code, in output or in a browser, `inferred` when it was reasoned to from what was seen; an observed claim counts as proven whichever source produced it, and a status never changes after entry (ruled 2026-09-14: promotion fired in neither live run, and sessions were right about the code 74 of 75 audited times). Confidence means the same on every claim: observed, 0.9 to 1; inferred from code, at most 0.7; runtime behavior not reproduced, at most 0.5. |
| Event | One append-only record of something that happened, written in the same transaction as the state change it describes. |
| Action plan | The planner's plan for one operational period: units to create or close, tasks to create or cancel, questions for a human, grant requests, capability requests, incident status. It is the tactics for the period, drafted by the planner against the period's objectives and the IC's situation as a suggestion for the IC, reviewed once by the IC (approved, corrected for one redraft, or amended), checked by the validator, and only then applied. |
| Situation | The picture of the incident every seat works from: what changed since the last turn, the hypothesis, the observed claims it rests on, every inferred link with what settles it (a task, by an open task's id or the ref the plan is to give it, or deferred with a why), and the claims to keep in view. The IC writes it on every command turn (round 4, R4-5; the planner wrote it into each plan until then, ruled by Mauria in review on 2026-09-15: the IC owns it once it starts updating it), the planner reads it in section 10 and drafts the tactics that work it, the validator holds the plan to its inferred links, every leader's orientation and every task's brief carry its hypothesis and proven claims, and `incident show` prints it under the period. A reassignment is written into the slice it concerns rather than listed apart; a link deferred is a decision recorded, not an omission. |
| Cycle | One operational period, in eight steps (round 3, R3-7): (1) the runtime renders the IC's briefing, the change report since the IC last acted followed by the incident file; (2) the IC's command turn sets the period's objectives and priorities, writes the situation (R4-5), closes units, answers what it can, raises what only Mauria can supply, and says whether the incident continues, and when it does not the cycle stops here; (3) the planner drafts an action plan against the period and the situation; (4) the IC reviews the draft: approve, correct (the planner redrafts once against the corrections and the IC then approves or amends), or amend; (5) the validator checks the plan to apply; (6) it is applied; (7) the units run under their leaders until they report or one report changes the picture; (8) stop. At most two planner calls and two IC reads per cycle, plus one handoff call before the command turn or a review when the IC's context has reached the handoff threshold (Step 6); the IC is never consulted per task. `incident step` runs exactly one. |
| SOP, standard operating procedure | A saved unit configuration that can be added to any incident: the unit's purpose, the tasks it opens, each with its capability, instructions and equipment, the angles the planner may choose among for this incident, and the unit's completion criteria. A code review SOP, for example, opens a review unit whose tasks read the change from the angles that matter for it. Capabilities compose work into one assignable result; SOPs compose organization into a unit. Declared in code under `sops/`, applied by command or by the planner. After v0. |
| Incident file | The one place command keeps the state of an incident: objective, constraints, priorities, the current operational period's objectives and priorities as the IC set them, budget and what is spent, the current tree, findings by status, every decision with its reason, questions waiting on a human, grants given, and pointers to evidence. The IC's briefing and the planner's input are both rendered from it in full, the IC's opening with the change report since it last acted; a task receives the objective, the period, the last situation's hypothesis and proven list, its own slice, and what it names in `evidenceFrom`. Stored across the tables in Step 2 and printed by `incident show`. |
| Operational period | ICS's word for the span one action plan covers; here it is one cycle. The IC opens it by setting its objectives (what this period must establish) and priorities (the incident's, restated or revised), recorded on the incident and rendered into the planner's section 1 and into every leader's orientation and every task's brief. It ends when the units have reported or when one report changes the picture. |
| Incident briefing, transfer of command | The first handoff document (round 3, R3-8): what the initial IC writes from its size-up when the incident is created, on ICS 201's lines (kind, dominant problem, what is obviously needed and whether a tool checked it, initial objectives, an initial organization sketched one unit per line, questions for Mauria, hazards, and the incoming commander's provider and model with a reason), recorded as `incident.briefed`. Command then transfers to the IC proper on the model the briefing names, or `--ic-model`, recorded as `command.transferred` with the briefing as its document; the same event records R3-9's handoff at the context threshold, told apart by `kind` (`initial`, `handoff`). The IC's first act on taking command is to evaluate the briefing item by item: nothing in it binds it. |
| Budget | A bound on tokens, wall time or both, set on an incident or on a task. The planner sees what remains and plans inside it; the validator rejects a task that does not fit; the dispatcher enforces the time bound and records usage. The costs it reasons with are facts stored on the equipment and capabilities themselves (see `cost` in Step 3), never estimated elsewhere. Unlimited is allowed and is the v0 default. |
| Grant | Permission from Mauria for a capability whose effect is not `read_only`, with the planner's stated reason attached. Least privilege: nothing that writes runs without one. Three levels stack: an incident grant covers every task on that incident for that capability, which is the default; a standing grant in a config file whitelists a capability everywhere, so she stops approving the same thing; and per-task approval can be switched on for a capability when a single use deserves its own yes. Auto-whitelisting after some number of unqualified approvals is a later feature, and whether its count is per incident or global is decided after she has used it. v0 registers only `read_only` capabilities, so no grants are needed until after v0. |

### ICS mapping
Definitions checked against the NIMS Third Edition (FEMA, October 2017) on 2026-09-12.

| ICS term | Here |
|---|---|
| Incident: an occurrence that necessitates a response. | Incident, same word. Here it means anything Mauria asks for, a build as much as a failure. |
| Operations Section: the part of the incident organization that does the tactical work. | The units under command with their leaders: each leader runs its unit's tasks and reports against the unit's objective; tasks run by capabilities, inside the leader's session or beside it. |
| Agency Administrator: the executive above the incident who delegates authority to the Incident Commander, sets policy and priorities, and is briefed. | Mauria. Grants are her delegation of authority, `op show` is her briefing, and questions for a human go to her. |
| Safety Officer: on the Command Staff, with independent authority to stop any unsafe act. | The validator's effect policy plus grants: nothing that writes runs without her permission, and the validator can stop an action plan on its own. |
| Public Information Officer and Liaison Officer: what is told outside the incident, and the contact point for other agencies. | None. An incident is not charged with keeping anyone informed; providers and external MCP servers cover the liaison work without a role. |
| Incident Commander: develops objectives, orders and releases resources. Planning Section: collects the situation picture, tracks resources, drafts the Incident Action Plan for the commander to approve. | The Incident Commander is the root unit's leader (round 3, R3-7): one persistent session, briefed with the full incident file at the top of every cycle, that sets the operational period's objectives and priorities, reads the units' reports, closes or re-tasks units, reviews the planner's draft in one round, and declares the incident met, failed or blocked on a question for Mauria. It scopes, breaks down, equips and judges; its digging is assigned to tasks under units, never done itself. The planner drafts the action plan as the Planning Section does, stateless, fed the full file plus the period's objectives and priorities, as the tactics suggested to the IC; the situation picture, which ICS gives the Planning Section's Situation Unit, is the IC's here (R4-5): the IC writes it on every command turn, the planner reads it in section 10 and drafts against it, and `incident show` prints it under the period. The runtime is the Planning Section's bookkeeping: it renders the briefing, records every turn, checks the plan's shape, dispatches and records. The IC's review is the commander's approval of the plan; the validator's check follows it, and Mauria answers grants and questions. |
| Initial Incident Commander and transfer of command: the first arriving officer sizes the incident up, takes initial actions and briefs the incoming commander on ICS 201; command passes with that briefing, and the incoming commander is bound by none of it. | The initial IC (round 3, R3-8): a session on a cheap model (`claude-haiku-4-5` by default, `--initial-model` at `create` overrides) that runs once when the incident is created, with the read-only tool set and the runtime's own findings (registered capabilities and equipment, the budget, whether the working directory is a git repository and its state, whether each URL a constraint names answers), and writes the incident briefing: kind, dominant problem, what is obviously needed and whether it was checked, initial objectives, an initial organization, questions for Mauria, hazards, and the incoming commander's model with a reason. The transfer of command sets the root unit's leader from the briefing (or `--ic-model`) and is recorded with the briefing as its document; a question in the briefing blocks the incident before the IC starts. The IC proper's first command turn carries the briefing and must evaluate it, item by item, accepting, rewriting or discarding each, so a stronger model is never bound by what a cheaper one thought; `incident review` counts what it kept. |
| Section, Branch, Division, Group, Unit: the organizational levels, distinguished by depth and by functional versus geographic responsibility, each with a supervisor. | All are the one thing called a unit here. Depth is whatever the tree needs, a unit's objective says what it is responsible for, and its leader is the supervisor: a session that holds the objective, directs the unit's tasks and files a situation report (`unit.reported`: outcome `met`, `not_met` or `progress`, what changed on which claims, whether the picture changed, and for `not_met` why and a suggestion for the IC to decide on). A unit's leader is called its leader; the root's is the IC. |
| Single Resource, Strike Team (same kind and type, one leader), Task Force (mixed kinds for one mission). | A capability is a single resource, and equipment is equipment; the word is ICS's. A strike team is several subagents of one kind and model that a unit leader sends on one task, declared on the task by the plan or requested by the leader in a turn (round 3, R3-5); a task force is the mixed-kind version, the same field with several kinds. No presets and no default kind: whoever defines the task defines the team, choosing kind, model, tools, prompt and count and saying why, and the record of what leaders ask for is how presets and least privilege are learned later. A capability that includes other capabilities is composition in code, not a team. |
| Resource typing: categorizing resources by capability so everyone means the same thing by a name. | The capability registry: name, description, schemas, side effects. |
| Assignment: a task given to a person or team based on the objectives in the Incident Action Plan. | Task, ruled by Mauria as the software word for the same thing. |
| Incident Action Plan and Operational Period: the objectives and tactics for one period, then a new plan. | Action plan, same word: the planner's draft for the period, reviewed by the IC and checked by the validator before it is applied. One cycle is the operational period, opened by the IC's command turn. |
| The Planning P: objectives, tactics meeting, planning meeting, plan approval, briefing, execute, repeat. | The cycle's eight steps: the IC is briefed and sets the period's objectives (objectives), the planner drafts (tactics and planning meetings), the IC approves, corrects or amends (plan approval), the validator checks and the plan applies (briefing), the units run to their reports (execute), stop, repeat. |
| Span of control: one supervisor to five is the guideline, not a rule. | Validator rule: target 5 direct children, maximum 7. |
| Demobilization: the orderly release of a resource when no longer needed. | Closing a unit and cancelling its tasks. |
| Situation Unit and Resources Unit: who tracks what is known and where every resource is. | The store holds what is known: the claims, and the tasks and their statuses as the resource tracking. The Situation Unit's summary, the picture command works from, is the IC's own situation, written on its command turn (R4-5). |
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
│   ├── planner.ts        # the planner's call: renders the ten sections, records plan.proposed, redrafts once on a correction
│   ├── ic.ts             # the Incident Commander: the change report and briefing, the command turn, the review
│   ├── validator.ts      # action plan rules
│   ├── dispatcher.ts     # runs each unit's tasks under its leader, one unit at a time
│   ├── leader.ts         # a unit's leader: role text, orientation, turns, what runs inside its session
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
| `incidents` | `id`, `objective`, `constraints_json`, `priorities_json` (Mauria's, from `create`), `budget_json`, `questions_json`, `capability_requests_json` (each question and request carries `unitId` when a unit's leader raised it, and nothing when the planner did), `status` (`open`, `satisfied`, `failed`, `blocked`), `period_json` (the current operational period: its number, objectives and priorities as the IC set them; null before the IC's first turn), `created_at`, `updated_at` |
| `units` | `id`, `incident_id`, `parent_id`, `type` (the registered unit type, R4-10: `ic` for command, `base` for a led unit), `objective`, `leader_json` (provider and model), `equipment_json`, `bash_allowlist_json`, `role` (the config's own role text, null for the type's), `session_id` (the leader's session, null until it first runs), `status` (`active`, `waiting`, `closed`), `created_at`, `closed_at` |
| `tasks` | `id`, `incident_id`, `unit_id`, `capability`, `objective`, `inputs_json`, `expected_output`, `completion_criteria_json`, `evidence_required_json`, `depends_on_json`, `evidence_from_json`, `provider`, `model` (both required for a session-backed capability), `instructions`, `budget_json`, `strike_team_json` (the kinds the leader may send on the task; `[]` when none), `status` (`pending`, `ready`, `running`, `completed`, `failed`, `cancelled`), `result_json`, `created_at`, `completed_at` |
| `claims` | `id`, `incident_id`, `subject`, `predicate`, `object_json`, `status` (`asserted`, `verified`, `rejected`), `basis` (`observed`, `inferred`), `confidence`, `evidence_json`, `provenance_json`, `created_at` |
| `events` | `id`, `scope` (`incident` or `system`), `incident_id` (required for an incident event, null for a system event, enforced by a CHECK), `sequence` (unique per incident, and per the system scope), `type`, `actor`, `payload_json`, `created_at`. A payload carries a `mutation` naming the exact state change the event records, so replay applies that and nothing else; an event with no mutation, such as `plan.proposed`, changes no state. |
| `grants` | `id`, `scope` (`incident` or `standing`), `incident_id` (null for standing), `capability`, `effect`, `reason`, `granted_by`, `per_task` (boolean), `created_at`. Empty in v0. |

Event types in v0: `incident.created`, `incident.blocked`, `incident.closed`, `unit.created`, `unit.closed`,
`task.created`, `task.ready`, `task.started`, `task.completed`, `task.failed`,
`task.cancelled`, `task.insufficient`, `claim.asserted`, `claim.verified`, `claim.rejected`,
`plan.proposed`, `plan.rejected`, `plan.applied`, `task.usage`, `budget.exceeded`,
`question.asked`, `question.answered`, `grant.requested`, `grant.given`, `capability.requested`,
`capability.answered`. Round 3 adds `tool.called` and `subagent.ran`, one per tool call a
session makes and one per subagent it spawns; `leader.started` (a unit's leader session
recorded on the unit, the mutation `unit.session`), `unit.continued` and `unit.reported`
(one per leader turn, with the call's usage), `picture.discrepancy` (a seat saying the
update it received describes a different problem), `strike_team.defined` and
`strike_team.rejected` (a strike team declared on a task by the plan or by its leader, with
the mutation `task.strikeTeam` when a leader's request is accepted, and a leader's request
refused with its reasons), `command.turned` (the IC's command turn, its situation on it
from R4-5, the mutation `incident.period` when it was accepted), `command.rejected` (one per rule the
turn failed), `plan.reviewed` (one per IC review of a draft, with the verdict),
`unit.waiting` and `unit.resumed` (a unit entering `waiting` on its leader's resource
requests and returning to `active` when they are answered, both the mutation
`unit.status`),
`command.failed` (an IC call that got no usable answer, with the API's refusal when that is
what it got), `leader.failed` (a leader's turn the API refused, with the refusal and the
call's usage; R3-10a; when the refusal moves the unit's leader to the fallback model it
carries `fallback` and the mutation `unit.leader`; R4-7), `leader.released` (a unit's
session dropped through the log, the mutation `unit.session` with a null id: the version 5
migration, the IC's handoff, where it carries the outgoing session's document and the
call's usage, and a refused session, with the category),
`incident.briefed` (the initial IC's briefing with the size-up's session, model, usage and
the runtime's findings; R3-8) and `command.transferred` (a transfer of command, one shape
for every kind: `kind`, the unit, the outgoing and incoming session ids and leaders, and
the `document` handed over; `initial` adds who chose the incoming model and why, `handoff`
(R3-9) adds the context size that triggered it and the threshold, `fallback` (R4-7) hands
over no document and adds the refused calls (`refusals`: model, session, category and
explanation) and who chose the model, `runtime` for the fallback model or `answer` for the
one Mauria named; the mutation is always `unit.leader`, which routes the root unit's leader
on the initial transfer and a fallback and is a no-op on a handoff, so every transfer
replays the same way); Step 6 says what each carries. A `task.usage` written for a task
session the API refused carries the refusal, the model and the fallback it was retried on
(R4-7), so the refused call still counts against the budget; `task.completed` and
`task.failed` carry `model` and `fallbackFrom` when the task fell back, and a task refused
on both models fails with `refusals` listing both (`refused` is one refusal, on
`command.failed`, `leader.failed` and `task.usage`; `refusals` is a list, on `task.failed`,
`unit.reported` and `command.transferred`). `unit.reported` written by the runtime on
a leader's behalf, after two refusals, carries `writtenBy: "runtime"` and the `refusals`,
with a null session. `question.asked` and `incident.blocked` written for the IC's own
double refusal carry `icRefusals`, which holds the incident blocked until a transfer of
command follows. A
size-up that fails, or whose answer does not fit the schema, is `command.failed` with
`seat: "initial_ic"` and `turn: "size-up"`, with the session's usage and activity. A leader's assignment lands as
`plan.applied`, and a refused one as `plan.rejected`, with the actor `leader` and the unit
named, beside the planner's. Round 4 adds `plan.warned` (R4-6): one per warning the
validator raised on a plan it let through, with the rule, the reason and the plan's
rationale, written before the plan is applied; and `report.reviewed` (R4-2): one per
verdict on a command turn, with the report's event id, the unit, the verdict (`accepted`,
`revise` or `reassign`), the instructions, the why and the cycle, actor `ic`; it changes
no state itself, since an accepted or reassigned unit closes through `unit.closed` with
the verdict as its reason; and `unit.revised` (R4-3): one per revise verdict delivered,
written by the dispatcher in the transaction of the leader's turn that read the revision
brief, with the unit, its session and leader, the `report.reviewed` event's id
(`reviewedId`), the report's id, the instructions and the `revision` number; it changes
no state either, and a `unit.reported` that answers a revise carries `revision`, the
count of revise verdicts on the unit, so the report after the first revise is revision 1.
R4-4 adds `unit.reassigned`: one per reassign verdict, written by `applyCommand` after
the verdict's `report.reviewed` and before the unit's `unit.closed`, actor `ic`, with
`reassignmentId` (`<incident>-rNN`, numbered in the incident), the report's id, the
unit, its objective, the instructions, the why, `claims` (the ids of every claim the
unit's tasks produced), the cycle, and `dropped`, true when the instructions begin
`drop:`, which closes the reassignment as it is recorded; a reassigned unit's open tasks
are cancelled in the same transaction (`task.cancelled` with the rationale and the
`reassignmentId`), since `unit.close` sets status only. And `reassignment.taken`: one per
new unit whose proposal names a reassignment in `takes`, written by `applyPlan` after the
unit's `unit.created` and before `plan.applied`, with the reassignment's id, the new
unit's id and `fromUnitId`, the closed unit's. And `reassignment.dropped`: one per entry
of a command turn's `dropReassignments`, written by `applyCommand` in the turn's
transaction, actor `ic`, with the reassignment's id, the why and the cycle, which closes a
reassignment still open on a later turn. A reassignment is open while it is recorded, not
dropped (by its verdict or by a later turn) and not taken; none of the three events
changes state, and a replay reads the same set.

The file records its schema version in `user_version`. A file at an earlier version is
migrated in place when opened, one step at a time: version 1 (before `basis`) gives
verified claims `observed` and every other claim `inferred`, since a session claim with no
recorded basis is read the conservative way; version 2 (before `evidence_from_json`) gives
every task an empty `evidenceFrom`; version 3 (before leaders) renames a unit's `purpose` to
`objective` and gives it the legacy leader, `claude-code`/`claude-opus-5` (the planner was
then the only seat above a task), no equipment and no session, so `incident review` still
reads runs 001 and 002; version 4 (before strike teams) gives every task an empty
`strikeTeam`; version 5 (before the IC's turns) gives incidents `period_json`
and nulls every root unit's `session_id`, because a root session started under R3-4 keeps
that build's leader role text in its snapshotted system prompt (a resumed call keeps the
first call's system prompt), so the IC's first command turn starts a fresh session under
the IC's own role text; version 6 (before unit types, R4-10) gives every unit a `type`,
`ic` for the root and `base` for the rest, and a null `role`, and a `unit.create` recorded
before then replays the same way, so a round 4 file reads as before. A file at a later
version is refused.

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
| Claude Code built-in tool | Only inside a capability's session, named in that capability's equipment: `Read`, `Grep`, `Glob`, and `Bash` under an allowlist of read-only commands (`READ_ONLY_SESSION_COMMANDS` in `src/equipment/builtin.ts`: the in-process list `ls`, `cat`, `head`, `tail`, `wc`, `find`, `stat`, plus `grep`, `rg`, `diff`, `pwd`, `which`, `basename`, `dirname`, `realpath`, and the read-only git subcommands `git log`, `git status`, `git diff`, `git show`, `git blame`, `git ls-files`, `git rev-parse`, each a whole entry; `rg --pre` and the git subcommands' `--output` are accepted holes of the same class as `find -exec`, which print mode's write denial is expected but not verified to catch). A capability may instead declare `default` to give its session Claude Code's whole built-in set. |
| External | Only inside a session. An MCP server declared as equipment by name and launch command, passed to the provider with `--mcp-config` and `--strict-mcp-config`; or a provider integration named as equipment, which the provider turns on its own way. This is how Craft, GitHub, a browser or anything else with an MCP server becomes equipment without an adapter. Two browsers are registered (round 2, R2-7): `playwright_browser`, Playwright's MCP server launched headless with an in-memory profile; and `claude_in_chrome`, Mauria's own Chrome through Claude Code's Claude in Chrome integration (`--chrome`). A capability that declares several may name an input field (`equipmentSelect`) whose value picks the one to attach; `reproduce` picks by its `browser` input. The runtime's own equipment server, which would give a session function equipment, stays after v0. |

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
  session: { systemPrompt: INVESTIGATE_ROLE, bashAllowlist: READ_ONLY_SESSION_COMMANDS },
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
| `summarize` | The predicate of a capability's claims that are many and alike (grep's `matches`): the planner sees them in full only in the cycle after they land, then one line per task unless the IC's situation names them in `proven` or `keep`; the capability's other predicates, such as a verified absence, stay in full. |

A capability with a session adds the fields that define its setup. The session names a
provider, and the provider renders the fields onto its own command from them:

| Field | Claude Code renders it to | Codex renders it to |
|---|---|---|
| `provider` | The choice of column. | The choice of column. |
| session preamble, fixed in `providers/base.ts` | The first part of `--system-prompt`, identical for every session on every provider and every seat; the planner's call carries its own system prompt in place of it, since it is the Planning Section and not a seat in the organization. It orients the session: this is an agentic runtime modeled on the Incident Command System; an incident is any objective Mauria asks to have pursued, not necessarily something gone wrong; a temporary organization of units is built around it and torn down when it is done; the IC sets objectives and priorities, the planner drafts an action plan each operational period, the IC approves it, a validator checks its shape, and the units run their tasks under their leaders and report. Then the mapping of terms, one line each: incident, Incident Commander, initial IC, unit, unit leader, task, capability, equipment, subagent, strike team, task force, claim with its statuses and bases, situation report, action plan, operational period, planner, transfer of command, grant, budget, SOP. Then the confidence scale and the four kinds of lack. Then the seat's place, one paragraph chosen per seat (`Seat`: `task`, `leader`, `ic`, `initial_ic`): a task session is a resource assigned to one task inside one unit under its leader, reports only against the task's contract, cannot change the organization, and answers `insufficient` naming the kind of lack; a leader owns one unit's objective, runs a task on its own model and equipment as one of its turns, receives any other task's result, and after each task continues or reports; the IC is the root unit's leader and Mauria's delegate, sets each period's objectives and priorities, reviews the planner's draft, reads the reports and closes or reorganizes units, and runs no task in its session and takes no leader turn, a task under command reaching it as a result in its change report (R4-6); the initial IC is the first session on the incident, sizes it up with read-only tools, hands command over with a briefing and decides nothing that lasts. Then the role text: a capability's for a task session, `LEADER_ROLE` for a unit leader, `INITIAL_IC_ROLE` for the initial IC (in `src/size-up.ts`: size up, write the briefing on ICS 201's lines; a check is one look at whether a thing exists, answers or is where the objective says, and what the incident turns on is for the units to establish under the IC; route the commander by the judgment the incident needs; the objectives, units and questions follow from the objective's verb, so a diagnostic objective takes no fix objective, no fix unit and no intended-behavior question; ask Mauria only what no tool could find and the objective does not settle), `IC_ROLE` for the IC (it scopes, breaks down, equips and judges; its digging is assigned, and no task runs in its session; command files no report and its lacks go through the command turn; its first act on taking command from a briefing is to evaluate it, and nothing in a briefing binds it; a period ends when units report or the picture changes; it declares `satisfied` when the period objectives and the incident objective are met by the reports; a `not_met` report's why and suggestion are information for its decision and never a decision; a discrepancy it cannot reconcile from the file becomes a question for Mauria; the situation stays the planner's; one review, one redraft). The hierarchy around the session (its unit and leader, who it reports to, what is below it) is rendered from the tree into the brief at call time, not fixed in the prompt. | Prepended to the prompt, since `codex exec` has no system-prompt flag in its help. |
| `system_prompt` | The rest of `--system-prompt`: the capability's own role text, after the preamble. | Prepended to the prompt after the preamble. |
| `model` | `--model <id>`, always explicit, taken from the task. A capability declares no default. | `-m <model>`, same rule. |
| `equipment` | `--tools "<list>"` naming the Claude Code built-in tools in the capability's equipment, or `--tools default` when the capability declares `default`. | `-s read-only` bounds what the built-in shell can do; per-tool selection is not in the help and is an open item for this provider. |
| `bash_allowlist` | `--allowedTools` entries of the form `Bash(<command> *)`, so read-only tool calls need no approval. In print mode the allowlist is a floor, not the fence: Claude Code also permits commands it classifies as read-only whether or not they are listed, and denies writes and paths outside the working directory regardless of the list (Reference table, 2026-09-15), so the read-only effect policy holds in practice and the list does not bound reads to the named commands. | Covered by `-s read-only`; a finer allowlist is an open item. |
| `cwd`, `add_dirs` | The working directory and `--add-dir` entries. | `-C <dir>` and `--add-dir`. |
| `output_schema` | `--json-schema <schema>`, so the result comes back structured. Every session schema carries `outcome: answered \| insufficient`; an insufficient result carries `needed`, a list of what the session lacked, each tagged with its kind (a retrievable fact, permission, missing means, or a human's knowledge), and no claims. | `--output-schema <file>` with the same schema written to a temp file, and `-o <file>` to collect the final message. |
| `resume`, optional (round 3, R3-3) | `--resume <session id>`: the call continues that session for one more structured result, with this call's own prompt and `--json-schema`, and the envelope reports the session's unchanged id and this call's usage alone (verified 2026-09-15 on Claude Code 2.1.272; `spikes/round3/resume.sh` and the live test in `test/providers.test.ts`). A resumed call's usage covers the session's whole context, read from cache or written again: with a prefix over the model's minimum cacheable length the read happens in most runs and not all (Reference table, the usage-per-call row), and on Haiku 4.5 that minimum is 4096 tokens, above a bare session's context, so a short session's calls cache nothing at all. `systemPrompt` on a resumed call is ignored: Claude Code 2.1.272 defaults `--system-prompt-snapshot on`, which records the system prompt on the first request and reuses it on every resume even when a later launch passes different text, so a seat whose role text must change needs a fresh session. A resumed session is found under the project directory of its original `cwd`, so resume with the same `cwd` (unverified; the safe rule). Absent, a fresh session starts. A unit leader's session is what gets resumed (R3-4). | Open: `codex exec` has `resume` in its help, untested here. |
| `strike_team`, optional (round 3, R3-5) | `--agents <json>` defining each kind for this call alone, `{"<kind>": {"description": <why>, "prompt": <prompt>, "model": <model>, "tools": [...]}}` (honored on a `--resume` call; Reference table), with `Agent` added to `--tools` (already inside `default`) and to `--allowedTools`, so the session can send members and nothing else changes. The count and the why reach the session in its brief, not the definition. Absent or empty, no `--agents`, no `Agent`. The member's own transcript and `.meta.json` are read as Step 6 says. | Open: `codex exec` has no subagent definition in its help. |

Each provider has a fixed set of isolation flags, so no session inherits Mauria's personal
setup. Claude Code: `--output-format stream-json --verbose` (print mode refuses the stream
format without `--verbose`, verified 2026-09-15 on 2.1.272), `--setting-sources ""`,
`--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections`, which together drop
a session's context from about 40k tokens to about 3k and keep her CLAUDE.md, skills and
hooks out, and `--strict-mcp-config` on every session, with or without `--mcp-config`,
because without it the claude.ai connectors of her account (Craft, Gmail, Drive, Calendar)
loaded into a session's context under `--setting-sources ""` (seen 2026-09-15 on 2.1.272;
with the flag and no `--mcp-config` the init line's `mcp_servers` is empty, verified the
same day); `--bare` is not used because it authenticates only with an API key. Every session
also runs with `DISABLE_COMPACT=1` in its environment, so auto-compaction never rewrites a
session between the calls that resume it; a session that reaches the context limit errors
instead, and the IC's is handed off below the limit at the threshold Step 6 names (R3-9). The stream is one JSON line per
message, ending in the same `result` envelope `--output-format json` prints; the provider
reads the tool calls off it (Step 6) and parses the envelope as before. Sessions are
not made ephemeral: every planner and task session leaves its transcript under Claude Code's
project directory for the session's working directory (`<config dir>/projects/<directory
with every character outside A-Z, a-z and 0-9 as a dash>/<session id>.jsonl`, the config
dir `~/.claude` unless `CLAUDE_CONFIG_DIR` moves it; a subagent's transcript is
`<session id>/subagents/agent-<agent id>.jsonl` beside it with an `agent-<agent
id>.meta.json`), and the session id is on `plan.proposed`, on
`task.completed`, `task.failed` and `task.insufficient`, on every `tool.called` and
`subagent.ran`, and in every asserted claim's
provenance, so a run can
be read back call by call while the runtime is being refined (Mauria, 2026-09-13). Codex: `--ignore-user-config`,
`--ignore-rules`, `--ephemeral`, `--json`, verified present in `codex exec --help` on
2026-09-12 and not yet tested for context size or subscription billing. Permissions come only
from the capability's declaration; with the isolation flags, Mauria's own permission settings
do not load on either provider.

The user message is the brief: the incident's objective, the IC's situation's hypothesis
and proven list (R4-5), the hierarchy around the owning unit, then the task (objective, inputs,
expected output, completion criteria, evidence required, instructions), the strike team the
task declares if any (each kind, its shape and why, and how to send and cite a member),
then the claims and results the task names in `evidenceFrom`, attached by the runtime, and
one line saying what the unit that owns this task is trying to establish. A leader's first call opens with its
orientation (the incident objective, the IC's situation, the hierarchy, its unit's objective and
equipment; only the unit's own lines when the call is a task's brief, which carries the rest)
and every later call resumes the session with a task's brief or a turn: the last task's
ending, how many ready tasks remain, which runs next with the team it declares and how to
ask for one, and the ask, under the `LeaderTurn` schema.

v0 capabilities:

| Capability | Equipment | Session |
|---|---|---|
| `check_path` | `stat_path` | none; produces verified claims |
| `read` | `read_file` | none; produces verified claims |
| `grep` | `grep_files` | none; produces verified claims |
| `git_history` | `git_status`, `git_log` | none; produces verified claims |
| `investigate` | `Read`, `Grep`, `Glob`, `Bash` under the read-only allowlist | yes, model named per task; produces asserted claims with evidence |
| `interpret` | none | yes, model named per task; given evidence and nothing else, produces what it implies as asserted claims, or `insufficient` with what it would need |
| `reproduce` | `playwright_browser` or `claude_in_chrome`, whichever the task's `browser` input names | yes, model named per task; opens a page, performs steps in order and reports what it observed after each, as observed claims; settles a claim about runtime behavior that reading code cannot. Registered `read_only`: browsing a running app can change its data, so an incident that uses it names a scratch copy of the app's data in a constraint |

The four deterministic capabilities exist so a fact about the machine can be established
without spending a session on it, and so the planner can ask a precise question.

A capability may include other capabilities, composed in code. The event log records which
capabilities every incident used under which unit purposes; a composition that recurs across
incidents with the same shape is a candidate for a new capability, and one whose shape varies
with context stays with the planner. The quipu CLI's objective catalog is the first
planned set of such capabilities. v0 registers none.
### Step 4: the IC and the planner
The IC is the root unit's leader session (Step 6), resumed at the top of every cycle with
its briefing under the `CommandTurn` schema, and again with the planner's draft under the
`ReviewTurn` schema; its system prompt (the preamble, the IC's seat and `IC_ROLE`) is
fixed at its first call, so everything that changes goes in the user message. The briefing
is the change report since the IC last acted, then the incident file rendered as the
planner reads it, then the ask. The change report opens with every `picture.discrepancy`
raised since the IC's last turn, then every `unit.reported` (outcome, whether the picture
changed, what changed on which claims, and for `not_met` the why and suggestion), then,
when any task under command ended since, one block per task in the form of a report's
work (capability, objective, claims, then how it ended: a deterministic result's text
whole under the cap, since no leader reads the root's results and this block is the IC's
only view of them; a session result's summary, or what an insufficient result needed; a
failure's reason), because no leader reports on the root's tasks and the IC judges them
here (R4-6; the tasks listed are those ended since the IC's last accepted command turn,
the reports' window, so a rejected turn drops none of them from the retry), then every
question answered and capability provided, the rules the IC's last turn failed if it was
rejected, and the spend since then (every usage any seat recorded after the IC's last
turn, summed). The reports listed are every `unit.reported` since the IC's last accepted
command turn, the reports its verdicts must answer (R4-2), so a report a rejected turn
left unanswered is listed again for the retry; a unit's earlier report in that window is
marked `[an earlier report this window; the verdict answers report <id>]`. Each report is
headed by its unit's id and the report's event id, the id a verdict answers it by, and carries the work behind it (R4-1), so the IC judges the
leader's account against what the unit did: the unit's tasks that ended since its previous
report (id, capability and model, objective; then the claims the task produced, id,
subject, predicate, basis and confidence, never the object, which the file's claims
section carries clipped, a deterministic task's claims past the first three by id only;
then how it ended and what it came to: a session result's outcome and summary, or its
conclusion or observation count when the findings carry no summary, cut at 300 characters
since the file carries the findings, or what an insufficient result needed; a
deterministic result's size in lines of JSON; a failure's reason), and the unit's tool
calls in that window by tool name with counts, the tasks' and the leader's own turns'.
Each task's block, under a report or under command, is clipped at
`NOSCOPE_REPORT_WORK_CHARS` characters (default 1,500)
with the task id as the pointer to the full record, the claims placed before the ending
so the cap falls on a summary's tail and never on the claims, so a report adds a bounded
amount to the IC's context and the handoff threshold stays meaningful. The IC's first
briefing on an incident says so. When a transfer of command
is pending, the briefing carries the transfer's document after the change report: for the
initial transfer (R3-8) every line of the incident briefing, who wrote it on what model,
and how the IC's own model was chosen; for a handoff (R3-9) the outgoing IC's document
rendered section by section, with whom it takes command from, under the same role text, at
what context. An initial transfer names no incoming session and is pending while it is
later than the last accepted `command.turned` (a rejected turn does not count, as it does
not for `cycleOf`, so the retry of a rejected first turn still evaluates); a handoff names
its incoming session, is written with that session's `leader.started` after the turn that
recorded its first call, and is pending until an accepted command turn, or a review that
carried a `briefingEvaluation`, has run on that session, so the successor evaluates the
document once, on whichever call was its first, and a review that skipped the optional
field leaves the next command turn to evaluate under the schema that requires it; a handoff in flight, whose transfer is not written yet, is rendered the same way from
the runtime's hand. The ask then opens with the evaluation instruction (for a briefing,
each initial objective and each unit sketched; for a handoff document, each period
objective and priority, each unit's state, the hypothesis, each thing set aside and the
next move), and the turn is taken under `FirstCommandTurn`, the command turn with
`briefingEvaluation` required (one strict object, like every turn schema), so the
provider's own validation holds the IC to judging what it was handed before it sets the
period; a review that is the successor's first call carries the same `briefingEvaluation`
as an optional field of `ReviewTurn` and `FinalReviewTurn`, asked for the same way and
recorded on `plan.reviewed`. An incident with no pending transfer (`--no-size-up`, a failed
size-up, one migrated from before R3-8, or any turn after the evaluation was accepted) gets
the plain ask and the plain schema. The instruction lives in the user message because a
resumed call ignores `systemPrompt`; the IC's role text carries the general rule.

```ts
const CommandTurn = z.object({
  briefingEvaluation: z.array(BriefingVerdict).optional(),  // item, verdict (accepted | rewritten | discarded), why: each initial objective and unit sketched in the briefing the IC took command with; required on the first turn after a transfer (FirstCommandTurn)
  periodObjectives: z.array(z.string()).min(1),  // what this period must establish, from the incident objective, the constraints, the priorities and the reports
  priorities: z.array(z.string()),               // the incident's, restated or revised
  reportVerdicts: z.array(ReportVerdict),        // reportId (the report's event id, as the change report heads it), unitId, verdict (accepted | revise | reassign), instructions, why: one per unit that reported, naming its last report the change report lists (R4-2); instructions required for revise and reassign and empty for accepted, enforced by a refinement after parse
  situation: Situation,                          // R4-5: changed, hypothesis, proven (claim id and one line each), inferred (claim id and what settles it: a task or reproduce task by an open task's id or the ref the plan is to give it, or deferred with a why), keep (claim ids); the picture every seat works from this period
  closeUnits: z.array(UnitClose),                // units closed without a report; a reported unit is closed by its verdict, never here as well
  dropReassignments: z.array({ id, why }).optional(),  // R4-4: open reassignments the IC drops on a later turn rather than have a plan take; each must be open (Drops match)
  answers: z.array(ResourceAnswer).default([]),  // unit, request, answer: resource requests from units the IC can answer itself (the requests arrive with R3-6; the answers ride on command.turned until then)
  assignTasks: z.array(TaskProposal).default([]), // R4-6: deterministic tasks under command (grep, read, check_path, git_history), each naming the root as its unit; run in this cycle's pass, results in the next change report; a session task here is refused
  questionsForHuman: z.array(z.string()),
  capabilityRequests: z.array(CapabilityRequest),
  grantRequests: z.array(GrantRequest),
  incidentStatus: z.enum(["continue", "blocked", "satisfied", "failed"]),
  rationale: z.string(),
  discrepancy: z.string().optional(),
});

const IncidentBriefing = z.object({                 // the initial IC's size-up (R3-8), on ICS 201's lines; one strict object
  kind: z.string(),                                 // what sort of incident this is
  dominantProblem: z.string(),
  obviouslyNeeded: z.array(z.object({ what: z.string(), checked: z.boolean(), finding: z.string().optional() })),  // finding required when checked
  initialObjectives: z.array(z.string()).min(1),    // scoped to the objective's verb (R4-8): no fix objective on a diagnosis
  initialOrganization: z.array(z.string()),         // units sketched, one line each, with the leader's model; no fix unit on a diagnosis
  questionsForHuman: z.array(z.string()),           // only what no tool could find and the objective does not settle; each blocks the incident before the IC starts
  hazards: z.array(z.string()),
  incomingCommander: z.object({ provider: z.string(), model: z.string(), why: z.string() }),  // checked against the provider's models; --ic-model overrides, the default stands in
});

const ReviewTurn = z.object({
  verdict: z.enum(["approve", "correct", "amend"]),  // after a redraft: approve | amend (FinalReviewTurn), so a cycle has at most two planner calls and two IC reads
  corrections: z.string().optional(),               // with correct: text the planner redrafts against, once
  plan: ActionPlan.optional(),                      // with amend: the whole plan as the IC wants it applied
  rationale: z.string(),
  discrepancy: z.string().optional(),
  briefingEvaluation: z.array(BriefingVerdict).optional(),  // only on a review that is the session's first call after a handoff: each item of the handoff document, accepted, rewritten or discarded, and why
});

const HandoffDocument = z.strictObject({           // the outgoing IC's last call at a handoff (Step 6), written for its successor
  period: { objectives: z.array(z.string()), priorities: z.array(z.string()), why: z.string() },  // the period as set and why it is what it is
  units: z.array({ unitId, state, waitsOn: z.string().optional() }),  // every unit's state and what it waits on
  hypothesis: { statement: z.string(), claims: z.array(z.string()) },  // the reading of the incident and the claim ids it rests on
  setAside: z.array({ what, why }),                 // what was not pursued and why, so the successor does not reopen it unknowingly
  nextMove: z.string(),                             // the move intended next
});
```

The IC reviews a unit's work when its report comes in (ruled by Mauria, 2026-09-15; R4-2):
every unit whose report the change report lists is answered with one verdict in
`reportVerdicts`, naming the unit and the event id of its last report in the window. A
unit can file two reports in one pass under parallel dispatch (R4-9): its leader's, then
the runtime's `not_met` when a later task of its is refused twice; the IC decides on the
last, `report.reviewed` carries that report's id, and the earlier report is listed for
the record and takes no verdict of its own. `accepted` means the work shows the unit's
objective met, resting on observed claims, and the unit closes through the same path as
`closeUnits`, the verdict as the reason; `revise` means the same unit is placed to finish
it, the instructions say what is missing, and the unit stays active, the dispatcher
delivering the instructions to its leader as a revision brief at the start of the next
pass (R4-3; Step 6); `reassign` means a different shape of
unit would do better, the instructions carry what this unit found and did not find, and
the unit closes with its open tasks cancelled, its session demobilized on the close, and
a reassignment recorded (R4-4): the instructions, the closed unit's id and objective, and
its claims by id, which the IC writes into the slice it concerns in its situation and whose
id the planner's section 10 lists under the situation while it is open (R4-5), and which
the next plan must give to a new unit that names it in `takes`, or which the IC drops by beginning the
instructions with `drop:`, closing it as it is recorded, or drops on a later turn in
`dropReassignments` with the id and a why (`reassignment.dropped`); the taking unit's
leader is oriented with the instructions and the claims (Step 6). A
report's outcome is the leader's opinion; the verdict is the IC's, from the work shown, so
a `met` report may be revised and a `not_met` one accepted. The report the runtime writes
for a unit refused twice (R4-7; `writtenBy: "runtime"`, `not_met`, the unit left active)
is listed and takes a verdict like any leader's: `accepted` or `reassign` closes the unit,
`revise` leaves it active with no session, and the brief opens a fresh session. Command files no
report (R4-6), so no verdict is owed for it. Each verdict is recorded as `report.reviewed` with the report id, the unit, the
verdict, the instructions and the why, actor `ic`; `incident review` counts verdicts by
kind for the incident and per unit and lists each with its why, and `incident tree` marks
each unit's last verdict beside its last report.

A command turn is held to the validator's rules that cover what it can do (Units exist,
Closing is clean, Status is earned, and the task rules on its assignments; Step 5), with
the units its verdicts close folded into the closes checked, and to its own rules (Answers
match, Reports answered, Deterministic only, Drops match, Situation grounded), and applied as a plan is: `command.turned`
with the turn, its situation on it (R4-5: the one every seat reads until the next accepted turn; a rejected turn's is skipped), the call's session, model and usage, and the period as its mutation, then
one `report.reviewed` per verdict, one `unit.reassigned` per reassign verdict and one
`reassignment.dropped` per drop (R4-4), units closed, by `closeUnits` and by verdict, a reassigned unit's open tasks cancelled,
questions and requests recorded, the incident's status set, the tasks it assigns under command
created with `plan.applied` by the actor `ic` naming the root unit, its session and the
task ids (R4-6: deterministic tasks belong to whichever leader assigns them, command
included, ruled 2026-09-14; with no leader turn on the root the IC assigns them here, and
they run in this cycle's pass as the root's tasks; one that depends on a unit's task runs
in the pass after that task completes, since the root runs first in tree order and is done
for the pass once its ready tasks have run). The planner's and `incident review`'s cycle
windows open at the plan's `plan.applied`, never at the IC's or a leader's. A turn that
fails a rule is recorded as `command.turned` with `rejected` and one `command.rejected`
per rule, the cycle ends, and the next briefing names the rules. When the turn's status is
not `continue` the cycle ends after it: the incident is `blocked` on what the IC raised,
or closed `satisfied` or `failed` with the turn's rationale. Otherwise the planner drafts
the tactics against the period and the situation, as a suggestion for the IC (ruled by
Mauria in review, 2026-09-15).

The planner is one stateless call per draft, through a provider, as a headless Claude Code call on the subscription, with `--json-schema` so the
response is a validated `ActionPlan` and never prose. Model `claude-opus-5`, no tools,
the same four fixed flags as every session. Tested 2026-09-12 with an
planner-shaped prompt: 3.6k tokens of context and a valid action plan back.
Input, rendered as labeled sections in a stable order so the prefix caches:

1. The incident file's command picture: objective, constraints, priorities (Mauria's), the current operational period's number, objectives and priorities as the IC set them, budget remaining, grants given, questions still unanswered.
2. Claims, each line showing its status and basis and its provenance. A claim with the predicate its capability declares as `summarize` (grep's `matches`, in v0) appears in full only in the cycle after it lands, or when the last situation names it in `proven` or `keep`; the rest of its task's claims collapse to one line per task: the inputs, the claim count, and the files with counts.
3. The current unit tree with each unit's objective, status, leader model, last report outcome and the IC's last verdict on it (R4-2).
4. Tasks completed since the last cycle, each against its contract, with a session's findings (summary, observations, conclusion, reasoning) in full and a deterministic result clipped.
5. Tasks that came back `insufficient`, each with what the session said it needed.
6. Unit reports since the last cycle: each unit's outcome, whether the picture changed, what changed on which claims, and for `not_met` the why and suggestion.
7. Open tasks.
8. The capability registry, each with its description and the input fields a task to it must carry (name, type, required or default), and for each provider every model it serves with its cost, so every option is on the table and no task is proposed with inputs the capability cannot take.
9. The rules the validator will apply, so the planner does not propose what will be rejected.
10. The IC's situation (R4-5), from its last accepted command turn: what changed, the hypothesis, the observed claims it rests on, the inferred links with what settles each (a task, or deferred with the why), and the claims to keep in view; "(none)" before the IC's first turn. It ends with the ids of the reassignments still open (R4-4), each with the unit it came from: the IC wrote each into the slice it concerns, and every one is taken by a new unit in this plan naming it in `takes` (the rule "Reassignments taken", Step 5); "(none)" until the IC reassigns. Placed last because the provider caches the unchanged front of a prompt and this section changes every cycle.

Output:

```ts
const ActionPlan = z.strictObject({
  createUnits: z.array(UnitProposal),            // objective, parent unit, leader (provider, model), equipment, bashAllowlist, takes (optional: the id of an open reassignment this unit takes, R4-4)
  closeUnits: z.array(UnitClose),                // unit id, with a reason each
  createTasks: z.array(TaskProposal),// ref, unit, capability, objective, inputs, criteria, dependsOn (task ids or refs in this plan), evidenceFrom (claims by id, tasks by id or ref), instructions, provider, model, strikeTeam (optional: kinds the leader may send, each kind, model, tools, prompt, count, why)
  cancelTasks: z.array(z.string()),
  incidentStatus: z.enum(["continue", "blocked", "satisfied", "failed"]),
  questionsForHuman: z.array(z.string()),        // things only Mauria can supply; sets incidentStatus to blocked
  grantRequests: z.array(GrantRequest),          // capability, effect, and the reason it is needed; after v0
  capabilityRequests: z.array(CapabilityRequest), // means the planner lacks: what it would need and why; blocks the incident
  applySops: z.array(SopApplication), // SOP name, parent unit, the angles chosen; after v0
  rationale: z.string(),                         // why this plan and how it works the IC's situation; recorded on the action plan event, never acted on
  discrepancy: z.string().optional(),            // only when the file describes a different problem from the one planned, not a different detail; recorded as picture.discrepancy
});
```

Every turn schema in round 3 (`LeaderTurn`, `ActionPlan`, and R3-7's `CommandTurn` and
`ReviewTurn`) carries the same optional `discrepancy`: the seat says the update it received
describes a different problem from the one it has been working (it believed it was fighting
a fire and the update describes a hurricane), and what differs. The runtime records
`picture.discrepancy` with the seat and, for a leader, its unit and the task in flight;
`step`, `incident show` and `incident review` print it, and the IC's change report opens
with it. Every seat's role text bounds it to a real difference in what the problem is,
never a disagreement over a detail; a discrepancy the IC cannot reconcile from the file
becomes a question for Mauria in its command turn.

`LeaderTurn` also carries an optional `requestStrikeTeam` (R3-5): the same shape a task's
`strikeTeam` entry has, which the runtime holds to the strike team's three validator rules
against the task that runs next in the unit and, accepted, declares on that task
(`strike_team.defined` with the mutation `task.strikeTeam`, a kind the task already declares
replaced by name), so the leader's next call for that task defines the kinds; refused, or
asked when no task remains to send it on, `strike_team.rejected` keeps the request and the
reasons. The turn prompt names the task that runs next, the team it already declares, and
how to ask.

The planner proposes structure: the tactics for the period, drafted as a suggestion for
the IC against the situation the IC wrote (R4-5; until then the planner wrote the situation
into each plan and read it back the next cycle). It never runs a tool, never writes to the
store, and never marks its own conclusions true. Its rationale says how the plan works the
situation and names the priority that chose between the plans it could have drafted.

The IC reviews each draft once. `approve` applies the draft as drafted. `correct` sends the
corrections to the planner, whose input is the same file with its draft and the corrections
appended after section 10 (last, so the file's prefix still caches), and the redraft comes
back to the IC under `FinalReviewTurn`, which cannot say `correct` again. `amend` applies
the plan the IC returned in place of the draft. `plan.proposed` is recorded per draft, the
redraft marked with its corrections; `plan.reviewed` per read with the verdict, the
corrections or the amended plan, and the call's usage; `plan.applied` carries the final
verdict, the corrections, and `diff`, how the applied plan differs from the planner's first
draft: each array field of the plan compared as a set of items under a key-sorted JSON
serialization (a reordered item is no change, an edited one is removed and added), and the
other fields (`incidentStatus`, `rationale`, `discrepancy`) named in `changed`
when they differ; empty when the draft was approved as drafted. `incident review` counts
verdicts by kind, which is the evidence for cutting the planner if the IC never changes its
draft.

No seat is without a way to get what it lacks, and each kind of lack has its own channel.
A lack is resolved by the nearest seat that can (ruled 2026-09-15, R3-6): a task's
`insufficient` goes to its unit's leader, never to the planner, and the leader resolves a
retrievable fact itself and sends the other three kinds up; the IC, leader of command,
takes no leader turn (R4-6), so every kind it lacks goes through its command turn: a
retrievable fact as a deterministic task it assigns under command (`assignTasks`) or as a
period objective for the planner to task, the other three as the question, capability
request and grant request the turn carries; command never waits.

| The lack | The IC's and the planner's channel | Who resolves it for them | At a unit's leader |
|---|---|---|---|
| A fact a registered capability can retrieve, from the machine or anything its equipment reaches. | A task. | The runtime, next cycle. | The leader itself: `assignTasks` on its turn, tasks under its own unit to capabilities the unit holds, inside the unit's share, checked by the validator (Step 5) and run in this pass on a continue, next pass on a report. |
| Permission for a capability that writes. | A grant request. | Mauria, with `incident grant`. After v0. | A `permission` resource request on the leader's report, recorded as `grant.requested` naming the unit; the unit waits until a grant exists, which is after v0, as the planner's request holds the incident. In v0 nothing answers it, so a unit that raised one stays `waiting` after its other requests are answered, until a plan closes it. |
| The means: equipment or a capability that does not exist yet, stated as what it would need and why. | A capability request. | Mauria, by registering it and answering the request with `incident provide`, which returns the incident to `open` once nothing else waits; after v0 the planner itself when the missing equipment is an external MCP server it can declare. A capability request is also the runtime telling her what to build next. | A `missing_means` resource request on the report, recorded as a capability request naming the unit; `incident provide` answers it and returns the unit to `active` once nothing of the unit's is open. |
| Something only a human knows or may decide. | A question for a human. | Mauria, with `incident answer`. | A `human_knowledge` resource request on the report, recorded as a question naming the unit; `incident answer` answers it and returns the unit to `active` once nothing of the unit's is open. |

The incident goes to `blocked` only when a command turn or a plan raises one of the last
three; a leader's resource request puts its unit in `waiting` and leaves the incident where
it was, so the other units keep running. Such a report is `pictureChanged` whatever the
leader said, so it ends the pass and the IC sees the unit waiting before anything new
starts: the change report at the top of its briefing lists what each waiting unit asks, with
the text an `answers` entry names it by, and the IC answers what it can itself (a
`human_knowledge` or `missing_means` request it can settle from the file) while the rest
wait for Mauria; an answer must name a waiting unit and an open request it raised. `incident
show` prints the planner's and the units' requests, and every session is told the same four
kinds in its preamble so that an `insufficient` answer names which one it hit. The planner's
section 5 lists an insufficient task's needs other than retrievable facts; section 3 shows
a waiting unit with what it waits on, and section 6 a report's resource requests.
### Step 5: the validator
Every action plan passes all of these or is rejected whole, with each failing rule and its
reason recorded as a `plan.rejected` event and fed back as input 9 on the next cycle:

| Rule | Check |
|---|---|
| Capabilities exist | Every task names a registered capability. |
| Units exist | Every task's unit and every new unit's parent is an active unit, or a unit created in this plan; a closed unit takes no new work. A `closeUnits` entry names a unit in the incident. |
| Type exists | Every new unit names a registered unit type a plan may create (R4-10): `base`, the led unit, is the only one, and the field's default, so a plan that names none passes; a type the registry lacks, or `ic` (the runtime creates command with the incident), is refused with the types a plan may create. |
| No cycles | The tree stays a tree: no new unit is its own ancestor, and a ref is used once, is not an existing unit id, and does not start with the incident id, so it cannot be mistaken for the id a unit created in the same plan receives. A task ref is held to the same three tests against task ids, and the new tasks' `dependsOn` form no cycle among themselves. |
| No duplicates | No new task repeats an open or completed one, or another new task in the same plan, with the same capability and effective inputs (as the capability's schema parses them) under the same unit. A task the plan cancels does not count. |
| Inputs validate | Task inputs parse against the capability's input schema. A task that takes evidence carries some: inline in its inputs, or by reference in `evidenceFrom`. |
| Span of control | No unit ends the action plan with more than 7 direct children, units and tasks combined. Target is 5. |
| Effect policy | v0 rejects any capability whose effect is not `read_only`. A new unit's equipment names built-in tools, `default`, or registered external equipment, and its Bash allowlist only entries from the session command list in Step 3, which the planner's rule text names so a plan is never drafted outside it, so a leader's session is read-only like a task's. A strike team's `tools` name only the read-only built-ins (`Read`, `Grep`, `Glob`, `Bash`): no `Edit` or `Write` until grants exist. That a member's `Bash` is held to the parent session's `--allowedTools` allowlist is inferred from Claude Code applying permission rules session-wide, not tested on 2.1.272. After v0, a task to a capability whose effect is `writes_local` or `writes_external` passes only with a grant on this incident for that capability. |
| Budget respected | A task's budget, where it sets one, fits inside the incident's remaining budget. A session-backed task carries a time bound and, when the incident bounds tokens, a token bound. A deterministic task runs no model and needs neither. A strike team's `count` times the least a member spends (`STRIKE_MEMBER_MIN_TOKENS`, 600: the fixture's `pinger` with no tools read 672) fits the task's token bound where it sets one; a task with no token bound has nothing for the count to exceed. |
| Dependencies resolve | Every `dependsOn` names a task in the incident that is completed or still open and not cancelled in this plan, or the ref of a task created in this plan, so the new task can become ready. Every `evidenceFrom` claim exists, and every `evidenceFrom` task is completed or in the task's `dependsOn`, so its result exists when the brief is built. Every `cancelTasks` entry names an open task, once. |
| Model known | Every task to a session-backed capability, and every new unit's leader, names a provider and model pair. The known list is every model the provider serves, never a curated subset, so Mauria can ask for whatever she wants and the planner sees every option. For Claude Code the known list is every Anthropic model currently served: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`; Codex pairs are added when that provider is tested. A task to a deterministic capability has no model field at all, since nothing in it runs a model. A strike team's `model` is one the task's provider serves, and a team on a task that runs no session is refused here, since there is no session to send it from. These three rules, and nothing else, are what a strike team is held to, whether the plan declares it or a leader requests it (the same checks run on a leader's `requestStrikeTeam`, outside a plan). |
| Closing is clean | A unit closed in this plan is active, is not command (a unit of the `ic` type is never closed), has no running task after the plan's cancels, is closed once, and is given no new unit or task in the same plan. Demobilization is clean too: a unit whose leader has a session closes only after the leader has reported since the unit's last task ended (`unit.reported` after the last `task.completed` or `task.failed` under it); a unit whose leader never ran closes freely. A revision is delivered first (R4-3, added in review by the orchestrator, 2026-09-15): a plan may not close a unit whose last `revise` verdict has no `unit.revised` after it, since the plan drafted in the verdict's cycle would otherwise close the unit before its leader read the brief; the IC's own `closeUnits` is not held to this, since the close is the IC's decision and its verdict on the runtime's report for a unit whose brief was refused twice must be able to close the unit. |
| Status is earned | `satisfied` requires every open task completed or cancelled, no new tasks in the plan, and at least one claim with basis `observed`, whichever source produced it. `satisfied` or `failed` raises no question, capability request or grant request, since a closed incident answers none. `blocked` raises at least one, since nothing else could unblock it. |
| Inferred links are worked | Every inferred link in the IC's situation (R4-5: the one on its last accepted command turn, this cycle's) is settled by this plan: the task the link names is a task in this plan by its ref or an open task by its id, not cancelled in this plan (a reproduce task by its ref or id likewise), or the IC deferred the link with a why. A link left neither worked nor deferred rejects the plan, so a deferral is a decision the IC records, never an omission. The claims the situation names are the command turn's to answer for (Situation grounded, below). Checked on plans only. |
| Reassignments taken | Every open reassignment (recorded by a reassign verdict, not dropped, taken by no unit; R4-4) is named in the `takes` of exactly one unit created in this plan; a `takes` names an open reassignment, and no reassignment is taken twice. A reassignment whose verdict began its instructions with `drop:`, or that a later command turn dropped, is closed and takes nothing. A plan whose `incidentStatus` is `failed` is exempt, since a failing incident owes no taker; a `satisfied` plan is held to it, since the IC said the slice needed a different unit. Checked on plans only: a command turn creates no unit, and a leader's assignments create none. |

A plan the rules pass may still draw a warning (R4-6): the validator's verdict carries
`warnings`, each recorded as `plan.warned` with its rule, reason and the plan's rationale
in the transaction that would have recorded a rejection, printed by `step` after "plan
approved", and read by the planner in section 9 under "warned last cycle" beside the
warning's text under "warned on, and applied anyway". A warning never rejects: the plan is
applied as it stands. One warning exists:

| Warning | Check |
|---|---|
| Session work under a unit | A task to a session-backed capability placed under the root, `command`. It runs in a session of its own with no leader turn after it (Step 6), so the IC judges its result from the change report instead of a leader's report; session work belongs under a unit with a leader. A deterministic task under command draws nothing. Told, not refused, because the work still runs and run 003 showed a rejection reshaping the organization (the planner traded its unit for a plan that could not be rejected). |

The IC's command turn is checked by the same code as a plan that creates nothing, under
Units exist, Closing is clean and Status is earned, since closing units and setting the
status is all it does to the tree, with the units its verdicts close (accepted or
reassigned) folded into the closes those rules check, and its `assignTasks` (R4-6) as a
plan creating those tasks under the task rules a leader's assignments pass, plus the ic
type's own rule, Own unit, against command; and by five rules of its own:

| Rule | Check |
|---|---|
| Answers match | Every answer names a waiting unit and an open request that unit raised, as the change report showed it, and no request is answered twice; a permission request is not answered here, since only a grant answers it. |
| Reports answered | Every unit that reported since the IC's last accepted command turn has exactly one verdict, naming the unit and the event id of its last report in that window; no verdict names a report outside that window, a unit's earlier report in it, or another unit's report; and no reported unit is in `closeUnits` as well: an accepted or reassigned unit is closed by its verdict, and a revised unit stays (R4-2). Command files no report (R4-6), so every report in the window is a unit's, the runtime-authored report of a refused unit (R4-7) included. |
| Deterministic only | A task to a session-backed capability is refused with "the IC assigns deterministic work only, and session work goes under a unit", since the root's tasks run with no leader turn (Step 6) and session work is a unit's (R4-6). |
| Drops match | Every entry of `dropReassignments` names an open reassignment (recorded, not dropped, not taken), and none is dropped twice (R4-4). |
| Situation grounded | Every claim id the turn's situation names, in `proven`, `inferred` and `keep`, is a claim in the incident, and every `proven` claim has basis `observed`, whichever task observed it: a session's observation counts, an inference from either source does not (R4-5; the checks the plan's situation passed under Dependencies resolve until then). What settles each inferred link is the plan's to answer, under Inferred links are worked. |

A failing rule is recorded as `command.rejected` and the cycle ends there (Step 4).

A leader's assignments (`assignTasks` on a `LeaderTurn`, R3-6) pass the rules above that
read tasks (Capabilities exist, Units exist, No cycles, No duplicates, Inputs validate, Span
of control, Effect policy, Budget respected, Dependencies resolve, Model known) as a plan
creating those tasks and nothing else would, and the rules of its unit's type (R4-10: a
protocol carries its rules, each the line the role text lists with its check beside it,
`AssignmentRule` in `src/units/registry.ts`; the base protocol's three are below, and the
ic protocol holds Own unit alone), or are refused whole with `plan.rejected` per failing
rule, the actor `leader` and the unit named, which the leader's next turn reads:

| Rule | Check |
|---|---|
| Own unit | Every task the leader assigns names its own unit; a leader creates no unit and assigns under no other. Every type's rule (`OWN_UNIT_RULE`). |
| Capability held | Every task names a registered capability; a session-backed one needs no equipment or Bash command beyond the unit's (`default` covers every built-in), and one that picks its equipment per task picks equipment the unit holds. A deterministic capability is always held, since it composes in-process equipment and needs no session tool. |
| Budget within share | A unit's budget is what the plans allotted its tasks, per dimension; charged against it is what the unit's ended tasks spent and what its open tasks are bound to, the leader's earlier assignments included. The assignments' bounds fit inside the difference. A dimension no plan task under the unit bounds is a share of zero (ruled 2026-09-15): an assignment may not bound it, so a leader under only unbounded deterministic tasks assigns only unbounded deterministic tasks, never a session task bounded by the incident's budget alone. |

### Step 6: dispatch, record, verify
Ready means every dependency is completed. Dispatch runs the units to their reports, each
under its leader (round 3, R3-4), and runs unrelated units at once (round 4, R4-9): two
units are related when a task of one that has not ended names, in `dependsOn`, a task of
the other that has not ended, either way round, and related units run one at a time in
tree order (parents before children, siblings as created), as every unit did before R4-9; a
parent and a child are related only through their tasks. A unit's pass starts when the
unit has something to do (a resumed leader to brief, a runnable task, a report owed), no
unit related to it is mid-pass, and fewer than `NOSCOPE_PARALLEL` passes are running (a
positive whole number read from the command's environment, 3 when unset, refused
otherwise); the cap bounds unit passes, and the tasks inside a unit are bounded by the plan.
The turns a unit takes in its pass are its type's protocol's (round 4, R4-10): the
dispatcher owns the scheduling, the starts, the landings, the budget and the halt, and
asks each unit's protocol at three points, `open` before any task starts, `ending` on each
landing, and `close` once every run has landed, each answering with the unit as it now
stands, the report it filed if any, whether the unit is done for the pass and whether the
picture changed; the dispatcher also asks the protocol whether a task runs inside the
unit's session and, when it does, for the request to run it with. What follows in this
step is the base protocol (`src/units/base.ts`), the led unit's. Under the ic protocol
(`src/units/ic.ts`, R4-6) command takes no turn at all: its runnable tasks run with no
turn between, a deterministic one in process and a session-backed one in a session of its
own, never inside the IC's session, whatever its model and equipment (its `runsInside` is
false), and so every runnable root task starts at once; its pass ends without a report
once its ready tasks have run, and the IC judges their results at its command turn, where
the change report lists them (Step 4). Run 003 is the reason: with every task under
`command`, the IC's own session took the investigate as an assignment and five leader
turns at 60k to 115k context cost $0.94. No `parentId === null` guard remains in the
dispatcher or the protocols: what the root does differently, it does as the `ic` type. A
unit's leader session is created when the unit first has a ready task:
its system prompt is the preamble, the seat's place and the leader role text, fixed for the
unit's life (a resumed call keeps the first call's system prompt), and its first user message
opens with the orientation: the incident, the period, the IC's situation (R4-5), the hierarchy and the
unit's own lines, and, for a unit that took a reassignment (R4-4, `reassignment.taken`
naming it), the reassignment's id, the closed unit and its objective, the report the IC
reviewed, the IC's instructions and why, and the closed unit's claims by id, each with its
subject, predicate, basis and confidence when the store has it, so the leader starts from
what was found; the same lines open a task's brief when the first call runs a task inside
the session. In a unit, every runnable task not yet attempted starts at
once: a task on the
leader's provider and model whose capability's equipment and Bash allowlist the unit already
holds runs inside the leader's session, as one resumed call whose prompt is the task's brief
and whose schema is the capability's output schema, and such tasks run one at a time, each
followed by the leader's turn on it, since the session takes one call at a time; any other
session task runs in a session of its own, each its own process, and a deterministic task
in process, and these start together the moment they are runnable, so `dependsOn` is what
serializes tasks and a task with none waits for nothing. Each task's ending reaches the
leader on a turn of its own under `LeaderTurn`, in the order the tasks ended, one call on
the session at a time (a turn waits for a task running inside the session): the turn
carries the ending (the result
rendered, or "recorded in this session", or the failure), how many ready tasks remain and
which runs next, and which tasks of the unit are still running in sessions of their own;
`continue` starts what the ending made runnable and what the leader assigned, `report`
files `unit.reported` and ends the unit's pass while its tasks in flight finish and land,
their endings kept for the leader's next turn, and
`pictureChanged: true` on a report ends the whole pass, which `dispatch` returns as the
unit's id, so the IC's next change report opens with it: from that moment nothing new
starts anywhere, and every run in flight finishes and lands, each task's leader hearing
its ending, before `dispatch` returns. A task's ending that came back
`insufficient` is rendered to the leader with what it needed, each with its kind, and what
the leader does about each kind (R3-6). Either move may carry `assignTasks`: after the turn
is recorded the assignments are validated (Step 5) and applied under the unit as
`plan.applied` with the actor `leader`, the unit and session named, and the task ids, and
the ready ones run in this pass on a continue and next pass on a report, which ends the
unit's pass; a refused assignment creates nothing and its reasons open the leader's next
prompt. A report may carry `resourceRequests` (`permission`,
`missing_means`, `human_knowledge`, each with what and why): it is forced `pictureChanged`,
each request is raised as Step 4 says, and the unit enters `waiting`; a waiting unit is
skipped by dispatch, keeps its pending tasks, and is not asked for a report. Command
never waits and never owes a report (its protocol files none), since it takes no leader
turn; the IC raises what it lacks in its command turn. The turn's
record, its assignments (validated first, while the unit is still active) and its requests
land in one transaction, so a crash can never leave a recorded report whose requests were
not raised. `unit.waiting` carries the unit, its session and the `requests` as the leader
gave them, with the mutation `unit.status`; `unit.resumed`, written by `incident answer` or
`incident provide`, or by the IC's command turn answering the request, when nothing of the
unit's is still open, carries the unit and the `questionId` or `need` that was answered,
with the same mutation. The next pass opens a
resumed unit with a turn carrying the answers to the requests of its last wait, before
running any task, so the leader reads them first. A unit whose report the IC sent back
(`revise`, R4-2) opens its next pass the same way (R4-3): its leader is resumed, or a
fresh session is oriented when the unit has none (its session released after a refusal,
or the report the runtime wrote for it), with the revision brief as the turn's cause,
before any task: the IC's instructions and why, the report the IC reviewed, the period
objectives and priorities the verdict's command turn set, and, when the unit resumed from
`waiting` at the same time, the answers to its requests on the same turn; the endings the
leader has not heard ride before it as on any first turn. The leader answers under
`LeaderTurn` as on any turn: it may assign tasks under its unit for what is missing and
continue, or report at once. `unit.revised` is written in that turn's transaction, before
the `unit.continued` or `unit.reported` it produced, so a pass that dies before the
leader answers delivers the brief again; a unit with an undelivered revise has work for
the pass even with no task. The unit's next report carries `revision`, the number of
revise verdicts the IC has given it, and a revise stays in the period the verdict opened,
since nothing else changed: the revised unit runs beside the plan's units in that
period's pass, and the IC answers the revised report with a verdict as any other. The IC
may revise again; each revision is numbered from the verdicts. A continue turn carries no
report, so a resource request rides only on a report. With nothing left to run and nothing running the
leader is asked for its report; with nothing left to start but tasks still running, or
landed and waiting for turns of their own, it is asked to continue and wait for them or
report now, and the turn names both sets; a leader that answers `continue` with nothing
left, nothing running and nothing left to hear ends the unit's pass without one. The
endings a leader has not heard (tasks that ended after its last turn: a pass that died, or
tasks that landed after it reported) ride on the first turn of its unit's next pass,
whatever that turn is for, rendered before it as each ending renders; a unit that owes a
report (a task ended after the last report) and has nothing to run is asked for it at the
start of the next pass even with no task, the turn creating the session if none exists,
so a result never goes unread by the leader whose next turn comes. The report the runtime
writes for a unit after two refusals (R4-7) is not a turn of the leader's and moves that
cutoff for nothing, so the endings it passed over ride on the leader's next real turn,
with a new task or the IC's revision brief (R4-3); until then the IC reads them in the
change report under that report. Every turn is one call on the leader's session, recorded as
`unit.reported` (with the report) or `unit.continued`, each with the unit, the session id,
the leader's provider and model and the call's usage; `leader.started` records the session
on the unit at its first call, with the `cwd` it was launched from, whether that call was a
task or a turn, and also when a task's first call failed with a session id; `unit.closed`
carries the session id as the leader's demobilization. A leader session that cannot be
resumed (the call dies before the stream's init line, as the binary does for a session it
cannot find) is replaced: a fresh session is oriented and asked the same turn, and its
`leader.started` names the dead session (`replaced`) and the reason. A call the API
refused outright is treated the same way, with a change of model (R3-10a, R4-7; the
Reference table has the observed fact): the provider takes a call as refused when the
stream carries Claude Code's `model_refusal_no_fallback` system line or a result whose
`stop_reason` is `refusal` (never from the synthetic assistant frame alone, which the
binary's own `model_refusal_fallback` routing delivers ahead of a successful result on its
fallback), reads the category from the system line under either spelling of its key, the
assistant frame's `stop_details`, or, when the stream names none, the session's transcript
under Claude Code's project directory, and throws a `SessionError` carrying the session id,
the refused call's usage and `refused` (the category and the API's explanation, `unstated`
only when no record names one); a refused
session stays refused on every later call, so a refused turn is filed (`leader.failed` for
a leader, `command.failed` for the IC, each with the refusal and the usage) and, when it
was resumed, the session is released through `leader.released` with the reason `refused:
<category>`. The retry is deterministic and happens once per seat, ruled by Mauria in
review on 2026-09-15: the replacement session runs on the fallback model,
`NOSCOPE_IC_FALLBACK_MODEL` (default `claude-opus-4-8`, read from the command's
environment, refused when the provider does not serve it), asked the same turn with its
full briefing (the IC's review re-briefs a fresh session before the draft, as after a
handoff). For the IC the change is a transfer of command, `command.transferred` of kind
`fallback` with the refusal as its reason and the outgoing and incoming models, and the
root unit's leader changes, so every later IC call stays on the fallback (the root takes
no leader turn, R4-6, so the IC's calls are the only ones command's seat makes). For a
unit leader the unit's leader
changes on the `leader.failed` that filed the refusal (`fallback`, the mutation
`unit.leader`), and the fresh session's `leader.started` names the refused session
(`replaced`) and `fallbackFrom`. For a task session the task itself is retried once, in its
own session on the fallback whatever the first call ran in, the refused call filed on the
task (`task.usage` with the refusal, its activity) and the retry's outcome carrying both
models; a first call refused inside the leader's resumed session releases that session
(`leader.released` with the reason `refused: <category>`), since a refused session is
refused on every later call, and the leader's next turn starts fresh on the unit's own
model. A refusal on the fallback, or a refusal after the fallback has been tried for that
seat (the IC's model was already changed once, a leader already moved, a task whose own
model is the fallback), goes to judgment and no seat retries beyond the one fallback; a
seat that already runs on the fallback model (`--ic-model claude-opus-4-8`, or a plan
naming Opus 4.8 as a unit's leader) has nothing to fall back to, so its first refusal
blocks or reports the same way: for a unit leader's or a unit's task session's refusals
the runtime writes the unit's report on the leader's behalf, `unit.reported` with the
actor `runtime` and `writtenBy: "runtime"`, `not_met` with both refusals as its why, the
IC's choices (another model, a different unit, drop the slice) as its suggestion, and
picture-changing, so the pass ends and the IC decides on it in its next command turn; a
task under command has no leader to report for it, so its refusals end as its
`task.failed` with the `refusals`, the pass goes on to command's next task, and the change
report lists the failure under the tasks under command for the IC to judge (R4-6); for
the IC's own refusals on both models the
incident is blocked on a question naming them (`question.asked` and `incident.blocked`
with `icRefusals`), `step` and `run` print the question and exit 0 as they do when a plan's
question blocks, and `incident answer` with a model name transfers command to that model
(`command.transferred` of kind `fallback`, chosen by `answer`) and reopens the incident,
while an answer naming no model the provider serves is stored, the question is asked again
and the incident stays blocked with a hint. A refused handoff call is released with the
reason and nothing handed off, as a lost outgoing session is, since a fresh session has
nothing to hand off; the fallback applies to the fresh session's first call if that is
refused. `incident show` lists every model change (each transfer of command with its
kind and reason, each leader moved to the fallback, each task retried on it), `incident
review` names them where they happened, lists every refusal per seat with its category,
model and session, and prices the refused call. A leader that cannot
answer otherwise (a failed session or an output that does not fit) ends the pass with an
error naming the unit, after the task's own events were written. A session task is bounded
by its request's timeout alone: the provider kills the process and files its calls under the
session id, so the leader's next call never finds its session still in use; the
dispatcher's own timer bounds deterministic tasks only. A leader's turns are not counted
against the incident's budget, as the planner's calls are not; `incident review` costs them
under the role `leader`. The budget is checked before every task starts. A task that does
not fit what is spent stops the pass with `budget.exceeded`, as in round 3; a task that
fits what is spent but not what is spent plus what the tasks in flight are held to (each
task's own bound, or its capability's typical cost) is deferred: its unit's pass waits for
the next landing anywhere and looks again, so concurrent starts cannot overrun the budget
together, and a reservation, which is a bound and not a spend, never stops an incident. A
stop prevents new starts and lets the runs in flight land.

A task's strike team (R3-5) is provided to whichever call runs the task: the leader's
resumed call when the task runs inside the leader, or the task's own session otherwise, as
the request's `strike_team`, which the provider defines for that call alone (Step 3) and
never on a turn. The brief says what the task declares (each kind, its shape and why, how
many to send), that a kind is sent by name through the session's agent tool, and that a
claim resting on a member's finding cites the member's `agentId` in its evidence, which is
what the agent tool's result shows the session (the fixture's `Agent` result carries
`agentId: <id>`, captured 2026-09-15). A leader's `requestStrikeTeam` on a `continue` turn
is checked and declared on the task that runs next, in the turn's transaction after
`unit.continued` (Step 4); on a `report` turn, or with no task left, it is refused as
asked with nothing to send it on (the reason says which). Since R4-9 the task that runs
next is one not yet started: one still waiting on a dependency, or one the leader assigns
on the same turn; a task with no dependency has started already. `strike_team.defined`
carries the task, the unit, who declared it (`plan`, written by `applyPlan` beside
`task.created`, or `leader`, with the session id and the mutation `task.strikeTeam`) and
the kinds; `strike_team.rejected`
carries the same and `reasons`, one per rule line. A member's run is the `subagent.ran`
the provider already files under the task, its `agentType` the kind's name, so review joins
declaration to run on task id and kind.

Each task's run, wherever it ran, writes `task.started`, then the result and
`task.completed` or `task.failed` in one transaction, with a `task.usage` event carrying
what the run spent, and every event keeps its own timestamp, so concurrent runs cost as
they did in sequence and `incident review` reports each cycle's wall time beside the sum
of its tasks' seconds (R4-9):
the whole input billed (the figure a token budget counts, summed by the envelope over every
API turn of the call) and its split into uncached, cache-write and cache-read tokens,
output tokens, seconds, `contextTokens`, the context of the call's last message (that
message's uncached, cache-write and cache-read tokens from the stream's last `assistant`
line: what the session's next call resumes from, and what the IC's handoff threshold is
compared against; absent when the stream carried no per-message usage), and the
provider's own cost at list price when it reports one (`total_cost_usd` in the Claude Code
envelope). The
planner's call records the same shape, and the model it ran on, on `plan.proposed`. A deterministic run spends no
tokens and costs nothing; a run that fails before the provider answers records no cost,
since none is known, and a spend summed with such an event in it carries no cost, so a
figure is never printed that a failed session would have raised. The spend `incident show`
prints, and a budget counts, is the tasks'; the planner's usage is recorded on
`plan.proposed`, the IC's on `command.turned`, `plan.reviewed` and `command.failed`, the
initial IC's on `incident.briefed` (or `command.failed` when the size-up failed), and
the leaders' on their
turns, none of them counted against the budget, a design call on the revisit list. The IC's
change report sums every usage recorded since its last turn, whichever seat spent it.

The IC is never compacted (R3-9): every session runs with `DISABLE_COMPACT=1` (Step 3), so
its context only grows, and the runtime hands command off before it reaches the limit
rather than letting Claude Code summarize the session behind the runtime's back. The
runtime reads the context of each IC call's last message from the usage it recorded
(`contextTokens` on `command.turned`, `plan.reviewed` or `command.failed`, whichever was
last, when it names the unit's current session; never the call's summed `inputTokens`,
which the envelope adds up over every API turn of the call, at least two for a structured
call and more for every tool call, so it runs at a multiple of the context; a call that
recorded no `contextTokens` never hands off) and, before the command turn and before
each review, when that figure has reached `NOSCOPE_IC_HANDOFF_TOKENS` (default 120,000,
below Claude Code's limit; read from the command's environment, refused when it is not a
positive whole number), runs a handoff: the outgoing session is resumed once under the
`HandoffDocument` schema (Step 4) with an ask tailored to the seat (why, who reads it, and
what a successor that is to act as the same IC with its context emptied needs: the period
objectives and priorities and why they are what they are, every unit's state and what it
waits on, the hypothesis and the claims it rests on, what was set aside and why, the next
intended move); the session is then released through the log, `leader.released` with the
mutation `unit.session` null, the outgoing session's provider, model and usage, the
context size, the threshold and the document; and the next IC call starts a fresh session
under the same `IC_ROLE` (nothing in the system prompt changes between the two), whose
user message carries the transfer after the change report (Step 4): that it takes command
from the session whose context reached the threshold, under the same role text, the
document rendered section by section, and then the full file; the ask opens with the
instruction to evaluate the document, the same evaluation the initial IC's briefing gets
(R3-8), answered in `briefingEvaluation`, required on the command turn
(`FirstCommandTurn`) and optional on a review that is the successor's first call. The
transfer is one event for both kinds, `command.transferred` written by one
`recordTransfer` with the root unit's leader as its mutation (`unit.leader`, a no-op on a
handoff, whose `outgoing` and `incoming` leaders are both the unit's): `kind: "handoff"`,
the unit, the outgoing and incoming session ids and leaders, the document, the context
size and the threshold. It is written with the successor's `leader.started`, the moment
its id is known, in the transaction of the turn that records its first call, after
`command.turned` or `plan.reviewed` and whether or not the call answered, so a session
that was paid for is recorded as the one command passed to. A
release whose successor never got a session id at all stays pending in the log (a
`leader.released` carrying a handoff after the root unit's last `leader.started`), and
the next IC call is briefed with its document and records the transfer. An outgoing
session that cannot be resumed for its handoff (the call dies before the stream's init
line) is released with the reason and nothing is handed off: the successor starts on the
file alone, and `step` says so. A handoff call that fails otherwise is filed as
`command.failed` with `turn: "handoff"` and ends the cycle like any failed IC call; the
session stays on the unit and the next cycle tries again. `incident review` prices the
handoff call under `ic` and lists each transfer with the context size that triggered it,
the document's length and how its document was evaluated (on which call, the verdicts by
kind and each item, or not yet); `incident show` names the IC's current session and counts
the transfers.

What the log holds per session, beyond its outcome and usage. Every tool call the session
makes is a `tool.called` event, written in the task's transaction before its claims: the
session id, the unit, the task in flight (`taskId`, null on a planner call, which carries
its `cycle` instead, null on a leader's turn, which carries its unit, and null on the IC's
own turns, which carry the root unit, the `cycle` and `seat: "ic"` so review tells them
from the planner's, and null on the initial IC's size-up, which carries the root unit,
cycle 0 and `seat: "initial_ic"`; a task run inside
the leader's session files its calls under the task with the leader's session id), `toolUseId`, the tool name, the full input, the result clipped at 4,000 characters
with `resultChars` saying how long it was, `isError`, `startedAt`, `endedAt` and
`durationMs` from the two messages' timestamps, and `transcriptPath`, the session's
transcript as the full record. The `StructuredOutput` call that carries the answer is the
result, not a tool call, and is not filed. Every subagent the session spawned is a
`subagent.ran` event read from the subagent's own transcript once the envelope's
`subagent_stats.spawned` is nonzero, in spawn order: `agentId`, `agentType` and `toolUseId`
(from its meta file; the `toolUseId` names the `Agent` call's `tool.called`), its model as
the envelope's canonical alias for the transcript's dated snapshot (so review can price
it), its usage summed
once per API message from its assistant records (the transcript repeats a message's usage
on each of its content blocks), and `toolCalls`, a count; the member's own calls follow as
`tool.called` events carrying its `agentId`. A subagent's usage is a breakdown of the
session's, which the envelope already includes, and is never added to `task.usage`. A
session that fails after making calls still files them, before `task.failed`, whether it
returned an error envelope or died before any (killed on its timeout, or a nonzero exit),
in which case the session id comes from the stream's init line and no subagent is read.
`incident
review` prints each session's calls by tool with errors and time in tools, each subagent
with its usage and calls, and the run's totals; per declared strike-team config (a task and
a kind, as last declared) it prints the model, who declared it, the count declared against
the members that ran, the members' usage and cost (a breakdown, priced on the member's
model), and how many claims cite a member, by the member's `agentId` or its `subagent.ran`
event id in the claim's evidence (`citesMember`); a refused request is printed in its cycle
with its reasons.

The verifier turns results into claims. A deterministic capability's result becomes a `verified`
claim with the capability and the effective inputs as provenance: the inputs as parsed, with
defaults applied and every path field resolved against the incident's working directory, so
the record says exactly what ran. Path inputs are declared per capability (`paths`) and
resolved before the run, and every claim subject is an absolute path (`/abs/file` or
`/abs/file:line`), so claims about one file from different tasks compare equal and a
session's assertion can be compared with a later deterministic result. A claim can only
enter the store as `asserted` or `verified`, and `verified` on entry requires deterministic
provenance. A deterministic claim enters with basis `observed`; a session names the basis of
each of its claims, and a result without one does not fit the schema. A session-backed
capability's result becomes `asserted` claims with the session id as provenance; an
`insufficient` result becomes no claims and an `task.insufficient` event carrying what was
needed. A claim's status never changes after entry: it says which kind of source produced
the claim, and the basis says whether that source saw it. Nothing promotes an asserted claim
to verified, and the validator gates `proven` and `satisfied` on basis `observed` alone
(Step 5). Rounds 1 and 2 had promotion on a deterministic match, asked for through
`claimsToVerify`; it fired in neither live run, so it went in round 3.
### Step 7: the command surface
| Command | Does |
|---|---|
| `noscope incident create "<objective>" [--constraint ...] [--priority ...] [--budget-tokens N] [--budget-seconds N] [--initial-model <model>] [--ic-model <model>] [--no-size-up]` | Creates the incident and its root unit, `command`, with the read-only built-ins as its equipment, then runs the size-up (R3-8): the initial IC on `--initial-model` (default `claude-haiku-4-5`) reads the objective, the constraints, the priorities and the runtime's own findings with the read-only tool set and writes the incident briefing, recorded as `incident.briefed` with its tool calls; command then transfers to the IC proper on the model the briefing names, `--ic-model` overriding it (and the default, `claude-opus-5`, standing in when the briefing names a model Claude Code does not serve), recorded as `command.transferred` with the briefing as its document. Prints the briefing and the transfer. A question in the briefing blocks the incident before the IC starts, the way a plan's does; `incident answer` reopens it. `--no-size-up` creates the incident on `--ic-model` or the default with no briefing, for tests and for incidents that need none. A size-up that fails is filed as `command.failed`, the incident stands unbriefed on `--ic-model` or the default, and the command exits 1. `--priority`, like `--constraint`, may repeat; the priorities are an input the IC restates or revises each period and the planner's rationale names when one chose between plans. |
| `noscope incident show <id>` | The incident file: objective, constraints, priorities, the current operational period's objectives and priorities, then the IC's situation from its last accepted command turn with the reassignments still open under it (R4-5), budget and spend, the IC's provider, model and current session with the number of transfers of command and every model change the log records (R4-7: each transfer of command with its kind, models and reason, each unit leader moved to the fallback after a refusal, each task retried on it), claims by status, open tasks, decisions with reasons, each unit's last report with the work behind it as the IC's change report showed it (R4-1; clipped per task at `NOSCOPE_REPORT_WORK_CHARS`), questions waiting on Mauria and capability requests (each naming the unit that raised it, when a leader did), the units waiting on a resource request with what each waits on, grants, registered capabilities. |
| `noscope incident tree <id>` | The unit tree with each unit's leader model, last report outcome, the IC's last verdict on it (R4-2), and, for a waiting unit, what it waits on, and task marks: done, running, ready, pending. |
| `noscope incident step <id>` | One cycle, then stop. Prints a handoff when one runs (the outgoing session, the context that triggered it, the threshold, and the transfer once the successor has answered), the IC's command turn (its verdicts on a briefing it took command with, objectives, priorities, its verdict on each report with the why and instructions, closes, each reassignment recorded with its claim count or dropped, the reassignments dropped on this turn with the why, the tasks a reassign cancelled, answers, what it raised, status), a transfer of command to the fallback model when a refusal forced one during the turn or a review (R4-7), the planner's draft, the IC's verdict with its corrections or amended plan and the redraft when there is one, the validator's verdict, the units created (a taking unit with the reassignment it takes, R4-4), what ran, each unit's report with any resource request it sent up, the tasks each leader assigned, any discrepancy raised, and whether a report stopped the pass. When the IC is refused on its model and on the fallback, prints that the incident is blocked, the question, and the `answer` command that resumes it, and exits 0 (R4-7). |
| `noscope incident run <id> [--max-cycles N]` | Repeats `step` until the incident leaves `open` or the cap is hit; the IC's double refusal stops it the same way. |
| `noscope incident events <id>` | The event log with timestamps and actors. |
| `noscope incident review <id>` | The After Action Review computed from the event log: the size-up when there was one (the initial IC's call with its usage and tool calls, what the briefing said in numbers, whom command transferred to and who chose the model, or the size-up's failure; its questions), then each cycle (cut at the IC's command turn; at `plan.proposed` in a log from before the IC) with its verdict, the IC's command turn (with its verdict on each report under it: the unit, the verdict, its why and instructions), reviews and handoff call with their usage, each transfer of command with the context size that triggered it, the document's length and its evaluation, or, for a fallback, the models, who chose the new one and the refusals (and their count at the end), each draft's planner call, rejections, tasks run (capability, model, tokens with the cache split, seconds, cost, claims), the cycle's wall time beside its dispatch span, the sum of its tasks' seconds and `parallel` (the sum over the span: 1.0 in sequence, higher when tasks overlapped), each leader's turns with their usage and outcome (a refused turn priced and named by its category, with the leader's move to the fallback; a report the runtime wrote after two refusals listed as such), a task's refused call priced and named with the model it was retried on, the resource requests it sent up and the tasks it assigned or was refused, discrepancies, strike teams declared or refused, questions and answers; totals by role and model (the IC under `ic`, the initial IC under `initial_ic`, leaders under `leader`); plan, IC-verdict (by kind: approve, correct, amend), report-verdict (R4-2: by kind, accepted, revise, reassign, for the incident and per unit), revision (R4-3: each revise delivered, with the turns and tasks between the brief and the report that answered it, their tokens, seconds and cost, the outcome before and after, and the report's changes not in the reviewed one, or that it is not yet reported; each delivery is also listed in its cycle with the instructions, and a report that answers a revise is marked with its number), reassignment (R4-4: each recorded, with the closed unit, the cycle, its claim count, whether it was taken and by which unit, dropped by the IC with the why, or is still open, and the instructions; the recording, the taking and a later drop are also listed in their cycles), briefing-kept (the verdicts on the IC's first accepted command turn that evaluated one: accepted, rewritten, discarded, of how many items; or that none was evaluated yet, that there was no size-up, or that it failed), task, leader-turn and claim counts, each unit's reports by cycle, each declared strike-team config against what ran under it (members, usage, cost, claims citing a member), and lacks resolved at a leader against those sent up; every refusal per seat with its category, model and session; the cost, recorded where the provider priced it and bounded at list rates where it did not. Deterministic; the judged review is the session-backed `review` capability, after v0. |
| `noscope incident sop <id> <name>` | Adds an SOP's unit and its tasks to the incident in one action plan. After v0. |
| `noscope incident answer <id> "<text>"` | Answers the oldest open question, the IC's, the planner's or a unit leader's; the IC's next change report carries the answer. A unit's question answered returns that unit to `active` once nothing of the unit's is open; the incident returns to `open` only when a command turn or a plan had blocked it and nothing of theirs still waits. While the incident is blocked on the IC's refusals (R4-7), the answer goes to the question the refusals raised, whatever older questions of the units are open, and one naming a model Claude Code serves, as a whole word anywhere in the text, transfers command to it and reopens the incident; any other answer is stored, the question is asked again and the incident stays blocked, with a hint listing the models. |
| `noscope incident provide <id> "<text>"` | Answers the oldest unanswered capability request, the IC's, the planner's or a unit leader's, with what was provided, or why not. A unit's request answered returns that unit to `active` once nothing of the unit's is open; the incident returns to `open` only when a command turn or a plan had blocked it and nothing of theirs still waits. |
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
| A headless session reaches Playwright's MCP server: `--mcp-config` with the inline JSON `{"mcpServers":{"playwright_browser":{"command":"npx","args":["--yes","@playwright/mcp@latest","--headless","--isolated"]}}}`, `--strict-mcp-config`, and `--allowedTools mcp__playwright_browser`; without the allowlist every tool call is denied and the session answers `insufficient`. The server refuses `file:` URLs ("Access to \"file:\" protocol is blocked"), so a local page must be served over HTTP. | Two probe sessions on Haiku, 2026-09-13; the live test in `test/reproduce.test.ts` serves the fixture page over HTTP. A screenshot the session names is resolved against the server's working directory, not `--output-dir` (playwright-core 1.63 `workspaceFile`, seen in run 002 when twelve screenshots landed in the roughdraftplus tree), so the server is started inside its output directory. |
| A headless session cannot use Claude in Chrome: with `--chrome` the session lists the `mcp__claude-in-chrome__*` tools, but every call is denied (`permission_denials` names `tabs_context_mcp`) with `--allowedTools mcp__claude-in-chrome` and even with `--permission-mode bypassPermissions`; the session answers that it needs permission. The integration is reachable only from an interactive session. | Three probe sessions on Haiku, Claude Code 2.1.270, 2026-09-13. `claude_in_chrome` stays registered with `headless: false` and its description says so. |
| `--bare` authenticates only with an API key. | `claude --help`. |
| Codex is installed and `codex exec` has `-m`, `-s read-only`, `-C`, `--add-dir`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--output-schema`, `--json` and `-o`. | `codex exec --help` on this machine, 2026-09-12. Nothing run through it yet. |
| The Claude Agent SDK requires an API key. | The SDK quickstart, read by a docs subagent; not read directly. |
| zod 4 converts a schema to JSON Schema with `z.toJSONSchema`, targets draft-2020-12 by default, and cannot represent dates, maps, sets, transforms or bigints. | The zod.dev JSON Schema page, fetched 2026-09-12. |
| Headless `--tools` filters built-in tools only; MCP tools from `--mcp-config` stay available even with `--tools ""`. | Four test calls against a minimal stdio MCP server, 2026-09-12; `spikes/mcp-tools-filter/run.sh` reproduces them. |
| `--json-schema` returns a schema-valid `structured_output` field, and `--tools ""` plus the five flags then fixed (the four of Step 3 and `--no-session-persistence`, since dropped) work with it. | A test call on the installed version with an planner-shaped prompt and action plan schema, 2026-09-12. |
| A headless call resumed with `--resume <session id>` accepts its own `--json-schema` and returns one structured result for that call, and the session remembers earlier calls. | Three Haiku calls on one session with three schemas, Claude Code 2.1.272, 2026-09-15; `spikes/round3/resume.sh`. |
| A resumed call reports usage for that call alone, not the conversation's total, and the envelope's usage is summed over the call's API turns while each `assistant` stream line carries its own message's usage, whose input is that message's context. | The stream fixture `test/fixtures/stream/session.jsonl` (live Haiku, Claude Code 2.1.272, 2026-09-15): three assistant messages read 7,253, 8,762 and 9,040 cached tokens and the envelope reports 25,055, their sum; the last message's input is 8 + 309 + 9,040 = 9,357, which `parseClaudeCodeResult` records as `contextTokens`. The same three calls: `num_turns` 2 on each, cache writes growing by one turn each time (8.7k, 9.0k, 9.3k). Cache reads were 0 on every `resume.sh` call (`--tools ""`, schema changed per call) and 10.2k on the `agents.sh` resumed call (`--tools Agent`, schema also changed); R3-3's live runs with a fixed schema and a context past Haiku 4.5's 4096-token cache minimum found the read intermittent: the first resumed call read the launch call's prefix in 14 of 24 runs and rewrote it in the rest (its write then equalled the whole context, about 12k), and a second resumed call read the first's in 24 of 26; the cause of the misses, the `resume.sh` zeros among them, stays open. |
| Auto-compaction can be turned off for a session: `DISABLE_COMPACT` in the environment disables it, and the session then errors at the context limit instead of summarizing. `--autocompact <tokens>` sets the window when compaction is wanted. The runtime never compacts the IC: it hands command off below the limit instead, when the context of its last call's last message (`contextTokens`, never the envelope's summed input) has reached `NOSCOPE_IC_HANDOFF_TOKENS` (default 120,000; R3-9, Step 6). | `code.claude.com/docs/en/env-vars` (the `DISABLE_COMPACT` row: "disable all compaction"; `DISABLE_AUTO_COMPACT` disables only the automatic kind) and `code.claude.com/docs/en/model-config` ("Extended context": with auto-compaction off, sessions stop with the context-limit error), read as raw markdown 2026-09-15; not run live. The handoff is tested on the stub only; the threshold has not been reached live. |
| The result envelope accounts for subagents: `total_cost_usd` includes them (the two `modelUsage` entries, the parent under `claude-haiku-4-5` and the `pinger` under its dated id `claude-haiku-4-5-20251001`, sum to it exactly: 0.0286 + 0.0010 = 0.0296); `subagent_stats` counts spawned, completed, failed and by type. Whether the top-level `usage` block includes the subagent's tokens is not settled by the run (its output tokens, 421, were below the parent's own `modelUsage` entry, 515), so R3-1 records the envelope as is and a subagent's transcript usage as a breakdown, never added. Each subagent's transcript at `~/.claude/projects/<dir>/<session id>/subagents/agent-<id>.jsonl` carries its per-message usage, and the `.meta.json` beside it carries the `toolUseId` of the `Agent` call that spawned it. | One Haiku call spawning one `pinger` subagent, 2026-09-15; `spikes/round3/agents.sh`. |
| `--agents <json>` is honored on a `--resume` call: a session started without agent kinds and resumed with one can spawn it. | The same spike, second half, 2026-09-15. |
| In print mode `--allowedTools` is a floor: a Haiku session under `--tools Bash --allowedTools "Bash(ls *)" "Bash(cat *)"` ran `ls .` (listed) and `grep -c . lines.txt` (unlisted, read-only), and was denied `touch touched.txt` (unlisted, writes: "File creation blocked by security restrictions", under `permission_denials`, the file not created); with paths outside the working directory every command was denied, listed or not ("access restricted to allowed working directories"). | Prompted by R3-8's live size-up transcript (session `5604665f`, 2026-09-15), where Haiku ran `grep` through Bash four times off the read-only list and every call succeeded; then a scratch-directory probe on Claude Code 2.1.272, 2026-09-15. |
| The API can refuse a resumed call outright, and the refusal sticks to the session: Claude Code writes a `system` line with `subtype: "model_refusal_no_fallback"`, the category and the explanation, a synthetic assistant message with `stop_reason: "refusal"` and `stop_details` repeating them ("API Error: Opus 5's safeguards flagged this message ... Try rephrasing the request in a new session or change your model"), then exits 1 with a result whose `stop_reason` is `refusal` and whose usage is the refused call's; the next call on the same session is refused again in under a second. The category's key is spelled by the record: the stream's system line carries `api_refusal_category` and `api_refusal_explanation` (the SDK message shape), the session's transcript under the project directory carries `apiRefusalCategory` and `apiRefusalExplanation` on the same line. | The third live run (R3-10, 2026-09-15, Claude Code 2.1.272): the IC's command turn on Opus 5 succeeded at 23k of context, its review turn over the planner's draft (another model's output) came back with category `reasoning_extraction`, and the next step's command turn on the same session refused identically; IC session `cf551f26`. The cause of the category on a review turn is not known; R3-10a replaces a refused session rather than resuming it. The spelling: R3-10a read `apiRefusalCategory` off the stream and the run's `command.failed` events recorded `unstated` with an empty explanation, while the transcripts of sessions `cf551f26` and `a30d1d7f` carry `apiRefusalCategory: "reasoning_extraction"`; the stream's `api_refusal_category` is the binary's own serializer for the SDK system message, read from 2.1.272's code on 2026-09-15 (R4-7), not seen live, so R4-7 reads both spellings, the assistant's `stop_details`, and the transcript when the stream names no category. Claude Code has a refusal fallback of its own (`model_refusal_fallback`, per-category routing; its `no_fallback` line is what a call gets when none is configured), which the third run's sessions did not have; the runtime's fallback (Step 6) is its own. |

### Model choices
| Role | Model | Because |
|---|---|---|
| Planner | `claude-opus-5` | The action plan is the judgment in the system; Opus 5 is the default for anything nontrivial, and it ran the test action plan well. |
| Initial Incident Commander, the size-up | `claude-haiku-4-5` by default, `--initial-model` at `create` overrides | The size-up is a read of what the objective points at and a sketch, cheap by design; whatever it thinks is evaluated by the IC proper, so a wrong guess costs one turn's worth of judgment and no authority (ruled by Mauria, 2026-09-15). Its briefing is scoped to the objective's verb (round 4, R4-8): an objective that asks to determine, identify, explain or find, or asks a question (where, what, why), is a diagnosis and takes no fix objective, no fix unit and no question about intended behavior, since the answer is the cause; one that asks to build, change, fix or add is a build and takes them; and a question for Mauria is only what no tool could find and the objective does not settle. Both size-ups of run 003 proposed a fix and asked what the intended behavior should be on a diagnostic objective, and the IC discarded them at the cost of a question round each time. |
| Incident Commander, the root unit's leader | Routed per incident by the briefing's `incomingCommander` (R3-8); `--ic-model` at `create` overrides; `claude-opus-5` when nothing routes it (`--no-size-up`, a failed size-up, or a briefing naming a model Claude Code does not serve) | The judgment an incident needs is what the size-up is for: a narrow, well-marked read can run under a cheaper commander, a build or a subtle investigation under Opus. The IC's first act is to evaluate the briefing, so the model it runs on never inherits a cheaper model's conclusions. |
| The fallback for a refused seat: the IC, a unit leader, or a task session | `claude-opus-4-8`; `NOSCOPE_IC_FALLBACK_MODEL` overrides it for every seat | Ruled by Mauria in review, 2026-09-15: a refused call is retried once, deterministically, on Opus 4.8, and a second refusal goes to judgment (the IC's for a unit, a question to Mauria for the IC). The retry is a change of model rather than of wording because the refusal sticks to the session and the cause of the category on a review turn is not known (Reference table); whether Opus 4.8 refuses the same prompts is not known until a run tries it (R4-10). |
| Unit leaders | Named per unit by the planner, any model the provider serves | The same routing as tasks: a unit whose tasks are narrow reads gets a Haiku leader, and its tasks on Haiku run inside that one session. |
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

So one cycle as written is the IC's command turn and review, two resumed Opus calls on a
context that grows with the file, plus the planner, about 15 to 20 s, twice on a
correction, plus its tasks, each session-backed one roughly 7 to 30 s and each
deterministic one negligible. Through round 3 the tasks ran one after another, and an
incident that took five cycles with two sessions each ran three to four minutes; that was
slow for a daemon and right for v0, which is stepped by hand to be watched. Since R4-9
(Step 6) unrelated units run at once, up to `NOSCOPE_PARALLEL` passes (3 by default), and
inside a unit the tasks in sessions of their own start together, so a cycle's task time is
the longest chain of dependent tasks rather than the sum; `incident review` prints each
cycle's wall time, its dispatch span, the sum of its tasks' seconds and their ratio, which
is what the fourth run (R4-10) measures. Tasks inside a leader's session still run one at
a time, and the startup cost per session stays unless sessions are reused with `--resume`,
which the provider supports since round 3 (R3-3) and unit leaders use (R3-4): a resumed
Haiku call with a fixed schema read its earlier turns from cache in most runs and rewrote
them in the rest (2026-09-15; the Reference table has the counts), so a resumed call's
input cost is bounded by the whole context at cache-write rates, not by the new turn.
## Open questions
| What is undecided | Needed for v0? | What waits on it, and what the build assumes meanwhile |
|---|---|---|
| A Situation Unit: ICS gives it the job of collecting and summarizing the situation so command sees a picture rather than raw reports. Here it would be a periodic session-backed capability that reads the incident file and writes a situation summary, for keeping perspective across many cycles and for triage when noscope runs with little supervision. Whether it earns a call of its own or folds into the planner's input rendering is the question. | No. Since R4-5 the IC writes the situation on every command turn, so the summary command works from is its own; a Situation Unit would be a seat that drafts it for the IC, as the planner drafts the tactics. | Autonomous incident cannot be designed until this is settled; v0 is stepped by hand and the incident file is the picture. |
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
