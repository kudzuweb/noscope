# Handoff: noscope, from the idea to PR 6

Written 2026-09-13 00:20 CDT by the session home-laptop:~/.claude/projects/-Users-mauriaparker/26e50a66-d147-4afe-b214-2080346affdc.jsonl (itself a fork of 81e5955c-083d-4aa9-83fa-e1e626c32953, which holds the quipu-cli reframe context and sits idle). Read this whole file before doing anything. It is written so the next session is the previous one without the back-and-forth.

**First action: name this session `noscope-build`** (the session name, so other sessions can address it with SendMessage). The previous session appears in `ListAgents` as "ChatGPT conversation review ⑂" (Mauria named it "agentic-ics"); it is still running the PR 5 and PR 6 code reviews and will send their results to `noscope-build` as cross-session messages once Mauria says this session is up. Treat those messages as the review findings described in §4 and §5.

## 1. GOAL

Build noscope v0, an agent runtime with the Incident Command System (ICS) as its primitive, by working through the fifteen PRs in `BUILD-PLAN.md` at `~/Documents/Projects/noscope`, merging each as it passes CI and review. After v0 works, Mauria uses noscope itself to work on roughdraft, quipu and her codebase scan, and only then builds a new Agent Dash board for it.

## 2. HOW THIS STARTED, AND WHY IT IS SHAPED THIS WAY

On 2026-09-12 Mauria asked this session to read a ChatGPT share (https://chatgpt.com/share/6aa59980-2f4c-83e9-80b5-6f69a05147b5; full transcript preserved at `~/Documents/Projects/my-quipu/assets/ics-runtime/chatgpt-police-response-on-9-11.md`). It began as "what were the police doing on 9/11", ran through the WTC's fragmented command (three agencies, separate command posts and radios, named by the 9/11 Commission as a systems failure) versus the Pentagon's mature ICS response (Arlington County Fire took command, ordered everyone out two minutes before a collapse, held command ten days), then the origin of ICS in FIRESCOPE after the 1970 California fire siege (the insight: change the unit of organization from institution to problem), then "is there a software analogue", and landed on an agent runtime where the organization is derived state recomputed each cycle around an objective. Mauria: "this resonates. can't believe i stumbled into unifying everything i've been thinking about while reading about 9/11 of all things." She decided to build it on her machine, clean slate (not on her old "glove" project; ChatGPT's glove advice was retracted as unverified).

The name: noscope, after FIRESCOPE, and for the pun that it is built so she never has to zoom in, "not even to one-shot" (README wording she chose; "prompt" dropped as dorky). Earlier candidates: scope, no-scope, no_scope; `noscope` is free on PATH, Homebrew, GitHub; PyPI has an unrelated `noscope` (publish as `no_scope` if ever); npm `noscope` is a placeholder, `no-scope` free; npm not planned.

Every vocabulary word was fought over and is ICS's own except claim (ICS trusts human reports; a model's statements need epistemic status). Mauria cares about this because ICS is in the training data and she does not want agents confused: "op"/"operation" was tried and dropped because an ICS-trained agent reads "operations" as the Operations Section. Do not reopen any of these.

## 3. THE SETTLED DESIGN (DESIGN.md is the contract; this is the summary you must hold)

