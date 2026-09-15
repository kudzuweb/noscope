# noscope

An agent runtime built on the Incident Command System as its primitive: an incident runtime that
assembles a temporary organization around an objective, with capabilities, state and history
as the durable layer and the organization tree as derived state.

Named after FIRESCOPE, the effort that produced ICS, and for the pun: it is built so you never
have to zoom in, not even to one-shot. `DESIGN.md` is the design. `BUILD-PLAN.md` breaks it into fifteen PR-sized steps; `docs/build-record.md` says which are built.

`CLAUDE.md` orients a Claude pointed at the repository: the framework in a paragraph, install, use, what to read next.

Layout: `src/` is the runtime, `test/` its vitest tests, `bin/noscope.mjs` the launcher that
loads the built `dist/`; `biome.json`, `knip.json`, `tsconfig.json` and `tsconfig.typecheck.json`
configure lint, unused-code detection, the build and the typecheck that includes tests.

`spikes/` holds one-off verification scripts that back facts in `DESIGN.md`; each has a `run.sh`. They are kept as they ran and are excluded from lint.

`docs/build-record.md` is one entry per merged PR: what was built and where it departs from the plan and why.

`docs/instructions-only-run.md` reads the session that built round 3 the way `incident review` reads a run, so the runtime and plain instructions can be compared on the same terms.

`docs/first-incident.md` is the record of the first live run: the answer the runtime produced, the run cycle by cycle, the acceptance criteria checked against it, and the second run that measured round 2 beside it.

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
session's (default `claude`; tests point it at `test/stub-claude`).
`CLAUDE_CONFIG_DIR`, when set for Claude Code, is where the runtime looks for session and
subagent transcripts (default `~/.claude`).
`NOSCOPE_IC_HANDOFF_TOKENS` is the context size at which the IC's session hands command to
a fresh one (default 120000): the context of the last message of the IC's last call, in
tokens, not the call's summed input; the IC is never compacted, so this is what keeps it
below Claude Code's limit.
`NOSCOPE_REPORT_WORK_CHARS` is the size, in characters, at which each task's block under a
unit's report in the IC's change report (and in `incident show`) is clipped, the task id
left as the pointer to the full record (default 1500).
`NOSCOPE_LIVE=1` also runs the live tests, which call the real binary: a Haiku session, a
Haiku leader sending a two-member `pinger` strike team, a Haiku initial IC sizing up this
checkout read-only and one sizing up a diagnostic objective on it, and a
`reproduce` session that drives Playwright's MCP server, which needs Playwright's Chromium
installed (`npx playwright install chromium`) and network access for
`npx --yes @playwright/mcp@latest`.

`pnpm check` runs lint (biome), typecheck, tests (vitest), unused-code detection (knip) and
the build, which is what CI runs on every pull request. Every command in the design's
command list is known to the binary; exit codes are the table in `DESIGN.md` Step 7.
