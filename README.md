# noscope

An agent runtime built on the Incident Command System as its primitive: an incident runtime that
assembles a temporary organization around an objective, with capabilities, state and history
as the durable layer and the organization tree as derived state.

Named after FIRESCOPE, the effort that produced ICS, and for the pun: it is built so you never
have to zoom in, not even to one-shot. `DESIGN.md` is the design. `BUILD-PLAN.md` breaks it into fifteen PR-sized steps; `docs/build-record.md` says which are built.

`CLAUDE.md` orients a Claude pointed at the repository: the framework in a paragraph, install, use, what to read next.

Layout: `src/` is the runtime (`src/units/` registers the unit types, `base` and `ic`,
each a form and a protocol; `src/configs.ts` the saved unit configs a plan deploys by
name; `src/capabilities/` the capabilities), `test/` its vitest
tests, `bin/noscope.mjs` the launcher that
loads the built `dist/`; `biome.json`, `knip.json`, `tsconfig.json` and `tsconfig.typecheck.json`
configure lint, unused-code detection, the build and the typecheck that includes tests.

`spikes/` holds one-off verification scripts that back facts in `DESIGN.md`; each has a `run.sh`. They are kept as they ran and are excluded from lint.

`docs/build-record.md` is one entry per merged PR: what was built and where it departs from the plan and why.

`docs/instructions-only-run.md` reads the session that built round 3 the way `incident review` reads a run, so the runtime and plain instructions can be compared on the same terms.

`docs/first-incident.md` is the record of the first live run: the answer the runtime produced, the run cycle by cycle, the acceptance criteria checked against it, and the second, third and fourth runs that measured rounds 2, 3 and 4 beside it.

`docs/architecture.html` is the flow diagram: the pieces, one cycle in order, what a session receives and returns, a claim's life, where the loop waits on Mauria, the tree changing shape. Opens straight from disk.

## Install and run

Node 24 and pnpm 10.

```
pnpm install
pnpm build
./bin/noscope.mjs --help
```

Environment: `NOSCOPE_DB` is the SQLite file (default `~/.noscope/noscope.sqlite`);
`NOSCOPE_CLAUDE_BIN` is the Claude Code binary every provider call runs on, the initial
IC's size-up at `create`, the IC's, the planner's, each unit leader's and each task
session's (default `claude`; tests point it at `test/stub-claude`). The IC runs on
`claude-sonnet-5` unless `incident create --ic-model` names another (R5-6); the planner
names every other session's model, the smallest that fits its work, with a `modelWhy` where
it picks Opus or Fable.
`CLAUDE_CONFIG_DIR`, when set for Claude Code, is where the runtime looks for session and
subagent transcripts (default `~/.claude`).
`NOSCOPE_IC_HANDOFF_TOKENS` is the context size at which the IC's session hands command to
a fresh one (default 120000): the context of the last message of the IC's last call, in
tokens, not the call's summed input; the IC is never compacted, so this is what keeps it
below Claude Code's limit.
`NOSCOPE_REPORT_WORK_CHARS` is the size, in characters, at which each task's block under a
unit's report in the IC's change report (and in `incident show`) is clipped, the task id
left as the pointer to the full record (default 1500).
`NOSCOPE_IC_FALLBACK_MODEL` is the model a seat the API refused is retried on, once
(default `claude-opus-4-8`): the IC's replacement session, a unit leader's, or a task's own
retry; refused on it too, a unit reports `not_met` for the IC to decide and the IC's own
refusal blocks the incident on a question that `incident answer <id> "<model>"` resolves.
`NOSCOPE_PARALLEL` is how many units run their passes at once (default 3; a positive whole
number): units with no `dependsOn` between their tasks run concurrently, and inside a unit
every session task runs in a session of its own and independent ones start together (the
leader's session runs no task); set it to 1 for one unit at a time.
`NOSCOPE_LIVE=1` also runs the live tests, which call the real binary: a Haiku session, a
Haiku session sending a two-member `pinger` strike team, a Haiku initial IC sizing up this
checkout read-only and one sizing up a diagnostic objective on it, and a
`reproduce` session that drives Playwright's MCP server, which needs Playwright's Chromium
installed (`npx playwright install chromium`) and network access for
`npx --yes @playwright/mcp@latest`.
`NOSCOPE_REPLAY_DB`, when it names a copy of run 004's record (`~/.noscope/fourth-run.sqlite`,
not in the repository), also runs the replay test in `test/replay.test.ts`: the file
rendered from that record lists its 54 session claims and four evidence lines, and
`incident review` counts both (R5-1). Point it at a copy, never the original: opening a
record migrates it in place, and the test copies it once more before opening.

`pnpm build` compiles `src/` into `dist/` and then writes `dist/runtime-version.json`, the
commit the build ran at (`-dirty` when a tracked file differed from it, `unknown` with no
git or no checkout); every event the runtime writes carries it as its `runtime` tag, so a
seat's briefing can be re-rendered later by checking that commit out (R4-12; DESIGN.md
Step 2). Rebuild after every pull, since `bin/noscope.mjs` runs `dist/` as it stands.
`pnpm check` runs lint (biome), typecheck, tests (vitest), unused-code detection (knip) and
the build, which is what CI runs on every pull request. Every command in the design's
command list is known to the binary; exit codes are the table in `DESIGN.md` Step 7.