Vocabulary and roles:
- incident: the umbrella; anything Mauria asks for, a build as much as a failure. Not "case", "op", "mission".
- unit: a box in the incident's temporary tree that owns a slice of the problem (ICS Branch/Group). Nothing runs as a unit; it has a purpose, a parent, children; opens, subdivides, closes. Root unit is `command` (`<incidentId>-command`).
- task: ICS's "assignment", Mauria's word. Owned by one unit, bound to one capability: objective, inputs, expected output, completion criteria, evidence required, dependsOn, instructions, provider+model (for session-backed), budget.
- capability: the assignable thing. Declared equipment plus, when judgment is needed, a session with a system prompt. Deterministic (has `run`, no session) produces verified claims; session-backed produces asserted claims. May include other capabilities. Later, a human.
- equipment: the primitive, never assigned. Kinds: a function the runtime calls in-process (`read_file`, `grep_files`, `list_directory`, `git_status`, `git_log`, `git_diff`, `run_readonly`); a provider built-in tool (`Read`, `Grep`, `Glob`, `Bash` under an allowlist) usable only inside a session; after v0, an external MCP server (Craft, GitHub, a browser). Function equipment reaches a session only through the runtime's own MCP equipment server (after v0). Each declares `cost` facts (rate limit, typical tokens, seconds, money).
- claim: subject, predicate, object, status asserted | verified | rejected, confidence, evidence, provenance. Verified only through deterministic equipment.
- action plan: the planner's output per cycle (proposed, then approved by the validator, then applied). "plan" is the short form. Not "patch".
- planner: ICS Planning Section; drafts the action plan. Command (root unit + incident file) holds objectives and priorities like the Incident Commander; validator + Mauria approve, which is the commander's approval. One model call per cycle in v0.
- provider: the program that runs a session. Claude Code first; Codex second (flags verified in `codex exec --help`, untested); later HTTP or a human. Everything above the session layer is provider-blind.
- SOP: a saved unit configuration (e.g. a code review SOP) addable to any incident; after v0. Not "protocol", not "bundle".
- grant: Mauria's permission for a capability whose effect is not read_only. Levels stack: per incident per capability (default), standing whitelist, per-task option; auto-whitelist later; v0 is read-only so unused.
- budget: tokens/seconds bound on incident or task; unlimited default; costs live on the equipment/capabilities.
- incident file: the one place command keeps an incident's state; the planner's input is rendered from it; `incident show` prints it.
- Mauria = ICS Agency Administrator (above the Incident Commander): delegates authority via grants, sets priorities, gets briefed, answers questions. No PIO. Safety Officer = validator effect policy + grants.

The cycle (`incident step` runs one): observe (render the incident file into nine labeled planner-input sections in stable order so the prompt prefix caches) → plan (headless Opus 5, no tools, `--json-schema`) → validate (rules below; whole plan rejected or applied; `plan.rejected` fed back) → apply (units/tasks in one transaction with events) → dispatch (ready tasks, sequential in v0, time bound) → verify (deterministic → verified claims; session → asserted; insufficient → no claims + `task.insufficient`) → record → stop.

The planner's four channels for what it lacks: a task (retrievable fact), grantRequests (permission), capabilityRequests (missing means; also "what to build next"), questionsForHuman (only Mauria knows). Incident goes `blocked` on the last three; `incident answer` resumes.

