# Build record

One entry per PR, appended when the PR merges: what was built, why, and whether it matches
`BUILD-PLAN.md` and `DESIGN.md` exactly. Where it does not, the deviation and its reason are
here, and the design or plan was updated in the same PR.

## PR 1: Skeleton (#1, merged 2026-09-12)

Built: a pnpm TypeScript package for Node 24 with biome, vitest, knip and a CI workflow
running `pnpm check`; `bin/noscope.mjs` printing help and version; `src/cli.ts` with one
command table where every command in the design's Step 7 is registered and a command
without a handler is the exit-3 stub; README install section.

Not exactly to spec, with reasons:

- The launcher is `bin/noscope.mjs`, not `bin/noscope`, so biome lints it; an extensionless
  file is skipped.
- The CLI parses with Node's `util.parseArgs` and dispatches through a command table with an
  optional `handler`; the plan did not specify a mechanism. Chosen so `--help` works anywhere
  and later PRs land a command by filling one row.
- Two conventions the plan and design lacked were added to `DESIGN.md` in this PR because
  the code had to pick them: the exit-code table (0, 2, 3, 4, 5) in Step 7 and the SQLite
  path (`$NOSCOPE_DB`, else `~/.noscope/noscope.sqlite`) in Step 2.
- `tsconfig.typecheck.json` exists beside `tsconfig.json` so tests are typechecked without
  being built.
- The spike server under `spikes/` is excluded from lint and knip and kept byte-for-byte as
  it ran, since the design cites it as evidence.

## PR 2: Contracts (#2, merged 2026-09-12)

Built: `src/models.ts` with every schema the design names, `jsonSchemaFor()` for what
providers receive, `zod` 4 as the first runtime dependency, and tests.

Not exactly to spec, with reasons:

- `sessionResult(findings)` is a function returning one object schema with an `outcome`
  field and outcome-dependent rules, not a discriminated union. Two facts from a live check
  against Claude Code 2.1.270 forced this: `--json-schema` rejects a schema carrying a
  `$schema` key, and it forwards the schema as a tool input schema, which must be a
  top-level object, so a union is refused. `jsonSchemaFor()` therefore drops `$schema`
  and throws on a non-object schema. The design's Step 3 sketch now reads
  `sessionResult(InvestigateFindings)`.
- `Claim` gained `evidence: string[]`, because a session's claim proposals carry evidence
  pointers and the stored claim had nowhere to keep them.
- `Grant` ties `incidentId` to `scope`: null exactly when standing.
- `Timestamp` accepts an offset on read; the store writes `toISOString()`.
- `UnitProposal` carries a `ref` so a plan's new tasks can name a unit created in the same
  plan; the design did not say how that reference works.
- `Usage` (tokens and seconds) is a schema so `task.usage` events have a shape.
