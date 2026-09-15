# noscope, for a Claude pointed at this repository

noscope is an agent runtime built on the Incident Command System (ICS). You give it an
objective, called an incident, and it builds a temporary organization around that objective
out of Claude Code sessions, runs it cycle by cycle, and records everything that happens. It
runs on the Claude Code binary on this machine, on the subscription, with no API key.

## The framework in one paragraph

ICS is the structure emergency services use to run an incident: one commander, a plan per
operational period, a tree of units each with a leader and a clear assignment, resources
typed so everyone means the same thing by a name, and a record of every decision. noscope
maps it onto agents. The Incident Commander (IC) is a persistent Claude session that sets each
period's objectives and priorities, reviews the planner's draft, reads the units' reports and
decides whether the incident is met. The planner is a stateless call that drafts each period's
action plan from the incident file. Every unit has a leader session that runs the unit's tasks
in order and reports against the unit's objective, and a leader can send a strike team of
subagents at a task. Tasks run through capabilities (grep, read, investigate, reproduce in a
browser, interpret) and produce claims with a basis (observed or inferred), a confidence and
evidence. Deterministic code validates every plan, dispatches, records every call and claim
as an event, and prints an After Action Review. The human above the IC is the Agency
Administrator: they answer questions only a human can, grant permissions, and set priorities.

`DESIGN.md` is the contract: vocabulary, the ICS mapping table, every build step and the
facts the design rests on. Read its Vocabulary and ICS mapping before anything else.

## Install

Node 24 and pnpm 10, and Claude Code installed and logged in (`claude --version` works).

```
git clone https://github.com/kudzuweb/noscope.git
cd noscope
pnpm install
pnpm build
./bin/noscope.mjs --help
```

To have `noscope` on your PATH, `npm link` in the checkout, or call `bin/noscope.mjs` by
path. `pnpm check` runs lint, typecheck, tests, unused-code detection and the build; the
tests use a stub binary and make no network calls. `bin/noscope.mjs` runs `dist/` with no
staleness check, so run `pnpm build` after every pull.

## Use

Run from the working directory the incident is about (a repository, usually); every session
the runtime starts inherits that directory, read-only.

| Step | Command |
|---|---|
| Create an incident. The initial IC (Haiku) sizes it up, writes a briefing and hands command to the IC on the model it recommends, or the one `--ic-model` names. Questions in the briefing block the incident until answered. | `noscope incident create "<objective>" --constraint "<text>" --priority "<text>" [--ic-model claude-sonnet-5]` |
| Answer a question or a capability request, the planner's or a unit's. | `noscope incident answer <id> "<text>"`, `noscope incident provide <id> "<text>"` |
| Run one cycle: the IC sets the period, the planner drafts, the IC reviews, the validator checks, units run to their reports. A cycle with a browser reproduce can take ten minutes; run it detached and read the log. | `noscope incident step <id>` |
| Run cycles until the incident leaves `open` or the cap is hit. | `noscope incident run <id> --max-cycles N` |
| Read the incident file, the unit tree, the event log. | `noscope incident show <id>`, `tree`, `events` |
| The After Action Review: every cycle, every call with tokens and cost, verdicts, reports, transfers of command, claims. | `noscope incident review <id>` |

Environment: `NOSCOPE_DB` names the SQLite file (default `~/.noscope/noscope.sqlite`; use one
file per investigation); `NOSCOPE_CLAUDE_BIN` names the Claude Code binary (default `claude`);
`NOSCOPE_IC_HANDOFF_TOKENS` is the IC context size at which command is handed to a fresh
session (default 120000); `NOSCOPE_IC_FALLBACK_MODEL` is the model a refused seat is retried
on once (default `claude-opus-4-8`); `NOSCOPE_PARALLEL` is how many units run at once
(default 3; 1 runs them one at a time). The README's "Install and run" section has the rest.

Everything is read-only in this version: sessions get `Read`, `Grep`, `Glob` and `Bash` under a
read-only allowlist, and nothing that writes runs without a grant, which is not built yet.
Opus 5's safeguards refused the IC's resumed turns on 2026-09-15 (`DESIGN.md` Reference
table); since R4-7 a refused IC call falls back to Opus 4.8 for the rest of the incident, and
a refusal there too blocks the incident on a question you answer with a model name
(`noscope incident answer <id> "claude-sonnet-5"`). Sonnet 5 ran every turn in the third run,
so `--ic-model claude-sonnet-5` at `create` still avoids the refusal outright.

## What to read next

| Want | Read |
|---|---|
| How it works, in order | `docs/architecture.html`, then `DESIGN.md` Steps 4 to 6 |
| What has been built and what is next | `BUILD-PLAN.md` (rounds 3 and 4 at the end) and `docs/build-record.md` |
| What a run looks like and what it cost | `docs/first-incident.md` (three runs of one objective) |
| The runtime against plain instructions | `docs/instructions-only-run.md` |

## Working in this repository

One PR per plan row targeting `main`; every PR is reviewed; docs travel with the change
(`DESIGN.md`, `docs/architecture.html`, `README.md`, and an entry in `docs/build-record.md`);
sentence-case commit messages, no emoji, no attribution footers; `pnpm check` exits 0 before
a PR opens. The `handoff-noscope-build.md` at the root is the last build session's recovery
document, not a guide.