Session contract: system prompt = fixed preamble (orientation: this is an ICS-modeled runtime, incident means anything asked for, temporary organization built and torn down, planner drafts/validator approves/tasks run through capabilities; the term mapping one line each; the session's place: a resource assigned to one task in one unit, report only against the contract, findings are asserted until verified, cannot change the organization; the four kinds of lack) + the capability's role text. User message = the task brief plus one line saying what the owning unit is trying to establish. Output schema via `--json-schema`; every session schema is ONE object: `{ outcome: answered|insufficient, claims[], findings (per-capability, nullable), needed[] with kind ∈ retrievable_fact|permission|missing_means|human_knowledge }`. `interpret` (no equipment) stays in v0 because "cannot answer, here is what I need" is the diagnostic Mauria wants.

Validator rules: capabilities exist; units exist; no cycles; no duplicates; inputs validate; span of control ≤7 direct children, target 5; effect policy (v0: read_only only; later grants); budget respected; dependencies resolve; closing is clean; status earned (`satisfied` needs every task done/cancelled and ≥1 verified claim); model known (provider+model pair the provider serves; the list is every model, not curated, Mauria can ask for anything; no defaults on capabilities).

Provider facts (all verified by test on home-laptop 2026-09-12, Claude Code 2.1.270):
- Headless `claude -p` runs on Mauria's subscription (no API key set; it worked). `--bare` and the Agent SDK need an API key: out.
- Isolation flags: `--output-format json --no-session-persistence --setting-sources "" --disable-slash-commands --exclude-dynamic-system-prompt-sections`; context drops from ~40k (56k in home dir) to ~3k; probe confirmed no CLAUDE.md/hooks visible. `--system-prompt` alone does NOT isolate. With `--setting-sources ""` the model falls back to Opus 5, so pass `--model` always.
- `--json-schema` works and returns `structured_output`; it REJECTS a `$schema` key and requires a top-level object (a discriminated union is refused). `jsonSchemaFor()` strips `$schema` and throws on non-objects.
- `--tools ""` removes built-ins but MCP tools from `--mcp-config --strict-mcp-config` stay callable (spike `spikes/mcp-tools-filter/run.sh`): a session can be given nothing but the runtime's equipment (2.5k tokens).
- Speed: ~3 s process startup per headless call; Haiku session with one Bash call 4.4 s API; Opus organizer call 14.2 s. Prompt caching is real in Claude Code (cache_creation/cache_read fields).
- Codex CLI at `~/.local/bin/codex`: `codex exec` has `-m`, `-s read-only`, `-C`, `--add-dir`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--output-schema FILE`, `--json`, `-o`; no system-prompt flag (prepend to prompt). Nothing run through it yet.

After-v0 open questions (do not design now): Situation Unit role; cross-incident priorities (MACS); Codex provider tests. First incident (PR 15): "Determine why Roughdraft scrolls to the bottom comment after a comment is deleted, instead of staying where the deleted comment was, and identify the code path responsible, in ~/Documents/Projects/roughdraftplus."

Stack rulings: TypeScript on Node 24, pnpm, zod 4, better-sqlite3 (over node:sqlite, "rather carry a dependency than have a built-in change under me"), biome, vitest, knip, GitHub Actions running `pnpm check`. Python was inherited from ChatGPT and dropped.

## 4. STATE OF THE BUILD

Repo `~/Documents/Projects/noscope`, remote https://github.com/kudzuweb/noscope (private; public later when she uses it at work). Files: `DESIGN.md` (the contract, with a few leftover CriticMarkup threads from Roughdraft review; harmless), `BUILD-PLAN.md` (15 PRs), `docs/architecture.html` (flow diagram), `docs/build-record.md` (one entry per merged PR: built, deviations with reasons), `README.md`, `spikes/`, `src/`, `test/`, `bin/noscope.mjs`.

Merged (squash, branches deleted): PR 1 skeleton, PR 2 contracts (`src/models.ts`), PR 3 store (`src/store.ts`), PR 4 incident commands (`src/context.ts`, `src/commands/incident.ts`, `create/show/events` work on a real file), PR 5 equipment (`src/equipment/*`). Build record has 1 through 5.

OPEN: PR 6, https://github.com/kudzuweb/noscope/pull/6, branch `pr-6-deterministic-capabilities`, commit `157356c`: `src/capabilities/registry.ts` (`defineCapability`; `produces` derived from session/run; refuses unknown equipment, built-ins on deterministic, both-or-neither session/run), `src/capabilities/deterministic.ts` (`check_path`, `read`, `grep`, `git_history`), `src/capabilities/index.ts`, `src/verifier.ts` (`recordClaims`: deterministic → verified with capability+inputs provenance; session → asserted with sessionId), store `createClaim` now writes `claim.<status>`, `incident show` lists the registry, 49 tests green, `pnpm check` exit 0. CI not yet confirmed. Build-record entry for PR 6 NOT yet written. Review `/code-review pr-6-deterministic-capabilities medium` was launched in the previous session and will finish there; that session forwards the results to you.

PR 5's review (also finishing in the previous session) already found real problems in the merged equipment that must be fixed in PR 6's branch before it merges:
- `run_readonly` allowlists the command but not its arguments: `find <dir> -delete` deleted a file with exit 0; `find -exec` and `-ok` are the same hole. Fix: reject find actions (`-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`, `-fprintf`, `-fls`) and probably any argument starting with `-` that is not in a per-command allowlist.
- `git_diff` with `from: "--output=/tmp/x"` wrote a file: revision and path arguments must not start with `-` (reject, or pass `--end-of-options`).
- `git_status` branch parsing: "No commits yet on main" and "HEAD (no branch)" come back as the branch string; renames come back as status "R", path "a.txt -> b.txt". Parse these.
- `run_readonly` timeouts and maxBuffer overflows collapse to exitCode 1 with empty stderr; surface the reason.
Their full finder reports may arrive as forwarded messages; apply what holds, add tests, commit on `pr-6-deterministic-capabilities`.

PR 6's review finders (received 2026-09-13 00:18, verified by them with probes on this machine unless noted) found these in the OPEN PR 6 code; fix on the branch before merging:
- `check_path` decides existence by matching a `readdir` dirent name in the parent instead of `stat`-ing the path: wrong for symlinks (`/tmp`, `/etc` come back "other"), case-insensitive APFS (`A.TXT` reported missing while `read` of it succeeds), `/` and `.` (basename empty, reported missing). Its bare `catch` turns any parent-read error (EACCES, a racing sibling delete) into a verified "exists: false". Fix: add a `stat_path` equipment (fs.stat and fs.lstat, reporting kind and the error distinctly), make `check_path` use it, treat only ENOENT as missing, and change the design's Step 3 v0 table row for `check_path` from `list_directory` to `stat_path`.
- None of the four `run` functions read `RunContext`, so relative `path`/`root`/`cwd` inputs resolve against the noscope process cwd, not the incident's `ctx.cwd`; tests pass only because they use absolute paths. Fix: resolve every path-typed input against `ctx.cwd` at the top of each run (one shared helper), and emit resolved absolute paths as claim subjects, so two greps in different roots never produce identical subjects like `a.txt:2`. Write the convention once in DESIGN.md Step 6.
- `grep`'s absence claim (`root has_no_match_for pattern`) omits the glob, ignoreCase and skipped-directory bounds the search ran under, and the verifier stores raw `task.inputs` rather than the effective parsed inputs with defaults. Fix: `runDeterministic` returns the parsed inputs, `recordClaims` stores those as provenance, and the absence claim's object carries the search parameters; capability input schemas should reuse the equipment schemas (with defaults) rather than hand-copied optional versions.
- `Capability` should be a discriminated union (`kind: "deterministic"` with `run` | `kind: "session"` with `session`) so exactly-one is a compile-time property and `produces` a literal; three places currently re-derive it at runtime (registry.ts exactly-one check, `produces` computation, `runDeterministic`'s `run === undefined`, incident.ts's `produces ===` test). The finder typechecked the union form under the repo's tsconfig; it compiles.
- `git_history`'s conditional spreads for `limit`/`path` are unnecessary: zod 4 applies defaults to explicit `undefined` and drops undefined optionals, so pass `{ cwd, limit, path }`. The verifier's conditional spreads likely the same (report truncated).
- `list_directory` stats every sibling for size, so `check_path` on one file in a huge directory did thousands of stats; the `stat_path` fix removes that.
Truncated reports not captured: pr6-reuse, pr6-angleB, pr6-angleC, pr6-efficiency, pr6-conventions; the orchestrator's consolidated report will follow as a forwarded message.

## 5. NEXT STEP, IN ORDER

1. `cd ~/Documents/Projects/noscope && git status && git branch --show-current` (expect `pr-6-deterministic-capabilities`, clean). `gh pr checks 6`.
2. Receive the forwarded review results for PR 5 and PR 6 from the previous session (they arrive as cross-session messages; also see §4). Apply what holds on the PR 6 branch, one concern per commit, `pnpm check` must print exit 0 before each commit (capture with `pnpm check >/tmp/c.log 2>&1; echo $?`).
3. Append the PR 6 entry to `docs/build-record.md` (format: "## PR N: Title (#N, merged DATE)", "Built:", "Not exactly to spec, with reasons:" bullets). Include the PR 5 fixes as a bullet.
4. Push; `gh pr edit 6 --body` if deviations changed; wait CI; `gh pr merge 6 --squash --delete-branch`; `git checkout main && git pull`.
5. PR 7, Claude Code provider, per `BUILD-PLAN.md`: `src/providers/base.ts` (provider interface: session request in → SessionResult + usage + session id out; the fixed preamble text from DESIGN.md's session-fields row), `src/providers/claude-code.ts` (render the request onto `claude -p` with `--model`, `--system-prompt`, `--tools`, `--allowedTools`, `--json-schema`, `--add-dir`, the five isolation flags; run; parse `structured_output` and usage), `test/stub-claude` (a stub binary echoing a canned result so tests need no network), one opt-in live smoke test behind `NOSCOPE_LIVE=1`. Then PRs 8–15 in order.

## 6. WORKING AGREEMENTS WITH MAURIA (standing consent; do not re-ask)

- Build here, in the session, one PR at a time on branch `pr-N-slug`, targeting main, no stacking. "merge as you go fam": merge after CI green and review findings applied. A new Agent Dash board only after noscope works.
- Every PR: commit; `/code-review <branch> medium` (the built-in skill; NOT her `/fresh-eyes`, which is for prose); push; `gh pr create` with body = the plan's PR step text verbatim, then "## Deviations, with reasons"; build-record entry on the branch before merge; CI; merge.
- Code review mechanics: the skill forks and spawns ~8 finder agents (angleA, finderReuse, finderConventions-store, etc.) that send findings as teammate messages, often truncated at 16k; the orchestrator's consolidated report arrives 10–20 minutes later as a task notification. Treat findings as secondhand; the ones so far were almost all real. Fix on the PR branch; if the PR already merged, fix in the next PR and say so in the build record.
- Docs travel with the change: if code changes a table, flag or rule, update `DESIGN.md`, `docs/architecture.html`, README in the same PR. Never `git add -A`; stage named files. Never commit in the same command as an edit. Sentence-case commit messages, no emoji, no attribution.
- Provenance labels in chat (verified / inferred / secondhand); answer first; tables for parallel items; no em-dashes.
- Quipu: thread `~/Documents/Projects/my-quipu/ics-runtime.md` (Head current to 23:00 2026-09-12 plus PR 1–4 not yet reflected: update the Sequencing paragraph when PRs land; write Head edits directly with exact anchors; the Haiku keeper agent invented content three times, papercut pc-e7b9f1; pull `--ff-only` first, a sibling session also writes there). Thread `roughdraft.md` (coiled) holds the scroll-after-delete defect and the nested-comment-id idea. Agent Dash postmortem on the first Dash run is deferred, on `agent-dash/agent-dash-board.md`.
- Roughdraft: reviews of DESIGN.md are done; if reopened, `roughdraft open <file>` blocks; Roughdraft holds its own copy with no file watcher, so stop the background wait (TaskStop) before editing the file, or the next save overwrites; tables do not render there (papercut pc-490f5c), so render with marked from `~/Documents/Projects/roughdraftplus/packages/app/node_modules` to `~/Downloads/noscope-design.html` (script: strip `{>>…<<}{id=…}` and `{==…==}` markers, wrap body).

## 7. ANCHORS

- Commands: `pnpm check` (lint, typecheck incl. tests, vitest, knip, build), `pnpm lint:fix`, `./bin/noscope.mjs --help`, `NOSCOPE_DB=/tmp/x.sqlite ./bin/noscope.mjs incident create "…" --constraint "…"`, `gh pr checks N`, `gh pr merge N --squash --delete-branch`.
- Code map: `src/cli.ts` (command table, optional handler per row, help/version; handlers get raw args), `src/context.ts` (Io, Context, Handler, EXIT: 0 ok, 2 usage, 3 not built, 4 not found, 5 cannot proceed), `src/models.ts` (all zod contracts; `sessionResult(findings)`; `jsonSchemaFor`; `Timestamp` accepts offsets; `Claim.object` defaults null; `Event` has `scope` incident|system with refine), `src/store.ts` (named write methods each with a zod `Mutation` in the event payload; `replay()` sorts and applies exactly the mutations; `batch()`; `record()`; schema `user_version` 1, file at another version refused; updates must change one row; reads parse through contracts; `resolveDbPath`: `$NOSCOPE_DB` else `~/.noscope/noscope.sqlite`), `src/commands/incident.ts` (create/show/events; `renderIncidentFile`), `src/equipment/*` (`defineEquipment`, `runEquipment` validates both ways; `builtin.ts` names provider tools and `bashAllowlist()`), `src/capabilities/*`, `src/verifier.ts`.
- Tests: `test/*.test.ts`, fixtures `test/fixtures/tree`; git fixtures built in temp dirs.
- knip: entries are `src/cli.ts`, `src/models.ts`, `src/equipment/index.ts`, `src/capabilities/index.ts`, `src/verifier.ts`, tests; unexport anything else nothing uses yet.
- Renders: `~/Downloads/noscope-design.html`, `~/Downloads/noscope-build-plan.html`.
- Papercuts: pc-176e29 (ChatGPT share extraction), pc-490f5c (Roughdraft tables), pc-e7b9f1 (keeper invents).

## 8. GOTCHAS

- biome reflows code after every `lint:fix`; exact-string anchors on TS files miss constantly. Rewrite small files whole, or use regex anchors on signatures; put size guards on edits but set them loosely.
- `exactOptionalPropertyTypes` is on: optional fields need `| undefined`.
- `util.parseArgs` strict mode is used inside handlers; the top-level dispatcher only scans for help/version flags.
- Node 24 type stripping cannot run `src/*.ts` directly (parameter properties); use `pnpm build` and `dist/`.
- `pnpm check | grep` hides the exit code; always echo `$?`.
- Zod 4: `z.unknown()` fields with absent keys parse to undefined; `.default(null)` where null is meant. `z.discriminatedUnion` is not allowed as a provider-facing schema.
- SQLite `UNIQUE` ignores NULLs; the events uniqueness is an index on `COALESCE(incident_id,'')`.
- Standing grants are system-scope events (`incidentId` null, `scope` "system").
- Context cost has been about 6% of the window per PR at this pace.
