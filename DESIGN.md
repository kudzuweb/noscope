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
| Unit | A box in the incident's temporary tree that owns one slice of the problem, the way an ICS Branch or Group does. It has an objective, a parent and children, and it opens, subdivides and closes as the planner's picture of the problem changes. A unit is a type plus a config (round 4, R4-10, ruled 2026-09-15): the type is the form and the protocol, the config is the filled form, and the unit's `type` names which. Every unit has a leader (round 3, R3-4): a session on the provider and model the unit names, created at the unit's first turn, resumed for each turn after, and demobilized when the unit closes; it holds no tools and runs no task (round 5, R5-4: the leader directs and never does), it is called only on a decision (round 5, R5-5: a failed or insufficient ending, a revision brief, an ending it asked to be consulted on, or the report it owes once nothing is ready; a completed ending starts the next ready task with no call), and the unit's declared equipment and Bash allowlist are what its tasks may use. Under the `base` type the leader directs the unit's tasks and reports against the objective; the root unit, `command`, is the one unit of the `ic` type, owns the incident objective, is created with the incident, and its leader is the Incident Commander. A unit is `waiting` (R3-6) from the report on which its leader raised a resource request until Mauria answers it: it runs nothing and takes no new task, its pending tasks stay pending, and the other units and the incident go on. |
| Unit type | The form and the protocol of a kind of unit, registered by name in `src/units/` as capabilities are (R4-10). The form is a zod schema of the fields a config of the type fills, every form carrying a `role` field for the role text its session reads (defaulting to the type's own), with descriptions the planner's schema renders. The form is not free-standing: today its fields are the `units` columns (`objective`, `leader_json`, `equipment_json`, `bash_allowlist_json`, `role`), the planner renders only the base form's fields, through `UnitProposal` built on `BaseUnitForm` (its leader, equipment and allowlist optional when a saved config is named, R4-11), and the `ic` form's equipment, allowlist and role are filled by its defaults alone, since `newCommandUnit` takes only the leader and `incident create` has no flag for the rest. The protocol is how a unit of the type uses what is in the box: the seat and role text its session holds, whether it files reports the IC answers, the rules its assignments are held to, whether it has a turn to take before or without a task, and the turns it takes around its tasks in a pass. Two types exist: `base`, the led unit (`src/units/base.ts`: the form is the planner's unit proposal less the ref and the parent, objective, leader, equipment, Bash allowlist and role; the protocol is the leader's turns), and `ic`, command (`src/units/ic.ts`: the form is the IC's provider and model, the equipment and allowlist the tasks under command may use (its own session holds no tools, R5-5) and its role, with no objective, since the incident's is its objective; the protocol is the IC's turns in `src/ic.ts` plus the root's pass). A plan may create a unit of `base` only; the runtime creates the one `ic` unit with the incident. More types will be written and saved, so the registry, the table and the code permit that. |
| Unit config | A type's form filled: the values chosen for one incident, held on the unit's row (R4-10). A config keeps its type's protocol, since it occupies the same place in the hierarchy and reports the same way; what varies between configs of a type is the form's values, the role text included. A saved config (R4-11, ruled 2026-09-15 13:00 to 13:34) is a filled form less the objective and the parent (for `base`: the leader's provider and model, the equipment, the Bash allowlist and the role text), kept under a name in the `unit_configs` table by `noscope config save`, read by `config list` and `config show`, and deployed by name in a plan: a `UnitProposal` naming a `config` fills only the objective and the parent, the config fills the rest, a field given beside `config` overrides the config's, and the unit's row names the config it came from, which `incident review` prints. Nothing is saved without the command; when the same filled form has appeared three times unsaved across the file's incidents, `step` prints the offer to save it with the command to run. |
| Task | A bounded piece of work owned by one unit and bound to one capability: objective, inputs, expected output, completion criteria, evidence required, dependencies, what it reads by reference (`evidenceFrom`: claims by id, and tasks whose results it needs), and for a session-backed capability the model and any instructions. It is the worker's brief, and for a session it is the prompt the session receives: the incident's objective, the current hypothesis and the claims it rests on, the hierarchy around the owning unit, then the task, then the referenced claims and results attached by the runtime. Every session task runs in a session of its own and every deterministic task in process, never on the leader's session (round 5, R5-4), and either result reaches the leader on its next turn as one line naming the claims it produced, which is at once when the ending needs a decision and otherwise whenever the leader is next called (R5-5). A session task may also declare a strike team (`strikeTeam`, round 3, R3-5). |
| Strike team | Several subagents of one kind and model sent on one task (ICS: same kind and type, one leader). Whoever defines the task defines the team with it: a task's `strikeTeam` entry names the kind, its model, its tools, the member's system prompt, how many to send and why, whether the plan wrote the task or its unit's leader assigned it; a turn asks for none (round 5, R5-4: the leader no longer runs the task the team would be provided to). No preset kinds and no default kind exist (ruled 2026-09-14), so the record shows what plans and leaders declare. The validator checks the model against the provider's list, the tools against the read-only built-ins, and the count against the task's token bound, and nothing else. The kinds are defined for the task's own session alone, and every member's run is filed as `subagent.ran` under that task. |
| Task force | A task that declares more than one kind: the same field with several entries, the mixed-kind team ICS sends for one mission. |
| Equipment | A primitive: a function the runtime calls in-process, a Claude Code built-in tool such as Read, Grep or Bash under an allowlist, or later anything else a capability needs to do its work. Registered by name. Never assigned by the planner. |
| Capability | The assignable thing: declared equipment plus, when judgment is needed, a headless session with a system prompt; the model comes from each task. A capability with no session is deterministic and its output is evidence (round 5, R5-1); one with a session produces asserted claims. A capability may include other capabilities. Later, a human. |
| Provider | A program that can run a session: Claude Code first, Codex second, later an HTTP API or a human. A provider maps the session fields onto its own command line and turns its output back into the runtime's result shape. Everything above the session layer is provider-blind. |
| Claim | A statement about reality a session asserted, with a basis and provenance. The status is a label and gates nothing: every claim enters `asserted`; `rejected` is in the enum and nothing sets it yet; `verified` is read from records written before round 5, when a deterministic task's output was written as claims (R5-1 ended that: 162 of run 004's 216 claims were grep matches and git facts, read by every seat every cycle, and run 003 reached the same answer with 24 claims). The basis is what the validator keys on: `observed` when it was seen in code, in output, in a browser or in evidence attached to the brief, `inferred` when it was reasoned to from what was seen; a status never changes after entry (ruled 2026-09-14: promotion fired in neither live run, and sessions were right about the code 74 of 75 audited times). A claim resting on evidence names the deterministic tasks it cites in its provenance (`cites`), and keeps the basis the session gave it only when every cited task was attached to the session's brief; otherwise it enters `inferred`. Confidence means the same on every claim: observed, 0.9 to 1; inferred from code, at most 0.7; runtime behavior not reproduced, at most 0.5. |
| Evidence | A deterministic task's output (R5-1): a grep's matches, a read's text, a git history, a path's existence. Recorded whole on `task.completed` and the task record, addressed by task id, and never turned into claims. A task that needs it names the id in `evidenceFrom.tasks` and the runtime attaches it whole to the brief; every other seat sees one line per piece of evidence, the capability's `measure` of it (a count of matches, lines or commits) beside the task id, in the incident file's section 2, the change report's work blocks and `incident review`. Evidence flows down to the task that reads it; the claim the task makes about it flows up, citing the task id. |
| Event | One append-only record of something that happened, written in the same transaction as the state change it describes. |
| Action plan | The planner's plan for one operational period: units to create or close, tasks to create or cancel, questions for a human, grant requests, capability requests, incident status. It is the tactics for the period, drafted by the planner against the period's objectives and the IC's situation as a suggestion for the IC, checked by the validator before the IC sees it (a rule break goes back to the planner, up to twice a cycle, with no IC call between; round 5, R5-3), reviewed once by the IC for substance (approved, corrected with patches the runtime applies and validates, or amended), and only then applied. |
| Situation | The understanding of reality the incident has, from the size-up on (round 5, R5-2, ruled by Mauria in review on 2026-09-15: reading and trying things either shows progress or adjusts that understanding, then priors are updated and tactics may change). One picture, `{ picture, evidence, open, assessment, changed }`: `picture` is what the incident now believes is going on, in prose; `evidence` names the claims for and against it by id (only a claim marked for with basis observed proves a part of it); `open` is what is not yet known, each item in prose with what would settle it and an id the runtime gives it (`<incident>-oNN`) when the turn is applied (a new item carries no id; a carried one keeps the id the file lists, and the IC never invents one), and each either worked by a task in the period's plan that names it in `settles` or deferred by the IC with a why; `assessment` is `on_track`, `priors_updated` or `tactics_change` with a why, and `tactics_change` is what the planner reads as the signal to redraw the units rather than extend them; `changed` is what the turn changed. The initial IC's briefing seeds the first picture (its dominant problem and its unchecked needs as open items), so the IC's first turn edits a picture rather than inventing one (run 004's first turn was rejected for inventing claim ids). The IC edits it on every command turn (round 4, R4-5, gave it to the IC; the planner wrote it into each plan until then); the planner reads it in full in section 10 and drafts the tactics that work its open items; the validator holds the plan to them (Open items are worked) and the turn to its claims (Situation grounded); `incident show` prints it under the period and `incident review` lists each turn's assessment. Observations flow up and only objectives and evidence flow down (ruled in review at 22:53): each unit leader keeps the picture of its own slice and reports it up (`LeaderReport.situation`: picture, evidence, open, changed), the change report renders it under the report so the IC folds slices into the whole on its verdict, and no unit ever reads the IC's picture, hypothesis or assessment, so a misconception at the top cannot propagate down. A reassignment is written into the slice it concerns rather than listed apart; an item deferred is a decision recorded, not an omission. |
| Cycle | One operational period, in eight steps (round 3, R3-7): (1) the runtime renders the IC's briefing, the change report since the IC last acted followed by the incident file; (2) the IC's command turn sets the period's objectives and priorities, edits the situation (R4-5; R5-2: the picture seeded from the briefing, its evidence, open items and assessment, each unit's reported slice folded in), closes units, answers what it can, raises what only Mauria can supply, and says whether the incident continues, and when it does not the cycle stops here; (3) the planner drafts an action plan against the period and the situation; (4) the validator checks the draft, and a draft that breaks a rule goes back to the planner with the reasons, with no IC call between (R5-3); (5) the IC reviews the valid draft once, for substance: approve, correct (a list of patches the runtime applies to the draft and validates again, with no redraft and no second review), or amend (a whole plan, validated again); a correction that breaks a rule goes to the planner with the IC's correction and the reasons, never back to the IC; (6) the plan is applied; (7) the units run under their leaders until they report or one report changes the picture; (8) stop. At most three planner calls (the draft and two redrafts, whatever their causes) and one IC read per cycle, plus one handoff call before the command turn or the review when the IC's context has reached the handoff threshold (Step 6); the IC is never consulted per task. `incident step` runs exactly one. |
| SOP, standard operating procedure | A saved unit configuration that can be added to any incident: the unit's purpose, the tasks it opens, each with its capability, instructions and equipment, the angles the planner may choose among for this incident, and the unit's completion criteria. A code review SOP, for example, opens a review unit whose tasks read the change from the angles that matter for it. Capabilities compose work into one assignable result; SOPs compose organization into a unit. Declared in code under `sops/`, applied by command or by the planner. After v0. |
| Incident file | The one place command keeps the state of an incident: objective, constraints, priorities, the current operational period's objectives and priorities as the IC set them, budget and what is spent, the current tree, findings by status, every decision with its reason, questions waiting on a human, grants given, and pointers to evidence. The IC's briefing and the planner's input are both rendered from it in full, the IC's opening with the change report since it last acted; a task receives the objective, the period, its own slice, and what it names in `evidenceFrom`, and never the IC's situation (R5-2). Stored across the tables in Step 2 and printed by `incident show`. |
| Operational period | ICS's word for the span one action plan covers; here it is one cycle. The IC opens it by setting its objectives (what this period must establish) and priorities (the incident's, restated or revised), recorded on the incident and rendered into the planner's section 1 and into every leader's orientation and every task's brief. It ends when the units have reported or when one report changes the picture. |
| Incident briefing, transfer of command | The first handoff document (round 3, R3-8): what the initial IC writes from its size-up when the incident is created, on ICS 201's lines (kind, dominant problem, what is obviously needed and whether a tool checked it, initial objectives, an initial organization sketched one unit per line, questions proposed for Mauria, hazards, and the incoming commander's provider and model with a reason), recorded as `incident.briefed`. Command then transfers to the IC proper on `--ic-model` or the default, Sonnet 5 (round 5, R5-6), recorded as `command.transferred` with the briefing as its document and the briefing's recommended commander as its reason, recorded and not followed; the same event records R3-9's handoff at the context threshold, told apart by `kind` (`initial`, `handoff`). The IC's first act on taking command is to evaluate the briefing item by item and to rule on each question it proposed, accepting it (asked, and blocking until Mauria answers), discarding it with a why, or answering it from the objective (round 5, R5-8): nothing in it binds it, and only a question the IC accepts reaches Mauria. |
| Budget | A bound on tokens, wall time or both, set on an incident or on a task. The planner sees what remains and plans inside it; the validator rejects a task that does not fit; the dispatcher enforces the time bound and records usage. The costs it reasons with are facts stored on the equipment and capabilities themselves (see `cost` in Step 3), never estimated elsewhere. Unlimited is allowed and is the v0 default. |
| Grant | Permission from Mauria for a capability whose effect is not `read_only`, with the planner's stated reason attached. Least privilege: nothing that writes runs without one. Three levels stack: an incident grant covers every task on that incident for that capability, which is the default; a standing grant in a config file whitelists a capability everywhere, so she stops approving the same thing; and per-task approval can be switched on for a capability when a single use deserves its own yes. Auto-whitelisting after some number of unqualified approvals is a later feature, and whether its count is per incident or global is decided after she has used it. v0 registers only `read_only` capabilities, so no grants are needed until after v0. |

### ICS mapping
Definitions checked against the NIMS Third Edition (FEMA, October 2017) on 2026-09-12.

| ICS term | Here |
|---|---|
| Incident: an occurrence that necessitates a response. | Incident, same word. Here it means anything Mauria asks for, a build as much as a failure. |
| Operations Section: the part of the incident organization that does the tactical work. | The units under command with their leaders: each leader directs its unit's tasks and reports against the unit's objective; tasks run by capabilities, each in a session of its own or in process, never in the leader's (R5-4). |
| Agency Administrator: the executive above the incident who delegates authority to the Incident Commander, sets policy and priorities, and is briefed. | Mauria. Grants are her delegation of authority, `op show` is her briefing, and questions for a human go to her. |
| Safety Officer: on the Command Staff, with independent authority to stop any unsafe act. | The validator's effect policy plus grants: nothing that writes runs without her permission, and the validator can stop an action plan on its own. |
| Public Information Officer and Liaison Officer: what is told outside the incident, and the contact point for other agencies. | None. An incident is not charged with keeping anyone informed; providers and external MCP servers cover the liaison work without a role. |
| Incident Commander: develops objectives, orders and releases resources. Planning Section: collects the situation picture, tracks resources, drafts the Incident Action Plan for the commander to approve. | The Incident Commander is the leader of command, the root unit, which is the one unit of the `ic` type (round 3, R3-7; round 4, R4-10: the IC is not a special case of the led unit but a second type with its own form and protocol): one persistent session, briefed with the full incident file at the top of every cycle, that sets the operational period's objectives and priorities, reads the units' reports, closes or re-tasks units, reviews the planner's draft in one round, and declares the incident met, failed or blocked on a question for Mauria. It scopes, breaks down, equips and judges; its digging is assigned to tasks under units, never done itself. The planner drafts the action plan as the Planning Section does, stateless, fed the full file plus the period's objectives and priorities, as the tactics suggested to the IC; the situation picture, which ICS gives the Planning Section's Situation Unit, is the IC's here (R4-5; R5-2): seeded from the briefing, edited by the IC on every command turn from each unit's reported slice, read in full by the planner alone in section 10 (its open items are what the plan works, its assessment whether to extend the units or redraw them) and by no unit, and printed by `incident show` under the period. The runtime is the Planning Section's bookkeeping: it renders the briefing, records every turn, checks the plan's shape, dispatches and records. The IC's review is the commander's approval of the plan; the validator's check precedes it (R5-3), so the commander approves substance and never form, and Mauria answers grants and questions. |
| Initial Incident Commander and transfer of command: the first arriving officer sizes the incident up, takes initial actions and briefs the incoming commander on ICS 201; command passes with that briefing, and the incoming commander is bound by none of it. | The initial IC (round 3, R3-8): a session on a cheap model (`claude-haiku-4-5` by default, `--initial-model` at `create` overrides) that runs once when the incident is created, with the read-only tool set and the runtime's own findings (registered capabilities and equipment, the budget, whether the working directory is a git repository and its state, whether each URL a constraint names answers), and writes the incident briefing: kind, dominant problem, what is obviously needed and whether it was checked, initial objectives, an initial organization, questions proposed for Mauria, hazards, and the incoming commander's model with a reason. The transfer of command puts the root unit's leader on `--ic-model` or the default, Sonnet 5 (R5-6), records the briefing's recommended commander as its reason without following it, and is recorded with the briefing as its document; the incident stays open, whatever the briefing asked (R5-8). The IC proper's first command turn carries the briefing and must evaluate it, item by item, accepting, rewriting or discarding each, and rule on each question it proposed for Mauria, accepting, discarding or answering it, so a stronger model is never bound by what a cheaper one thought and no question reaches Mauria that the IC did not raise; `incident review` counts what it kept and what became of each question. |
| Section, Branch, Division, Group, Unit: the organizational levels, distinguished by depth and by functional versus geographic responsibility, each with a supervisor. | All are the one thing called a unit here. Depth is whatever the tree needs, a unit's objective says what it is responsible for, and its leader is the supervisor: a session that holds the objective, directs the unit's tasks and files a situation report (`unit.reported`: outcome `met`, `not_met` or `progress`, what changed on which claims, whether the picture changed, the unit's own picture of its slice with its evidence, open items and what changed (R5-2), and for `not_met` why and a suggestion for the IC to decide on). Observations flow up and only objectives and evidence flow down: the leader reads its objective, the period objectives, the evidence attached to its tasks and its own unit's last picture, never the IC's. A unit's leader is called its leader; the root's is the IC. |
| Single Resource, Strike Team (same kind and type, one leader), Task Force (mixed kinds for one mission). | A capability is a single resource, and equipment is equipment; the word is ICS's. A strike team is several subagents of one kind and model sent on one task from the task's own session, declared on the task by whoever defines it, the plan or the leader that assigns it (round 3, R3-5; round 5, R5-4); a task force is the mixed-kind version, the same field with several kinds. No presets and no default kind: whoever defines the task defines the team, choosing kind, model, tools, prompt and count and saying why, and the record of what is declared is how presets and least privilege are learned later. A capability that includes other capabilities is composition in code, not a team. |
| Resource typing: categorizing resources by capability so everyone means the same thing by a name. | Two things. A task's means are typed by the capability registry: name, description, schemas, side effects. A unit is typed by outfitting it (R4-11): filling a type's form into a config, which the planner does in every `UnitProposal`, and a saved config is a typed resource kept under its name in `unit_configs`, so everyone means the same thing by it and the planner deploys it by name instead of filling the fields again. |
| Assignment: a task given to a person or team based on the objectives in the Incident Action Plan. | Task, ruled by Mauria as the software word for the same thing. |
| Incident Action Plan and Operational Period: the objectives and tactics for one period, then a new plan. | Action plan, same word: the planner's draft for the period, checked by the validator and then reviewed by the IC before it is applied. One cycle is the operational period, opened by the IC's command turn. |
| The Planning P: objectives, tactics meeting, planning meeting, plan approval, briefing, execute, repeat. | The cycle's eight steps: the IC is briefed and sets the period's objectives (objectives), the planner drafts and the validator checks the draft (tactics and planning meetings), the IC approves, corrects or amends (plan approval), the plan applies (briefing), the units run to their reports (execute), stop, repeat. |
| Span of control: one supervisor to five is the guideline, not a rule. | Validator rule: target 5 direct children, maximum 7. |
| Demobilization: the orderly release of a resource when no longer needed. | Closing a unit and cancelling its tasks. |
| Situation Unit and Resources Unit: who tracks what is known and where every resource is. | The store holds what is known: the claims, and the tasks and their statuses as the resource tracking. The Situation Unit's summary, the picture command works from, is the IC's own situation, seeded from the briefing and edited on its command turn from the slices the units report up (R4-5, R5-2). |
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
│   ├── planner.ts        # the planner's call: renders the ten sections, records plan.proposed, redrafts on a rejection
│   ├── ic.ts             # the Incident Commander: the change report and briefing, the command turn, the review
│   ├── patches.ts        # the IC's correction of a valid draft: patches applied by the runtime (R5-3)
│   ├── validator.ts      # action plan rules
│   ├── dispatcher.ts     # runs each unit's pass through its type's protocol, unrelated units at once
│   ├── leader.ts         # what every seat shares: the log's windows and records, the fallback model, the actors
│   ├── units/
│   │   ├── registry.ts   # defineUnitType: a type is a form and a protocol; the pass contract; the session request
│   │   ├── base.ts       # the led unit: LEADER_ROLE, its rules, the leader's turns and pass hooks
│   │   ├── ic.ts         # command: IC_ROLE, its form, the root's pass; its turns are in ../ic.ts
│   │   └── index.ts      # the package surface
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
| `units` | `id`, `incident_id`, `parent_id`, `type` (the registered unit type, R4-10: `ic` for command, `base` for a led unit), `objective`, `leader_json` (provider and model), `equipment_json`, `bash_allowlist_json`, `role` (the config's own role text, null for the type's), `config` (the saved config the unit was deployed from, R4-11; null when the plan filled the form itself), `session_id` (the leader's session, null until it first runs), `status` (`active`, `waiting`, `closed`), `created_at`, `closed_at` |
| `tasks` | `id`, `incident_id`, `unit_id`, `capability`, `objective`, `inputs_json`, `expected_output`, `completion_criteria_json`, `evidence_required_json`, `depends_on_json`, `evidence_from_json`, `provider`, `model` (both required for a session-backed capability), `instructions`, `budget_json`, `strike_team_json` (the kinds the leader may send on the task; `[]` when none), `status` (`pending`, `ready`, `running`, `completed`, `failed`, `cancelled`), `result_json`, `created_at`, `completed_at` |
| `claims` | `id`, `incident_id`, `subject`, `predicate`, `object_json`, `status` (`asserted`; `rejected` and `verified` are in the enum, the latter read from records written before R5-1 and never written now), `basis` (`observed`, `inferred`), `confidence`, `evidence_json`, `provenance_json` (capability, task id, session id, and `cites`, the deterministic task ids the claim rests on, when it cites any; records from before R5-1 carry a deterministic run's `inputs` instead of a session id), `created_at`. A deterministic task's output is not a row here: it is the task's `result_json`, its evidence (R5-1). |
| `events` | `id`, `scope` (`incident` or `system`), `incident_id` (required for an incident event, null for a system event, enforced by a CHECK), `sequence` (unique per incident, and per the system scope), `type`, `actor`, `payload_json`, `created_at`, `runtime` (R4-12: the noscope commit the writing process was built from, `-dirty` when a tracked file differed from it at the build, `unknown` when the build found no checkout; null on an event from before the tag). A payload carries a `mutation` naming the exact state change the event records, so replay applies that and nothing else; an event with no mutation, such as `plan.proposed`, changes no state. A replay re-inserts each event with its own tag, never the replaying build's. |
| `grants` | `id`, `scope` (`incident` or `standing`), `incident_id` (null for standing), `capability`, `effect`, `reason`, `granted_by`, `per_task` (boolean), `created_at`. Empty in v0. |
| `unit_configs` | `name` (the primary key; a name is saved once), `type` (the registered unit type), `form_json` (the filled form less the objective and the parent, as JSON keyed by the type: for `base` the leader, equipment, Bash allowlist and, when the config has one, the role text; a later type's config is saved the same way), `saved_from_incident_id`, `saved_from_unit_id` (no foreign keys: a config outlives its incident, and its event replays before any incident's), `saved_at`. R4-11; written by `noscope config save` only. |

Event types in v0: `incident.created`, `incident.blocked`, `incident.closed`, `unit.created`, `unit.closed`,
`task.created`, `task.ready`, `task.started`, `task.completed`, `task.failed`,
`task.cancelled`, `task.insufficient`, `claim.asserted`, `claim.verified` (written before R5-1 only; replayed, never recorded now), `claim.rejected`,
`plan.proposed`, `plan.rejected`, `plan.applied`, `task.usage`, `budget.exceeded`,
`question.asked`, `question.answered`, `grant.requested`, `grant.given`, `capability.requested`,
`capability.answered`. Round 3 adds `tool.called` and `subagent.ran`, one per tool call a
session makes and one per subagent it spawns; `leader.started` (a unit's leader session
recorded on the unit, the mutation `unit.session`), `unit.continued` and `unit.reported`
(one per leader turn, with the call's usage, the task ids of the endings the turn put to
the leader under `heard` and those the leader named in `consult`, R5-5; `unit.continued`
is also the runtime's record of an ending that needed no turn, `writtenBy: "runtime"`
with the task and how many ready tasks start, R5-5), `picture.discrepancy` (a seat saying the
update it received describes a different problem), `strike_team.defined` (a strike team declared on a task by the plan, or by the leader that
assigned the task, R5-4) and `strike_team.rejected` (a leader's request refused with its
reasons; nothing writes it since R5-4, and a log from before it still reads), `command.turned` (the IC's command turn, its situation on it
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
command follows. `question.asked` written at the IC's first command turn carries
`proposals` (R5-8), each briefing question the IC accepted or answered by its number and
the id it got, and an answered one is followed by `question.answered` with the actor `ic`,
the answer and the why; a briefing question the IC discarded is only the ruling on the
turn. A
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
`reassignmentId`), since `unit.close` sets status only. R5-10 adds a second shape of
`task.cancelled`: one per pending task settled because a task it waited on will never
complete, carrying `because`, the id of the failed or cancelled task at the root of the
chain, and `reason`, naming the task it waited on directly and what became of the root
(`depends on 001-t05, which failed: ENOENT ...`; transitively, `depends on 001-t06,
cancelled because 001-t05 failed: ...`), written by `cancelDependents` in the transaction
of the `task.failed` (the dispatcher's, `failInterrupted`'s included) or `task.cancelled`
(a plan's cancel, a reassign verdict's) that caused it; `settledBy` in `src/leader.ts`
reads them back keyed by the root. And `reassignment.taken`: one per
new unit whose proposal names a reassignment in `takes`, written by `applyPlan` after the
unit's `unit.created` and before `plan.applied`, with the reassignment's id, the new
unit's id and `fromUnitId`, the closed unit's. And `reassignment.dropped`: one per entry
of a command turn's `dropReassignments`, written by `applyCommand` in the turn's
transaction, actor `ic`, with the reassignment's id, the why and the cycle, which closes a
reassignment still open on a later turn. A reassignment is open while it is recorded, not
dropped (by its verdict or by a later turn) and not taken; none of the three events
changes state, and a replay reads the same set. R4-11 adds `config.saved`: one per
`noscope config save`, a system event (scope `system`, no incident: the config outlives
the incident it was taken from) with the mutation `config.save` carrying the whole
`UnitConfig`, actor `cli`; a replay applies the system events first, so every saved config
is restored before any incident's plan names it.

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
before then replays the same way, so a round 4 file reads as before; version 7 (before
the runtime tag, R4-12) adds `runtime` to `events`, which every earlier event reads as
null, since what wrote them is not recorded (the column is added ahead of the version 5
step too, since that step writes an event); version 8 (before
saved configs, R4-11) gives every unit a null `config`, since every form was filled by
hand, and the `unit_configs` table arrives empty with the schema. A file at a later
version is refused.

The runtime tag is what makes a seat's briefing reproducible, ruled by Mauria on
2026-09-15 (13:34 to 13:39): what a seat received is preserved in the Claude Code
transcript (every call writes a `prompt_snapshot` record with the full system prompt, and
the user messages are the transcript; verified on run 003's IC session, and transcripts
are kept for 99999 days on this machine), so briefings are not stored; the tag says which
code rendered them. `pnpm build` writes `dist/runtime-version.json`, the commit of the
checkout it ran in (`src/runtime-version.ts`, run after `tsc`), and the store stamps
`RUNTIME`, read from that file beside the compiled module, on every event it writes; a
process running from source, or from a `dist/` without the file, stamps `unknown`.
`incident events` prints the tag where it changes between events and `incident review`
names the runtimes an incident ran under with the event range of each. Reproduction is
by hand, with no command: check out the tagged commit, `pnpm build`, replay the events
with `sequence` below the first event the call wrote into a fresh store (`Store.replay`,
with the system events), and call that build's renderer on the rebuilt store; the
transcript is the check that it rendered the same. The cut is the call's first event,
not its answer (`command.turned`, `plan.proposed`, `unit.reported`, `unit.continued`),
because a call writes events before it answers: an IC call records the session on the
unit as soon as its id is known (`leader.started`, the `unit.session` mutation) and,
after a handoff, the transfer with it, and a refused-then-retried turn writes
`command.failed` and the release first; a planner call writes nothing before
`plan.proposed`. The recipe feeds the renderers the store alone feeds: the change
report (`renderChangeReport` over the rebuilt store's events, incident and units) and a
leader's orientation (`renderLeaderOrientation` with the incident, the unit, the units
and the unit's own last picture from the events; never the IC's situation, R5-2), and the planner's input
(`renderPlannerInput`, which also takes the providers, from `getProvider` for the
unit's provider name under the same environment). A leader's turn prompt
(`renderTurnPrompt`) is not in the recipe: it takes the pass's in-memory state (the
cause, the tasks running) beside what the log gives (the endings the leader has not
heard, `unheardEndings`, R5-5), and the log records the state only as the task events it
was built from.

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
| `produces` | `evidence` for a deterministic capability, whose output is a fact about the machine kept whole under the task id (R5-1); `claims` for a session-backed one. |
| `cost` | Facts that live with the thing so they are at hand whenever it is equipped: rate limit, typical tokens, typical seconds, money per call if any. Equipment declares the same field. The budget logic reads these and nothing else. |
| `measure` | On a deterministic capability only (R5-1): one phrase counting its output, the evidence line every seat but the reading task sees beside the task id: grep `74 matches in 11 files`, read `120 lines`, git_history `10 commits, 7 working-tree changes, on main`, check_path `exists, a file`. A result the capability's schema no longer fits, or from a capability the registry no longer has, is measured as lines of JSON so an old record still renders. |

A capability with a session adds the fields that define its setup. The session names a
provider, and the provider renders the fields onto its own command from them:

| Field | Claude Code renders it to | Codex renders it to |
|---|---|---|
| `provider` | The choice of column. | The choice of column. |
| session preamble, fixed in `providers/base.ts` | The first part of `--system-prompt`, identical for every session on every provider and every seat; the planner's call carries its own system prompt in place of it, since it is the Planning Section and not a seat in the organization. It orients the session: this is an agentic runtime modeled on the Incident Command System; an incident is any objective Mauria asks to have pursued, not necessarily something gone wrong; a temporary organization of units is built around it and torn down when it is done; the IC sets objectives and priorities, the planner drafts an action plan each operational period, the IC approves it, a validator checks its shape, and the units run their tasks under their leaders and report. Then the mapping of terms, one line each: incident, Incident Commander, initial IC, unit, unit leader, task, capability, equipment, subagent, strike team, task force, claim with its statuses and bases, situation report, action plan, operational period, planner, transfer of command, grant, budget, SOP. Then the confidence scale and the four kinds of lack. Then the seat's place, one paragraph chosen per seat (`Seat`: `task`, `leader`, `ic`, `initial_ic`): a task session is a resource assigned to one task inside one unit under its leader, reports only against the task's contract, cannot change the organization, and answers `insufficient` naming the kind of lack; a leader owns one unit's objective, runs no task and holds no tools, receives each task's ending as a line, and after each ending continues or reports; the IC is the root unit's leader and Mauria's delegate, sets each period's objectives and priorities, reviews the planner's draft, reads the reports and closes or reorganizes units, and runs no task in its session and takes no leader turn, a task under command reaching it as a result in its change report (R4-6); the initial IC is the first session on the incident, sizes it up with read-only tools, hands command over with a briefing and decides nothing that lasts. Then the role text: a capability's for a task session, `LEADER_ROLE` for a unit leader, `INITIAL_IC_ROLE` for the initial IC (in `src/size-up.ts`: size up, write the briefing on ICS 201's lines; a check is one look at whether a thing exists, answers or is where the objective says, and what the incident turns on is for the units to establish under the IC; route the commander by the judgment the incident needs; the objectives, units and questions follow from the objective's verb, so a diagnostic objective takes no fix objective, no fix unit and no intended-behavior question; ask Mauria only what no tool could find and the objective does not settle), `IC_ROLE` for the IC (it scopes, breaks down, equips and judges; its digging is assigned, and no task runs in its session; command files no report and its lacks go through the command turn; its first act on taking command from a briefing is to evaluate it, and nothing in a briefing binds it; a period ends when units report or the picture changes; it declares `satisfied` when the period objectives and the incident objective are met by the reports; a `not_met` report's why and suggestion are information for its decision and never a decision; a discrepancy it cannot reconcile from the file becomes a question for Mauria; the situation stays the planner's; one review of a valid draft, corrected with patches and never for a rule). The hierarchy around the session (its unit and leader, who it reports to, what is below it) is rendered from the tree into the brief at call time, not fixed in the prompt. | Prepended to the prompt, since `codex exec` has no system-prompt flag in its help. |
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

The user message is the brief: the incident's objective and period, the hierarchy around
the owning unit, then the task (objective, inputs,
expected output, completion criteria, evidence required, instructions), the strike team the
task declares if any (each kind, its shape and why, and how to send and cite a member),
then the claims and results the task names in `evidenceFrom`, attached by the runtime, and
one line saying what the unit that owns this task is trying to establish. Nothing of the
IC's situation is in it (R5-2; R4-5 attached its hypothesis and proven list until then):
only objectives and evidence flow down, so a session tests the evidence and not a
hypothesis held above it. A leader's first call opens with its
orientation (the incident objective and period, the hierarchy, its unit's objective and
the equipment its tasks may use, and its own unit's last picture when it has reported
before; never the IC's picture) and every call is a turn (R5-4: no task runs on the
session; R5-5: a call happens only on a decision): the endings the leader has not heard,
each in one line with its claims by id, the ending that needs its decision or the report
owed, which ready tasks wait to start, which are still running, and the ask, under the
`LeaderTurn` schema.

v0 capabilities:

| Capability | Equipment | Session |
|---|---|---|
| `check_path` | `stat_path` | none; its output is evidence, measured as what the path is |
| `read` | `read_file` | none; its output is evidence, measured in lines |
| `grep` | `grep_files` | none; its output is evidence, measured in matches and files |
| `git_history` | `git_status`, `git_log` | none; its output is evidence, measured in commits and working-tree changes |
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
The IC is the leader session of command, the one unit of the `ic` type (R4-10, Step 6),
resumed at the top of every cycle with
its briefing under the `CommandTurn` schema, and again with the planner's draft under the
`ReviewTurn` schema; its system prompt (the preamble, the IC's seat and the unit's role
text, `IC_ROLE` unless its config carries its own) is
fixed at its first call, so everything that changes goes in the user message. Its turns
(`src/ic.ts`) are the ic protocol's; the type itself, its form and the root's pass, is
`src/units/ic.ts`. The briefing
is the change report since the IC last acted, then the incident file rendered as the
planner reads it, then the ask. The change report opens with every `picture.discrepancy`
raised since the IC's last turn, then every `unit.reported` (outcome, whether the picture
changed, what changed on which claims, and for `not_met` the why and suggestion), then,
when any task under command ended since, one block per task in the form of a report's
work (capability, objective, claims, then how it ended: a deterministic result's text
whole under the cap, since no leader reads the root's results and this block is the IC's
only view of them; a session result's summary, or what an insufficient result needed; a
failure's reason, with the tasks cancelled because they waited on it, R5-10), because no
leader reports on the root's tasks and the IC judges them
here (R4-6; the tasks listed are those ended since the IC's last accepted command turn,
the reports' window, so a rejected turn drops none of them from the retry), then, when
a task was settled in the window by a cancellation rather than a failure (a plan's
cancel, a reassign verdict's), the tasks cancelled because what they waited on will never
complete, each with its unit and the reason, since no failure in a report's work carries
them (R5-10), then every
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
each initial objective and each unit sketched, and a ruling on each question it proposed
for Mauria, listed by number; for a handoff document, each period
objective and priority, each unit's state, the hypothesis, each thing set aside and the
next move), and the turn is taken under `FirstCommandTurn`, the command turn with
`briefingEvaluation` and `briefingQuestions` required (one strict object, like every turn schema), so the
provider's own validation holds the IC to judging what it was handed before it sets the
period. The briefing's questions are proposals to the IC (round 5, R5-8; runs 003 and 004
each blocked at `create` on two intended-behavior questions the IC then discarded):
`incident create` records none of them as questions and the incident stays open; the IC
rules on each in `briefingQuestions` by its number, `accept` (the question becomes one the
IC raises, numbered before its own `questionsForHuman`, recorded on `question.asked` with
`proposals` naming its number and id, open, and it blocks the incident as an IC question
does), `discard` with a why (the ruling on the turn is its only record), or `answer` from
the objective, the constraints or the file (recorded as a question with the IC's answer,
and a `question.answered` by the actor `ic` with the answer and the why, so the change
report and section 8 show it answered and Mauria is never asked); a question the IC would
ask differently is discarded and raised in `questionsForHuman`. The validator holds the
turn to ruling on each proposal once (Step 5, "Proposals ruled"), and after an accepted
first turn none is pending, so a later turn's rulings are refused. `step` prints each
ruling with the question's text, `show` lists each proposal with what became of it, and
`review` does the same under the size-up and counts them at the end; a review that is the successor's first call carries the same `briefingEvaluation`
as an optional field of `ReviewTurn`, asked for the same way and
recorded on `plan.reviewed`. An incident with no pending transfer (`--no-size-up`, a failed
size-up, one migrated from before R3-8, or any turn after the evaluation was accepted) gets
the plain ask and the plain schema. The instruction lives in the user message because a
resumed call ignores `systemPrompt`; the IC's role text carries the general rule.

```ts
const CommandTurn = z.object({
  briefingEvaluation: z.array(BriefingVerdict).optional(),  // item, verdict (accepted | rewritten | discarded), why: each initial objective and unit sketched in the briefing the IC took command with; required on the first turn after a transfer (FirstCommandTurn)
  briefingQuestions: z.array(BriefingQuestionVerdict).optional(),  // R5-8: proposal (the question's number in the briefing), verdict (accept | discard | answer), why, answer (required with answer, refused otherwise, by a refinement after parse): a ruling on each question the briefing proposed for Mauria; required on the first turn after a transfer (FirstCommandTurn), empty after a handoff or when none was proposed; an accepted one is asked as the IC's, an answered one is recorded answered by the IC, a discarded one is only the ruling
  periodObjectives: z.array(z.string()).min(1),  // what this period must establish, from the incident objective, the constraints, the priorities and the reports
  priorities: z.array(z.string()),               // the incident's, restated or revised
  reportVerdicts: z.array(ReportVerdict),        // reportId (the report's event id, as the change report heads it), unitId, verdict (accepted | revise | reassign), instructions, why: one per unit that reported, naming its last report the change report lists (R4-2); instructions required for revise and reassign and empty for accepted, enforced by a refinement after parse
  situation: Situation,                          // R5-2: picture (prose, edited from the one section 10 showed), evidence (claim id and stance for | against), open (what, settledBy in prose, id only when carried forward from the last picture, deferred with a why when not worked this period), assessment (on_track | priors_updated | tactics_change, why), changed; the runtime numbers new open items <incident>-oNN when the turn is applied; read by the planner in full and by no unit
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
  questionsForHuman: z.array(z.string()),           // proposals to the IC (R5-8): only what no tool could find and the objective does not settle; the IC's first turn accepts, discards or answers each, and only an accepted one is asked
  hazards: z.array(z.string()),
  incomingCommander: z.object({ provider: z.string(), model: z.string(), why: z.string() }),  // recorded on the transfer as the recommendation and not followed (R5-6): the IC runs on --ic-model or the default, Sonnet 5
});

const PlanPatch = z.strictObject({               // one edit to a valid draft (R5-3); the refinement ties the fields to the kind
  kind: z.enum(["set", "add", "cancel"]),
  task: z.string().optional(),                      // with set or cancel: a draft task's ref, or #N, its position in createTasks as the review listed it; with cancel, an open task's id adds it to cancelTasks
  field: z.enum(TASK_FIELDS).optional(),            // with set: the task field to replace
  value: z.unknown().optional(),                    // with set: the field's new value, whole; the task is parsed again, so a wrong shape is a reason and not a crash
  proposal: TaskProposal.optional(),                // with add: the task to append
  why: z.string(),
});

const ReviewTurn = z.object({                       // read once per cycle, on a draft the validator has passed (R5-3)
  verdict: z.enum(["approve", "correct", "amend"]),
  patches: z.array(PlanPatch).optional(),           // with correct: applied to the draft by the runtime and validated again; no redraft, no second review
  plan: ActionPlan.optional(),                      // with amend: the whole plan as the IC wants it applied, validated again
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
with the turn, its situation on it with its open items numbered (R4-5, R5-2: the one the planner reads until the next accepted turn; a rejected turn's is skipped; the briefing's seed before the first), the call's session, model and usage, and the period as its mutation, then
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
2. Claims and evidence (R5-1): every claim a session asserted, each line showing its status and basis, its provenance and the evidence it cites; then one evidence line per completed deterministic task, the capability with the task's inputs clipped, and its `measure` (`001-t01 (grep {...}): 74 matches in 11 files`), which a task reads whole by naming the id in `evidenceFrom.tasks`. Run 004's file, which listed 162 grep matches and git facts as claims, rendered this way lists its 54 session claims and four evidence lines; the planner's input for its third cycle was 115k tokens against run 003's 17k.
3. The current unit tree with each unit's objective, status, leader model, last report outcome and the IC's last verdict on it (R4-2).
4. Tasks completed since the last cycle, each against its contract, with a session's findings (summary, observations, conclusion, reasoning) in full and the claims it produced by id, and a deterministic task's evidence as its measure with the task id (R5-1); then every task that will never complete since the last cycle (R5-10): each failure with its reason, and each task cancelled by the last plan or with a reassigned unit that something waited on, with the tasks cancelled because they waited on it, so the planner reissues the work in a form that can run rather than finding it stranded under open tasks.
5. Tasks that came back `insufficient`, each with what the session said it needed.
6. Unit reports since the last cycle: each unit's outcome, whether the picture changed, what changed on which claims, and for `not_met` the why and suggestion. (The unit's own slice picture reaches the IC in the change report, R5-2, and the IC folds it into section 10.)
7. Open tasks.
8. The capability registry, each with its description and the input fields a task to it must carry (name, type, required or default), and for each provider every model it serves with its cost, so every option is on the table and no task is proposed with inputs the capability cannot take; then the saved unit configs (R4-11), each by name with its type and fields (leader, equipment, Bash allowlist, whether it carries a role text of its own), which a new unit deploys by naming one in `config`; the preamble says to deploy one when it fits and fill the form by hand only when none does.
9. The rules the validator will apply, so the planner does not propose what will be rejected.
10. The IC's situation (R4-5; R5-2), from its last accepted command turn, or seeded from the briefing before it: the picture, the assessment with its why, what the turn changed, the evidence for and against with each claim's basis beside it (only `for, observed` proves a part of the picture), and the open items with their ids and state: worked by which tasks with their statuses, deferred with why, or unworked; "(none)" with neither a turn nor a briefing. The planner alone reads this section; no unit does. It ends with the ids of the reassignments still open (R4-4), each with the unit it came from: the IC wrote each into the slice it concerns, and every one is taken by a new unit in this plan naming it in `takes` (the rule "Reassignments taken", Step 5); "(none)" until the IC reassigns. Placed last because the provider caches the unchanged front of a prompt and this section changes every cycle.

Output:

```ts
const ActionPlan = z.strictObject({
  createUnits: z.array(UnitProposal),            // objective, parent unit, type (default base), leader (provider, model), modelWhy (optional, R5-6: why the leader is on an Opus or Fable model; warned on when missing), equipment, bashAllowlist, role (optional), config (optional, R4-11: the name of a saved config that fills leader, equipment, bashAllowlist and role, each of which may still be given to override it; without config the three are required, which the validator's rule Config exists enforces so a draft missing one is rejected and recorded rather than failing to parse), takes (optional: the id of an open reassignment this unit takes, R4-4)
  closeUnits: z.array(UnitClose),                // unit id, with a reason each
  createTasks: z.array(TaskProposal),// ref, unit, capability, objective, inputs, criteria, dependsOn (task ids or refs in this plan), evidenceFrom (claims by id, tasks by id or ref), instructions, provider, model, modelWhy (optional, R5-6: why the task is on an Opus or Fable model; warned on when missing), strikeTeam (optional: kinds the leader may send, each kind, model, tools, prompt, count, why)
  cancelTasks: z.array(z.string()),
  incidentStatus: z.enum(["continue", "blocked", "satisfied", "failed"]),
  questionsForHuman: z.array(z.string()),        // things only Mauria can supply; sets incidentStatus to blocked
  grantRequests: z.array(GrantRequest),          // capability, effect, and the reason it is needed; after v0
  capabilityRequests: z.array(CapabilityRequest), // means the planner lacks: what it would need and why; blocks the incident
  applySops: z.array(SopApplication), // SOP name, parent unit, the angles chosen; after v0
  rationale: z.string(),                         // why this plan and how it works the open items of the IC's situation; recorded on the action plan event, never acted on
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

`LeaderTurn` carries no strike-team request (R5-4 removed R3-5's `requestStrikeTeam`): a
team is declared on the task by whoever defines it, and a task the leader assigns carries
its team in its own `strikeTeam`, held to the strike team's three validator rules with the
rest of the assignment (Step 5) and written as `strike_team.defined` by `leader` when the
assignment is applied. Either move may carry `consult` (R5-5): task ids of the unit, or
refs of tasks in `assignTasks` on the same turn, whose ending the leader wants to be
called on however it ends; the ids are recorded on the turn's event and the refs,
resolved, on the `plan.applied` that creates the tasks, and the flag holds until the task
ends.

The planner proposes structure: the tactics for the period, drafted as a suggestion for
the IC against the situation the IC holds (R4-5; until then the planner wrote the situation
into each plan and read it back the next cycle). A task names the open items it settles
in `settles`, by id as section 10 lists them (R5-2), and `plan.applied` records each pair
(`settles: [{ taskId, openItemId }]`) so the validator and `show` know which open task
works which item; the IC's assessment is the planner's signal, `tactics_change` meaning
the units are redrawn rather than extended. It never runs a tool, never writes to the
store, and never marks its own conclusions true. Its rationale says how the plan works the
open items and names the priority that chose between the plans it could have drafted. A
unit's objective and a task's brief are written as what to establish, never as what the
IC believes, since no unit reads the IC's picture.

The validator checks the draft before the IC reads it (R5-3; ruled by Mauria 2026-09-15: a
model is called when a decision needs a model, never for process). A draft that breaks a
rule is recorded `plan.rejected` per rule, with the draft's ordinal in the cycle and
`corrected: false`, and the planner redrafts: its input is the same file with the rejected
draft and the reasons appended after section 10 (last, so the file's prefix still caches),
and `plan.proposed` marks the redraft with `cause: "rule"` and the reasons. A cycle allows
two redrafts, whatever their causes; a draft still rejected after them ends the cycle with
no review, and the next command turn's briefing lists the rejections. Run 004's IC found
one such break itself (a task named in `evidenceFrom` and not in `dependsOn`) and spent
a `correct` on it, which cost a redraft and a second review, $2.84 and 168 seconds.

The IC reviews a valid draft once, for substance: the prompt says the rules hold, lists the
draft's tasks by position and ref, and asks it to hold the draft to the period objectives,
its situation and the priorities, and, on every review (R5-7), asks whether the draft
serializes independent work: a unit or task left for the next period that could start now,
or a `dependsOn` on a task whose result the dependent does not name in
`evidenceFrom.tasks`, holds work behind work it does not need, and a code reading never
waits behind a reproduce it does not need; the IC corrects or amends such a draft naming
what runs together. The ask ends with the smallest-model line (R5-6): hold every session
task and every new unit's leader to the smallest model its kind of work needs, and do not
approve as drafted a task or leader on an Opus or Fable model with no `modelWhy`, or with
one the work does not bear out; correct or amend it to the smaller model. Run 004's review
approved a draft with every session and both leaders on Opus 5 and no reason given, for
work run 003 did on Sonnet 5. `approve` applies the draft as drafted. `correct` carries
`patches`: each sets one field of a draft task (named by ref or `#N`, positions as the
review listed them, so a cancel shifts nothing), adds a task, or cancels one (a draft task
by ref or position, or an open task by id, which goes to `cancelTasks`); the runtime
applies them (`src/patches.ts`) and validates the result, with no planner call and no
second review, and a patch that names no task or gives a field a value of the wrong shape
is a rejection of the correction under the rule `Patch applies`. `amend` applies the plan
the IC returned in place of the draft, validated the same way. A correction or amendment
that breaks a rule is recorded `plan.rejected` with `corrected: true` and goes to the
planner as a redraft with `cause: "correction"`: its input carries the draft, the IC's
verdict and rationale, the patches and the plan they gave (or the amended plan), and the
reasons, and the redraft is validated and applied without returning to the IC, inside the
same cap of two. `plan.reviewed` is recorded per read with the verdict, the patches or the
amended plan, and the call's usage; `plan.applied` carries the final verdict, the patches
(null unless the verdict was `correct`), and `diff`, how the applied plan differs from the
draft the IC reviewed: each array field of the plan compared as a set of items under a
key-sorted JSON serialization (a reordered item is no change, an edited one is removed and
added), and the other fields (`incidentStatus`, `rationale`, `discrepancy`) named in
`changed` when they differ; empty when the draft was approved as drafted. `incident review`
counts verdicts by kind, which is the evidence for cutting the planner if the IC never
changes its draft, and redrafts by cause (rule, correction).

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
reason recorded as a `plan.rejected` event and fed back to the planner as a redraft in the
same cycle (R5-3, Step 4), or as input 9 on the next cycle when the cycle's redrafts are
spent. The draft is checked before the IC reviews it, and the IC's correction or amendment
is checked again after:

| Rule | Check |
|---|---|
| Capabilities exist | Every task names a registered capability. |
| Units exist | Every task's unit and every new unit's parent is an active unit, or a unit created in this plan; a closed unit takes no new work. A `closeUnits` entry names a unit in the incident. |
| Type exists | Every new unit names a registered unit type a plan may create (R4-10): `base`, the led unit, is the only one, and the field's default, so a plan that names none passes; a type the registry lacks, or `ic` (the runtime creates command with the incident), is refused with the types a plan may create. |
| Config exists | Every new unit has a whole form (R4-11): one that names a `config` names a saved one, of the unit's type (a name `unit_configs` lacks is refused with the names saved, and a config of another type with both types), and one that names none fills its leader, equipment and Bash allowlist itself (a field left unfilled is refused naming it; the schema leaves the three optional so a saved config can fill them, and this rule, not a parse failure, is what a draft missing one meets, recorded as `plan.rejected` for the planner's next input). Checked first, on the plan as proposed: a unit whose config cannot outfit it has no form for the rules below to read, so such a plan is rejected on this rule alone, and the rest run once the planner names a saved config. A passing plan comes back outfitted, each new unit's leader, equipment, Bash allowlist and role filled from its config where the proposal gave none, and that is the plan every other rule reads (Model known reads the config's model) and `applyPlan` writes. |
| No cycles | The tree stays a tree: no new unit is its own ancestor, and a ref is used once, is not an existing unit id, and does not start with the incident id, so it cannot be mistaken for the id a unit created in the same plan receives. A task ref is held to the same three tests against task ids, and the new tasks' `dependsOn` form no cycle among themselves. |
| No duplicates | No new task repeats an open or completed one, or another new task in the same plan, with the same capability and effective inputs (as the capability's schema parses them) under the same unit. A task the plan cancels does not count. |
| Inputs validate | Task inputs parse against the capability's input schema. A task that takes evidence carries some: inline in its inputs, or by reference in `evidenceFrom`. |
| Paths exist | Every path input of a task to a deterministic capability (the fields the capability declares in `paths`: a grep's `root`, a read's `path`, a git history's `cwd`), as the capability parses it, resolves against the working directory the incident runs in (`ValidationContext.cwd`, the directory `step` and the dispatcher run in) to a path that exists; one that does not is refused naming the field, the value and the directory (R5-10). `check_path` is exempt (`pathsMayBeMissing` on the capability), since whether its path exists is its answer. Run 004's TipTap grep named `node_modules/@tiptap/core` at the root of a pnpm workspace, where the package lives under `packages/app/node_modules/`, failed with `ENOENT` in 4 milliseconds and stranded two dependents for a period; the rule's line to the planner says where a workspace package lives. Inputs that do not parse are Inputs validate's to refuse. Applied to a leader's assignments and the IC's `assignTasks` as to a plan's tasks. |
| Span of control | No unit ends the action plan with more than 7 direct children, units and tasks combined. Target is 5. |
| Effect policy | v0 rejects any capability whose effect is not `read_only`. A new unit's equipment names built-in tools, `default`, or registered external equipment, and its Bash allowlist only entries from the session command list in Step 3, which the planner's rule text names so a plan is never drafted outside it, so what the unit's tasks may use is read-only (the leader's own session holds nothing, R5-4). A strike team's `tools` name only the read-only built-ins (`Read`, `Grep`, `Glob`, `Bash`): no `Edit` or `Write` until grants exist. That a member's `Bash` is held to the parent session's `--allowedTools` allowlist is inferred from Claude Code applying permission rules session-wide, not tested on 2.1.272. After v0, a task to a capability whose effect is `writes_local` or `writes_external` passes only with a grant on this incident for that capability. |
| Budget respected | A task's budget, where it sets one, fits inside the incident's remaining budget. A session-backed task carries a time bound and, when the incident bounds tokens, a token bound. A deterministic task runs no model and needs neither. A strike team's `count` times the least a member spends (`STRIKE_MEMBER_MIN_TOKENS`, 600: the fixture's `pinger` with no tools read 672) fits the task's token bound where it sets one; a task with no token bound has nothing for the count to exceed. |
| Dependencies resolve | Every `dependsOn` names a task in the incident that is completed or still open and not cancelled in this plan, or the ref of a task created in this plan, so the new task can become ready. Every `evidenceFrom` claim exists, and every `evidenceFrom` task is completed or in the task's `dependsOn`, so its result exists when the brief is built. Every `cancelTasks` entry names an open task, once. |
| Model known | Every task to a session-backed capability, and every new unit's leader, names a provider and model pair. The known list is every model the provider serves, never a curated subset, so Mauria can ask for whatever she wants and the planner sees every option. For Claude Code the known list is every Anthropic model currently served: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`; Codex pairs are added when that provider is tested. A task to a deterministic capability has no model field at all, since nothing in it runs a model. A strike team's `model` is one the task's provider serves, and a team on a task that runs no session is refused here, since there is no session to send it from. These three rules, and nothing else, are what a strike team is held to, whether the plan declares it or a leader declares it on a task it assigns (the same checks run on a leader's assignments, R5-4). |
| Closing is clean | A unit closed in this plan is active, is not command (a unit of the `ic` type is never closed), has no running task after the plan's cancels, is closed once, and is given no new unit or task in the same plan. Demobilization is clean too: a unit whose leader has a session closes only after the leader has reported since the unit's last task ended (`unit.reported` after the last `task.completed` or `task.failed` under it); a unit whose leader never ran closes freely. A revision is delivered first (R4-3, added in review by the orchestrator, 2026-09-15): a plan may not close a unit whose last `revise` verdict has no `unit.revised` after it, since the plan drafted in the verdict's cycle would otherwise close the unit before its leader read the brief; the IC's own `closeUnits` is not held to this, since the close is the IC's decision and its verdict on the runtime's report for a unit whose brief was refused twice must be able to close the unit. |
| Status is earned | `satisfied` requires every open task completed or cancelled, no new tasks in the plan, and at least one claim with basis `observed`, whichever source produced it. `satisfied` or `failed` raises no question, capability request or grant request, since a closed incident answers none. `blocked` raises at least one, since nothing else could unblock it. |
| Open items are worked | Every open item of the IC's situation (R5-2: the one on its last accepted command turn, this cycle's; R4-5's "Inferred links are worked" until then) that the IC did not defer is named in `settles` by a task in this plan, or is already worked by an open task (recorded on an earlier `plan.applied`'s `settles`) that this plan does not cancel; a `settles` names only an item section 10 lists. An item left neither worked nor deferred rejects the plan, so a deferral is a decision the IC records, never an omission; a completed task no longer works an item the IC still lists, since the item is still open. The claims the situation names are the command turn's to answer for (Situation grounded, below). Checked on plans only. |
| Reassignments taken | Every open reassignment (recorded by a reassign verdict, not dropped, taken by no unit; R4-4) is named in the `takes` of exactly one unit created in this plan; a `takes` names an open reassignment, and no reassignment is taken twice. A reassignment whose verdict began its instructions with `drop:`, or that a later command turn dropped, is closed and takes nothing. A plan whose `incidentStatus` is `failed` is exempt, since a failing incident owes no taker; a `satisfied` plan is held to it, since the IC said the slice needed a different unit. Checked on plans only: a command turn creates no unit, and a leader's assignments create none. |

A plan the rules pass may still draw a warning (R4-6): the validator's verdict carries
`warnings`, each recorded as `plan.warned` with its rule, reason and the plan's rationale
in the transaction that would have recorded a rejection, printed by `step` after "plan
approved", and read by the planner in section 9 under "warned last cycle" beside the
warning's text under "warned on, and applied anyway". A warning never rejects: the plan is
applied as it stands. The warnings:

| Warning | Check |
|---|---|
| Independent work runs together | A task whose `dependsOn` names a task whose result it does not take in `evidenceFrom.tasks`, where that task is open or created in this plan (R5-7). The dispatcher (Step 6) holds the dependent, and so its unit's pass, until the dependency completes, and the dependent's brief carries nothing from it, so the wait is idle time. Run 004 did not exhibit this shape: every `dependsOn` in its plans was also in `evidenceFrom.tasks`, and its code unit sat out the 278 seconds of a reproduce on a real evidence dependency, a grep that failed in 4 milliseconds, which R5-10 settles; the warning guards the wait the dispatcher cannot tell from a needed one. A dependency already completed holds nothing and draws nothing; one that will never complete is Dependencies resolve's to reject. Warned, not refused, because a plan may order two tasks for a reason the runtime cannot see (two reproduces on one dev server), and the rationale carries it. The warning's text also says the half the validator cannot check: units and tasks with no dependency between them belong in the same period, so a unit that can start now goes in this plan and never the next; the IC's review asks the same (Step 4). |
| Session work under a unit | A task to a session-backed capability placed under the root, `command`. It runs in a session of its own with no leader turn after it (Step 6), so the IC judges its result from the change report instead of a leader's report; session work belongs under a unit with a leader. A deterministic task under command draws nothing. Told, not refused, because the work still runs and run 003 showed a rejection reshaping the organization (the planner traded its unit for a plan that could not be rejected). |
| Smallest model that fits | A task to a session-backed capability on an Opus or Fable model (told by name: `opus` or `fable` in the model's name, the tier priced 2.5x to 5x Sonnet 5) with no `modelWhy`, and a new unit whose leader is on one with no `modelWhy`, unless that leader was filled from a saved config (Mauria's choice, R4-11) rather than given by the plan (R5-6). The planner's rule of the same name says which work is Haiku or Sonnet work (recording, reproducing, reading, and a leader that directs such tasks) and which may take Opus (weighing evidence to a conclusion); the IC's review is asked to refuse the upgrade, so the warning is what the record shows when the planner and the IC both let one through. Told, not refused, because the plan still runs and a `modelWhy` is a judgment the IC is placed to make. Run 004's planner put every session and both leaders on Opus 5 with no reason in any rationale, at $3.76 over run 003's task sessions and $1.43 over its leader turns for the same work. |

The IC's command turn is checked by the same code as a plan that creates nothing, under
Units exist, Closing is clean and Status is earned, since closing units and setting the
status is all it does to the tree, with the units its verdicts close (accepted or
reassigned) folded into the closes those rules check, and its `assignTasks` (R4-6) as a
plan creating those tasks under the task rules a leader's assignments pass, plus the ic
type's own rule, Own unit, against command; and by six rules of its own:

| Rule | Check |
|---|---|
| Answers match | Every answer names a waiting unit and an open request that unit raised, as the change report showed it, and no request is answered twice; a permission request is not answered here, since only a grant answers it. |
| Reports answered | Every unit that reported since the IC's last accepted command turn has exactly one verdict, naming the unit and the event id of its last report in that window; no verdict names a report outside that window, a unit's earlier report in it, or another unit's report; and no reported unit is in `closeUnits` as well: an accepted or reassigned unit is closed by its verdict, and a revised unit stays (R4-2). Command files no report (R4-6), so every report in the window is a unit's, the runtime-authored report of a refused unit (R4-7) included. |
| Deterministic only | A task to a session-backed capability is refused with "the IC assigns deterministic work only, and session work goes under a unit", since the root's tasks run with no leader turn (Step 6) and session work is a unit's (R4-6). |
| Drops match | Every entry of `dropReassignments` names an open reassignment (recorded, not dropped, not taken), and none is dropped twice (R4-4). |
| Situation grounded | Every claim id the turn's situation names in `evidence` is a claim in the incident, and every open item that carries an id names an item of the picture the IC was shown (the last accepted turn's, or the briefing's seed), once; a new item carries no id and the runtime numbers it (R5-2; R4-5 checked `proven`, `inferred` and `keep` until then, which run 004's first turn failed by inventing claim ids where it had none). A claim marked `for` with basis `observed` is the only thing that proves a part of the picture, and the file's rendering says each claim's basis beside its stance; an inferred claim may stand as evidence, marked as such. A first turn with no claims passes with an empty `evidence` and its unknowns as open items. What works each open item is the plan's to answer, under Open items are worked. |

| Proposals ruled | Every question the briefing proposed for Mauria has exactly one ruling in `briefingQuestions`, by its number, while the briefing's evaluation is pending (until an accepted command turn follows `incident.briefed`; a rejected first turn leaves them proposed for the retry); no ruling names a number the briefing did not propose, and once none is pending a ruling is refused with "a question of your own goes in questionsForHuman" (R5-8). |

A failing rule is recorded as `command.rejected` and the cycle ends there (Step 4).

A leader's assignments (`assignTasks` on a `LeaderTurn`, R3-6) pass the rules above that
read tasks (Capabilities exist, Units exist, No cycles, No duplicates, Inputs validate, Paths
exist, Span of control, Effect policy, Budget respected, Dependencies resolve, Model known)
as a plan
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
Ready means every dependency is completed. A dependency that will never complete settles
the task instead (R5-10): when `task.failed` or `task.cancelled` is recorded, every
pending task that depends on it, and every pending task that depends on one of those, is
cancelled in the same transaction with `task.cancelled` carrying `because` and the reason
(Step 2), whether the failure is a run's, `failInterrupted`'s, or a plan's or a reassign
verdict's cancel (`cancelDependents` in `src/runtime.ts`, called at each of those sites),
so nothing waits on a task that will never complete and no pending task is left for the
planner to discover under open tasks; run 004's TipTap grep failed in 4 milliseconds and
its two dependents sat pending for the whole period with no event saying why, and PR 47's
review found a task depending on a cancelled task stayed pending forever. Dispatch runs the units to their reports, each
under its leader (round 3, R3-4), and runs unrelated units at once (round 4, R4-9): two
units are related when a task of one that has not ended names, in `dependsOn`, a task of
the other that has not ended, either way round, and related units run one at a time in
tree order (parents before children, siblings as created), as every unit did before R4-9; a
parent and a child are related only through their tasks. A unit's pass starts when the
unit has something to do (a runnable task, or a turn its type's protocol says it has to
take, `hasWork`; under the base protocol a revision brief to read, answers to its requests,
or a report owed), no
unit related to it is mid-pass, and fewer than `NOSCOPE_PARALLEL` passes are running (a
positive whole number read from the command's environment, 3 when unset, refused
otherwise); the cap bounds unit passes, and the tasks inside a unit are bounded by the plan.
The turns a unit takes in its pass are its type's protocol's (round 4, R4-10): the
dispatcher owns the scheduling, the starts, the landings, the budget and the halt, and
asks each unit's protocol at three points, `open` before any task starts, `ending` on each
landing, and `close` once every run has landed, each answering with the unit as it now
stands, the report it filed if any, whether the unit is done for the pass and whether the
picture changed; the dispatcher also asks the protocol whether the unit has a turn to take
this pass (`hasWork`). No task runs on a unit's session, whatever
its type (round 5, R5-4, ruled by Mauria on 2026-09-15: the leader directs and never
does, since a leader busy on a task cannot answer for its unit while the situation
changes, and a task's tool results in its context are paid for on every later turn; run
004's code leader grew from 34k to 100k context from three investigates run inside it and
could not be called for 494 seconds). What follows in this
step is the base protocol (`src/units/base.ts`), the led unit's. Under the ic protocol
(`src/units/ic.ts`, R4-6) command takes no turn at all: its runnable tasks run with no
turn between, a deterministic one in process and a session-backed one in a session of its
own, and so every runnable root task starts at once; its pass ends without a report
once its ready tasks have run, and the IC judges their results at its command turn, where
the change report lists them (Step 4). Run 003 is the reason: with every task under
`command`, the IC's own session took the investigate as an assignment and five leader
turns at 60k to 115k context cost $0.94. No `parentId === null` guard remains in the
dispatcher or the protocols: what the root does differently, it does as the `ic` type. A
unit's leader session is created at the unit's first turn, with no tools (`--tools ""`
on Claude Code, which disables every built-in; the IC's session holds none either since
R5-5, ruled at R5-4's review: its deterministic tasks run in process, so the `ic` form's
equipment and Bash allowlist are what the tasks under command may use, as the `base`
form's are):
its system prompt is the preamble, the seat's place and the unit's role text (its type's,
`LEADER_ROLE`, unless its config carries its own, R4-10), fixed for the
unit's life (a resumed call keeps the first call's system prompt), and its first user message
opens with the orientation: the incident, the period, the hierarchy and the
unit's own lines (its objective and the equipment its tasks may use), its own unit's last
reported picture when it has one (R5-2, so a replaced session starts from what the unit
last believed), never the IC's situation (R4-5 carried it until R5-2: observations flow
up and only objectives and evidence flow down), and, for a unit that took a reassignment (R4-4, `reassignment.taken`
naming it), the reassignment's id, the closed unit and its objective, the report the IC
reviewed, the IC's instructions and why, and the closed unit's claims by id, each with its
subject, predicate, basis and confidence when the store has it, so the leader starts from
what was found. In a unit, every runnable task not yet attempted starts at once: every
session task in a session of its own, each its own process, and a deterministic task in
process, whatever the leader's model and equipment, and they start together the moment
they are runnable, so `dependsOn` is what serializes tasks and a task with none waits for
nothing. The leader is called only on a decision (round 5, R5-5, Mauria's ruling: a
model is called when a decision needs a model, never for process; run 004's four
continue turns on completed endings produced 74 output tokens each for $1.81). The base
protocol's `ending` hook decides, and nowhere else: a task refused on both models files
the runtime's report (R4-7, below); a unit that reported this pass hears the ending on
its next turn; a `failed` ending, an `insufficient` one (a session that said it lacked
something: the task is completed in the store with the lacks as its result and no
claims, and the ending carries what it needed) and a `completed` one the leader flagged
`consult` (on the turn that assigned the task, by ref, or on any turn that saw it, by
id) call the leader at once, unless a turn already put that ending to the leader; every
other completed ending calls nobody: the runtime records `unit.continued` with
`writtenBy: "runtime"`, the task that ended and how many ready tasks start, so the log
shows the unit's progress, and the tasks the ending made runnable start. The leader is
also called on the IC's revision brief (below), on the answers to its requests, and at
`close`, once nothing is ready and nothing runs, when the unit owes a report (a task
ended, or was cancelled because a task it waited on failed (R5-10), after its last
report, this pass or an earlier one), unless the pass has halted.
Every turn is one call on the session under `LeaderTurn`, and carries first the endings
the leader has not heard (`unheardEndings`: those no turn of its own put to it, whether
they needed no turn, landed after it reported, or landed while a turn was in progress
and so were recorded before it but not in its prompt; a turn records the task ids it put
to the leader under `heard`, so hearing is by id, never by sequence), each as one line (a
session's summary or a deterministic result's size, then the claims the task produced by
id with their basis, a session's each with its subject and predicate and a deterministic
task's as a count and a range; an insufficiency with what it needed, each with its kind,
and what the leader does about each kind, R3-6; or the failure with its reason and the
tasks cancelled because they waited on it, and that nothing of the unit's waits on it
now, R5-10; the result itself stays in the task record, which a task the leader assigns
reads through `evidenceFrom`), then what the turn is for, which ready tasks wait to
start, and which tasks of the unit are still running in sessions of their own;
`continue` starts what is runnable and what the leader assigned, `report` files
`unit.reported` (the outcome, what changed on which claims, whether the picture
changed, and the unit's own picture of its slice, R5-2: `situation` with its picture,
evidence for and against by id, open items with what would settle each, and what
changed since its last report; the change report renders it under the report for the
IC to fold into the whole, and the report the runtime writes for a refused unit carries
one saying nothing was established) and ends the unit's pass while its tasks in flight
finish and land, their endings kept for the leader's next turn, and `pictureChanged:
true` on a report ends the whole pass, which `dispatch` returns as the unit's id, so the
IC's next change report opens with it: from that moment nothing new starts anywhere,
and every run in flight finishes and lands before `dispatch` returns, each landing
recorded by the runtime and heard on the leader's next turn. Either move may carry
`assignTasks`: after the turn
is recorded the assignments are validated (Step 5) and applied under the unit as
`plan.applied` with the actor `leader`, the unit and session named, the task ids and,
under `consult`, the ids of those the leader named by ref (R5-5), and
the ready ones run in this pass on a continue and next pass on a report, which ends the
unit's pass; a refused assignment creates nothing and its reasons open the leader's next
prompt. Either move may carry `consult`, the task ids of the unit the leader wants to be
called on when they end; they are recorded on the turn's event. A report may carry `resourceRequests` (`permission`,
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
leader is asked for its report; with nothing left to start but tasks still running, it is
asked to continue and wait for them or report now, and the turn names them; a leader
that answers `continue` when asked for its report is asked once more at `close`, and a
continue there ends the unit's pass without one, so the next pass asks again. The
endings a leader has not heard (tasks that completed, failed, or, R5-10, were cancelled
because a task they waited on will never complete, each rendered with the task it waited
on and why, except one whose root is a failure listed on the same turn, which that
failure's line already names) ride on its next turn, whatever that turn is for, rendered
before it as each ending renders; a unit that owes a report (a task ended after the last
report: completed, failed, or cancelled by that cascade, R5-10, since the cascade is no
decision of the leader's, where a cancel by a plan or a reassign verdict is a decision
above the unit and owes nothing) and has nothing to run is asked for it at `close` of the
pass in which the ending landed or at the start of the next, the turn creating the
session if none exists, so a result never goes unread by the leader whose next turn
comes, and a unit whose ready work was all cancelled this way reports on that rather than
sitting idle until the IC closes it (its owed turn is one of the decisions a leader is
called for). The report the runtime writes for a unit after two refusals (R4-7) and the
`unit.continued` it writes for an ending that needed no turn (R5-5) are not turns of the
leader's and hear nothing, so the endings they passed over ride on the leader's next real
turn, with a failure, a task named in `consult`, the IC's revision brief (R4-3) or the
report owed; until then the IC reads them in the change report. Every turn is one call on
the leader's session, recorded as `unit.reported` (with the report) or
`unit.continued`, each with the unit, the session id, the leader's provider and model,
the call's usage, `heard` and `consult`; `leader.started` records the session
on the unit at its first turn, with the `cwd` it was launched from; `unit.closed`
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
(`replaced`) and `fallbackFrom`. For a task session the task itself is retried once, in a
fresh session on the fallback, the refused call filed on the
task (`task.usage` with the refusal, its activity) and the retry's outcome carrying both
models; the leader's session is untouched, since no task ran on it (R5-4). A refusal on the fallback, or a refusal after the fallback has been tried for that
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

A task's strike team (R3-5) is provided to the task's own session as the request's
`strike_team`, which the provider defines for that call alone (Step 3) and never on a
turn. The brief says what the task declares (each kind, its shape and why, how
many to send), that a kind is sent by name through the session's agent tool, and that a
claim resting on a member's finding cites the member's `agentId` in its evidence, which is
what the agent tool's result shows the session (the fixture's `Agent` result carries
`agentId: <id>`, captured 2026-09-15). A team is declared by whoever defines the task
(R5-4): a task the leader assigns carries its own, validated with the assignment.
`strike_team.defined`
carries the task, the unit, who declared it (`plan`, written by `applyPlan` beside
`task.created`, or `leader`, written by `applyLeaderTasks`) and
the kinds; `strike_team.rejected`, which R3-5's turn request wrote with its `reasons`, is
written by nothing since R5-4 and still reads from an older log. A member's run is the `subagent.ran`
the provider already files under the task, its `agentType` the kind's name, so review joins
declaration to run on task id and kind.

Each task's run, wherever it ran, writes `task.started`, then the result and
`task.completed` or `task.failed` in one transaction, with a `task.usage` event carrying
what the run spent (and, on a failure, the `task.cancelled` of every pending task that
waited on it, R5-10), and every event keeps its own timestamp, so concurrent runs cost as
they did in sequence and `incident review` reports each cycle's wall time beside the sum
of its tasks' seconds (R4-9) and the cycle's critical path (R5-7):
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
(`FirstCommandTurn`, whose `briefingQuestions` is empty after a handoff, since a handoff
document proposes no question) and optional on a review that is the successor's first call. The
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
cycle 0 and `seat: "initial_ic"`), `toolUseId`, the tool name, the full input, the result clipped at 4,000 characters
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

The verifier turns a session's result into claims; a deterministic run's output is evidence
and never a claim (round 5, R5-1). A deterministic capability's output, parsed through its
schema, is recorded whole as the task's result on `task.completed`, and the effective
inputs the run used (as parsed, defaults applied, every path field resolved against the
incident's working directory, `paths` per capability) are written on that event's payload
as `inputs`, the evidence's provenance, so the record says exactly what ran where the
task row holds the inputs as the plan wrote them; no `claim.*` event is written for it,
and the dispatcher's pass summary prints its `measure`. A session-backed capability's result becomes `asserted` claims with
the session id as provenance; a session names the basis of each of its claims, and a
result without one does not fit the schema. A claim that rests on attached evidence names
the deterministic tasks it cites (`cites` on the proposal, carried into the provenance),
and the verifier keeps the session's basis only when every cited task is a completed
deterministic task named in the reading task's `evidenceFrom.tasks`, since that is the
only way the session saw the evidence; a claim citing a task the brief did not carry enters
`inferred`. A claim can only enter the store `asserted`, with the session that asserted
it; the `verified` status and the `claim.verified` event survive in the schema so a record
from before R5-1 replays (run 004's 162 verified claims are read and listed by no seat).
An `insufficient` result becomes no claims and a `task.insufficient` event carrying what
was needed. A claim's status never changes after entry, and basis `observed` alone is what
proves a part of the IC's picture and what `satisfied` rests on (Step 5). Rounds 1 and 2 had promotion on a
deterministic match, asked for through `claimsToVerify`; it fired in neither live run, so
it went in round 3.
### Step 7: the command surface
| Command | Does |
|---|---|
| `noscope incident create "<objective>" [--constraint ...] [--priority ...] [--budget-tokens N] [--budget-seconds N] [--initial-model <model>] [--ic-model <model>] [--no-size-up]` | Creates the incident and its root unit, `command`, with the read-only built-ins as its equipment, then runs the size-up (R3-8): the initial IC on `--initial-model` (default `claude-haiku-4-5`) reads the objective, the constraints, the priorities and the runtime's own findings with the read-only tool set and writes the incident briefing, recorded as `incident.briefed` with its tool calls; command then transfers to the IC proper on `--ic-model` or the default, `claude-sonnet-5` (R5-6), recorded as `command.transferred` with the briefing as its document and its `incomingCommander` as the reason, the initial IC's recommendation recorded and not followed. Prints the briefing and the transfer. A question in the briefing is a proposal to the IC (R5-8), printed as such: the incident stays open, and the IC's first turn accepts, discards or answers it. `--no-size-up` creates the incident on `--ic-model` or the default with no briefing, for tests and for incidents that need none. A size-up that fails is filed as `command.failed`, the incident stands unbriefed on `--ic-model` or the default, and the command exits 1. `--priority`, like `--constraint`, may repeat; the priorities are an input the IC restates or revises each period and the planner's rationale names when one chose between plans. |
| `noscope incident show <id>` | The incident file: objective, constraints, priorities, the current operational period's objectives and priorities, then the IC's situation from its last accepted command turn, or the briefing's seed before it: the picture, the assessment, what changed, the evidence with each claim's basis, and the open items with their state (worked by which tasks with their statuses, deferred with why, or unworked), with the reassignments still open under it (R4-5, R5-2), budget and spend, the IC's provider, model and current session with the number of transfers of command and every model change the log records (R4-7: each transfer of command with its kind, models and reason, each unit leader moved to the fallback after a refusal, each task retried on it), every unit on a line with its status, objective, type, the saved config it was deployed from when it was (R4-11), leader model, last report outcome and the IC's last verdict on it, as `tree` prints them, then the claims sessions asserted, counted by basis and one line each, and the evidence, counted and one line per completed deterministic task with its measure (R5-1), open tasks, decisions with reasons, each unit's last report with the work behind it as the IC's change report showed it (R4-1; clipped per task at `NOSCOPE_REPORT_WORK_CHARS`), the questions the briefing proposed with what the IC made of each (R5-8: accepted and asked under which id, discarded with the why, answered by the IC with the answer, not yet ruled on, or asked at create by the initial IC in a log from before R5-8), questions waiting on Mauria and capability requests (each naming the unit that raised it, when a leader did), the units waiting on a resource request with what each waits on, grants, registered capabilities. |
| `noscope incident tree <id>` | The unit tree with each unit's type (R4-10), the saved config it was deployed from when it was (R4-11), leader model, last report outcome, the IC's last verdict on it (R4-2), and, for a waiting unit, what it waits on, and task marks: done, running, ready, pending. |
| `noscope incident step <id>` | One cycle, then stop. Prints a handoff when one runs (the outgoing session, the context that triggered it, the threshold, and the transfer once the successor has answered), the IC's command turn (its verdicts on a briefing it took command with and its ruling on each question the briefing proposed (R5-8), objectives, priorities, its verdict on each report with the why and instructions, closes, each reassignment recorded with its claim count or dropped, the reassignments dropped on this turn with the why, the tasks a reassign cancelled and the tasks of other units cancelled because they waited on one of those, each with its reason (R5-10), answers, what it raised, status), a transfer of command to the fallback model when a refusal forced one during the turn or a review (R4-7), the planner's draft, the validator's rejections and each redraft with its cause (R5-3), the IC's verdict with its patches or amended plan, the plan as corrected, the validator's verdict, the units created (a taking unit with the reassignment it takes, R4-4; a unit deployed from a saved config with the config's name, R4-11), the offer to save a repeated config (R4-11: after the plan is applied, each new unit filled by hand is compared with every unit in the file, across incidents, and when the same filled form has now appeared three times or more unsaved with no saved config matching it, one line per distinct form names the unit, the form and the `config save` command to run; nothing is saved by `step`), the tasks a plan's cancel settled with their reasons (R5-10), what ran (a failure with the tasks cancelled because they waited on it), each unit's report with any resource request it sent up, the tasks each leader assigned, any discrepancy raised, and whether a report stopped the pass. When the IC is refused on its model and on the fallback, prints that the incident is blocked, the question, and the `answer` command that resumes it, and exits 0 (R4-7). |
| `noscope incident run <id> [--max-cycles N]` | Repeats `step` until the incident leaves `open` or the cap is hit; the IC's double refusal stops it the same way. |
| `noscope incident events <id>` | The event log with timestamps and actors, headed by the runtime tag (R4-12) and showing it again wherever the next event was written by a different build. |
| `noscope incident review <id>` | The After Action Review computed from the event log: the size-up when there was one (the initial IC's call with its usage and tool calls, what the briefing said in numbers, whom command transferred to and who chose the model, or the size-up's failure; each question it proposed with what the IC made of it, R5-8), then each cycle (cut at the IC's command turn; at `plan.proposed` in a log from before the IC) with its verdict, the IC's command turn (with its situation's assessment under it, R5-2, so a run reads as a story of priors held, updated or overturned, then its verdict on each report: the unit, the verdict, its why and instructions), reviews and handoff call with their usage, each transfer of command with the context size that triggered it, the document's length and its evaluation, or, for a fallback, the models, who chose the new one and the refusals (and their count at the end), each draft's planner call (a redraft marked with its cause, R5-3), rejections (a rejection of the IC's correction marked as such), tasks run (capability, model, tokens with the cache split, seconds, cost, and a session task's claims with how many are inferred or a deterministic task's evidence measured, R5-1; a failure's reason, then the tasks cancelled because they waited on it, R5-10), the cycle's wall time beside its dispatch span, the sum of its tasks' seconds, `parallel` (the sum over the span: 1.0 in sequence, higher when tasks overlapped) and the critical path (R5-7: the chain of dependent tasks among those that ran in the cycle whose seconds sum highest, its tasks named in run order, and `possible`, the sum over the chain, an upper bound on `parallel`, what the plan's dependencies allowed, which `parallel` never reaches since its span also holds the leader turns; a dependency that completed in an earlier cycle is off the chain), each leader's turns with their usage and outcome (a refused turn priced and named by its category, with the leader's move to the fallback; a report the runtime wrote after two refusals listed as such), a task's refused call priced and named with the model it was retried on, the resource requests it sent up and the tasks it assigned or was refused, discrepancies, strike teams declared or refused, questions and answers; totals by role and model (the IC under `ic`, the initial IC under `initial_ic`, leaders under `leader`); plan (with redrafts by cause, rule or correction, R5-3), IC-verdict (by kind: approve, correct, amend, a correct with its patch count), report-verdict (R4-2: by kind, accepted, revise, reassign, for the incident and per unit), revision (R4-3: each revise delivered, with the turns and tasks between the brief and the report that answered it, their tokens, seconds and cost, the outcome before and after, and the report's changes not in the reviewed one, or that it is not yet reported; each delivery is also listed in its cycle with the instructions, and a report that answers a revise is marked with its number), reassignment (R4-4: each recorded, with the closed unit, the cycle, its claim count, whether it was taken and by which unit, dropped by the IC with the why, or is still open, and the instructions; the recording, the taking and a later drop are also listed in their cycles), briefing-kept (the verdicts on the IC's first accepted command turn that evaluated one: accepted, rewritten, discarded, of how many items; or that none was evaluated yet, that there was no size-up, or that it failed), briefing-questions (R5-8: how many were proposed and how many the IC accepted, discarded or answered, or that none was proposed or none ruled on yet, and in a log from before R5-8 how many were asked at create by the initial IC; an answer the IC gave is listed in its cycle as answered by the IC), task and leader-turn counts, the claims sessions asserted by basis beside the deterministic results recorded as evidence (R5-1), each unit's reports by cycle, each declared strike-team config against what ran under it (members, usage, cost, claims citing a member), and lacks resolved at a leader against those sent up; every refusal per seat with its category, model and session; the runtimes the log was written under (R4-12: each tag with the range of events it wrote, in the order the log switches between them, an untagged range named as such); the units deployed from saved configs, each named under its cycle with the config it came from and counted at the end (R4-11); the cost, recorded where the provider priced it and bounded at list rates where it did not. Deterministic; the judged review is the session-backed `review` capability, after v0. |
| `noscope incident sop <id> <name>` | Adds an SOP's unit and its tasks to the incident in one action plan. After v0. |
| `noscope incident answer <id> "<text>"` | Answers the oldest open question, the IC's, the planner's or a unit leader's (a briefing question the IC accepted is the IC's; one it answered itself is not open, R5-8); the IC's next change report carries the answer. A unit's question answered returns that unit to `active` once nothing of the unit's is open; the incident returns to `open` only when a command turn or a plan had blocked it and nothing of theirs still waits. While the incident is blocked on the IC's refusals (R4-7), the answer goes to the question the refusals raised, whatever older questions of the units are open, and one naming a model Claude Code serves, as a whole word anywhere in the text, transfers command to it and reopens the incident; any other answer is stored, the question is asked again and the incident stays blocked, with a hint listing the models. |
| `noscope incident provide <id> "<text>"` | Answers the oldest unanswered capability request, the IC's, the planner's or a unit leader's, with what was provided, or why not. A unit's request answered returns that unit to `active` once nothing of the unit's is open; the incident returns to `open` only when a command turn or a plan had blocked it and nothing of theirs still waits. |
| `noscope incident grant <id> <capability> [--per-task]` | Gives a grant for one capability on this incident, recording the planner's reason; `--per-task` makes each task under it ask again. After v0. |
| `noscope grant standing <capability>` | Whitelists a capability everywhere. After v0. |
| `noscope config save <incident> <unit-id> <name>` | Saves the unit's config under the name (R4-11): its type and its filled form less the objective and the parent (the leader's provider and model, the equipment, the Bash allowlist and, when the unit has one, its role text), with when and from which unit and incident it was taken, as the system event `config.saved`. A name is saved once: a taken name exits 2, an unknown incident or unit 4, and a unit of a type a plan may not create (`ic`: command) 2, naming the types a plan may create, since no plan could deploy its config. Prints the config's fields and how a plan deploys it. |
| `noscope config list` | Every saved config on one line each: name, type, fields, when and where it was saved from. |
| `noscope config show <name>` | One saved config in full: name, type, where and when it was saved from, each form field, the role text whole. Exits 4 for a name not saved. |

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
when an observed claim names the code path.
### v0 acceptance
v0 is done when all of these hold on the first incident:

1. `incident create` produces an incident with one root unit, `command`, and one event.
2. The first `step` yields an action plan that creates at least one unit and one task, and the validator accepts it.
3. Tasks run: a session's result appears as asserted claims, a deterministic task's as evidence under its task id (R5-1).
4. A later `step` closes a unit that has served its purpose, visible in `tree` and `events`.
5. An action plan that breaks span of control is rejected and the next action plan groups instead.
6. The incident reaches `satisfied` with an observed claim naming the code path.
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
| The API can refuse a resumed call outright, and the refusal sticks to the session: Claude Code writes a `system` line with `subtype: "model_refusal_no_fallback"`, the category and the explanation, a synthetic assistant message with `stop_reason: "refusal"` and `stop_details` repeating them ("API Error: Opus 5's safeguards flagged this message ... Try rephrasing the request in a new session or change your model"), then exits 1 with a result whose `stop_reason` is `refusal` and whose usage is the refused call's; the next call on the same session is refused again in under a second. The category's key is spelled by the record: the stream's system line carries `api_refusal_category` and `api_refusal_explanation` (the SDK message shape), the session's transcript under the project directory carries `apiRefusalCategory` and `apiRefusalExplanation` on the same line. | The third live run (R3-10, 2026-09-15, Claude Code 2.1.272): the IC's command turn on Opus 5 succeeded at 23k of context, its review turn over the planner's draft (another model's output) came back with category `reasoning_extraction`, and the next step's command turn on the same session refused identically; IC session `cf551f26`. The cause of the category on a review turn is not known; R3-10a replaces a refused session rather than resuming it. The spelling: R3-10a read `apiRefusalCategory` off the stream and the run's `command.failed` events recorded `unstated` with an empty explanation, while the transcripts of sessions `cf551f26` and `a30d1d7f` carry `apiRefusalCategory: "reasoning_extraction"`; the stream's `api_refusal_category` is the binary's own serializer for the SDK system message, read from 2.1.272's code on 2026-09-15 (R4-7), not seen live, so R4-7 reads both spellings, the assistant's `stop_details`, and the transcript when the stream names no category. Claude Code has a refusal fallback of its own (`model_refusal_fallback`, per-category routing; its `no_fallback` line is what a call gets when none is configured), which the third run's sessions did not have; the runtime's fallback (Step 6) is its own. Seen a second time in the fourth run (R4-13, 2026-09-15, IC session `8bdd1c8a`): two command turns on one Opus 5 session passed, the second of them resumed, and the review turn over the planner's draft was refused with the same category in 1.1 s; R4-7's provider recorded `reasoning_extraction` on the `command.failed` event where run 003 recorded `unstated` (which of the stream or the transcript carried it is not on the event), and the fallback ran the incident's five remaining IC calls on Opus 4.8, review turns among them, with no refusal. |

### Model choices
| Role | Model | Because |
|---|---|---|
| Planner | `claude-opus-5` | The action plan is the judgment in the system; Opus 5 is the default for anything nontrivial, and it ran the test action plan well. |
| Initial Incident Commander, the size-up | `claude-haiku-4-5` by default, `--initial-model` at `create` overrides | The size-up is a read of what the objective points at and a sketch, cheap by design; whatever it thinks is evaluated by the IC proper, so a wrong guess costs one turn's worth of judgment and no authority (ruled by Mauria, 2026-09-15). Its briefing is scoped to the objective's verb (round 4, R4-8): an objective that asks to determine, identify, explain or find, or asks a question (where, what, why), is a diagnosis and takes no fix objective, no fix unit and no question about intended behavior, since the answer is the cause; one that asks to build, change, fix or add is a build and takes them; and a question for Mauria is only what no tool could find and the objective does not settle. Both size-ups of run 003 proposed a fix and asked what the intended behavior should be on a diagnostic objective, and the IC discarded them at the cost of a question round each time. The fourth run's size-up (R4-13) proposed no fix objective and no fix unit and still asked two intended-behavior questions, so the clause on questions did not hold on Haiku; since round 5 (R5-8) its questions are proposals to the IC, which gates them, so a question it should not have asked costs the IC one ruling and Mauria nothing. |
| Incident Commander, the root unit's leader | `claude-sonnet-5` unless `--ic-model` at `create` names another (round 5, R5-6); the briefing's `incomingCommander` (R3-8) is recorded on the transfer as the initial IC's recommendation and not followed | Ruled by Mauria, 2026-09-15: Sonnet 5 for the IC. Run 003's Sonnet 5 IC did the same work as run 004's Opus one, five calls for $1.28 against eight for $5.83, and Opus 5's safeguards refused the IC's resumed review turn in both runs 003 and 004 (Reference table) where Sonnet 5 was never refused. Until R5-6 the briefing routed the IC, and both size-ups that recommended Opus did so for work Sonnet did. The IC's first act is still to evaluate the briefing, so the model it runs on never inherits a cheaper model's conclusions. |
| The fallback for a refused seat: the IC, a unit leader, or a task session | `claude-opus-4-8`; `NOSCOPE_IC_FALLBACK_MODEL` overrides it for every seat | Ruled by Mauria in review, 2026-09-15: a refused call is retried once, deterministically, on Opus 4.8, and a second refusal goes to judgment (the IC's for a unit, a question to Mauria for the IC). The retry is a change of model rather than of wording because the refusal sticks to the session and the cause of the category on a review turn is not known (Reference table); the fourth run (R4-13) tried it: five IC calls on Opus 4.8, three review turns (two drafts and a redraft) among them, and none refused, at $4.94 for the five against Sonnet 5's $1.28 for run 003's five. |
| Unit leaders | Named per unit by the planner, any model the provider serves, the smallest that fits (R5-6): a leader directs its tasks and judges their endings, which is Haiku or Sonnet work; an Opus or Fable leader carries a `modelWhy` or is warned on | A leader directs and never does (R5-4) and is called only on a decision (R5-5), so its model is chosen for the decisions it makes (what to do about a failure or a lack, whether to report) and never for its tasks' work, which runs in sessions of their own on the models the tasks name. Run 004's two Opus 5 leaders made six leader turns cost $2.37, against run 003's five Sonnet turns at $0.94; four of run 004's turns were continues on completed endings, 74 output tokens each for $1.81, which R5-5 no longer makes. |
| `investigate`, `interpret`, `reproduce` | Named per task by the planner, any model the provider serves, the smallest that fits (R5-6): recording, reproducing and reading are Haiku or Sonnet work, and weighing evidence to a conclusion may take Opus; a task on an Opus or Fable model carries a `modelWhy` or is warned on, and the IC's review refuses an unreasoned upgrade | No defaults, ruled 2026-09-12; smallest that fits, ruled 2026-09-15. Run 004's reproduce on Opus 5 cost $1.85 for the same shape of work as run 003's on Sonnet 5 at $0.59 (37 tool calls in 278 s against 34 in 268), and nothing in the planner's rules or the IC's review had asked for fit. |
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

So one cycle as written is the IC's command turn and review, two resumed calls on a
context that grows with the file, plus the planner, about 15 to 20 s, again on a rule
break (R5-3: the validator runs before the review, and a correction is patched by the
runtime with no planner call), plus its tasks, each session-backed one roughly 7 to 30 s and each
deterministic one negligible. Through round 3 the tasks ran one after another, and an
incident that took five cycles with two sessions each ran three to four minutes; that was
slow for a daemon and right for v0, which is stepped by hand to be watched. Since R4-9
(Step 6) unrelated units run at once, up to `NOSCOPE_PARALLEL` passes (3 by default), and
inside a unit the tasks in sessions of their own start together, so a cycle's task time is
the longest chain of dependent tasks rather than the sum; `incident review` prints each
cycle's wall time, its dispatch span, the sum of its tasks' seconds and their ratio; the
fourth run (R4-13) measured it at 0.92x in both cycles that ran tasks, since each cycle had
one unit doing session work and the code unit's three investigates, two of them
independent, ran inside its leader's session one after another (`docs/first-incident.md`).
Since R5-7 the same line names the cycle's critical path, the longest chain of dependent
tasks by their seconds, and `possible`, the summed seconds over it, an upper bound on the
measured factor, what the plan's dependencies allowed, so the measured factor is read
against it: run 004's period 1 would read 278 seconds of path for 278 seconds of work,
1.00x possible, since the reproduce was the only session task that ran while the code
unit's reading waited on a grep that had failed at once; period 2 would read 375 seconds
of path (the grep, the 257-second investigate, the 118-second interpret) under 612
seconds of work, 1.63x possible against the 0.92x measured, the gap being the two
independent investigates that ran in sequence inside the leader's session. The planner's
warning "Independent work runs together" (Step 5) and the IC's review ask (Step 4) are
what move the possible factor; R5-4 is what moves the measured one toward it.
Since R5-4 no task runs inside a leader's session, so two independent investigates under
one unit run at once. The startup cost per session
stays unless sessions are reused with `--resume`,
which the provider supports since round 3 (R3-3) and unit leaders use (R3-4): a resumed
Haiku call with a fixed schema read its earlier turns from cache in most runs and rewrote
them in the rest (2026-09-15; the Reference table has the counts), so a resumed call's
input cost is bounded by the whole context at cache-write rates, not by the new turn.
## Open questions
| What is undecided | Needed for v0? | What waits on it, and what the build assumes meanwhile |
|---|---|---|
| A Situation Unit: ICS gives it the job of collecting and summarizing the situation so command sees a picture rather than raw reports. Here it would be a periodic session-backed capability that reads the incident file and writes a situation summary, for keeping perspective across many cycles and for triage when noscope runs with little supervision. Whether it earns a call of its own or folds into the planner's input rendering is the question. | No. Since R4-5 the IC writes the situation on every command turn, and since R5-2 each unit leader reports its slice's picture up and the IC folds the slices into the whole, so the summarizing ICS gives a Situation Unit is done by the leaders and the IC; a Situation Unit would be a seat that drafts the fold for the IC, as the planner drafts the tactics. | Autonomous incident cannot be designed until this is settled; v0 is stepped by hand and the incident file is the picture. |
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
