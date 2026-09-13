# noscope

An agent runtime built on the Incident Command System as its primitive: an incident runtime that
assembles a temporary organization around an objective, with capabilities, state and history
as the durable layer and the organization tree as derived state.

Named after FIRESCOPE, the effort that produced ICS, and for the pun: it is built so you never
have to zoom in. `DESIGN.md` is the design. `BUILD-PLAN.md` breaks it into fifteen PR-sized steps and says which are built.

Layout: `src/` is the runtime, `test/` its vitest tests, `bin/noscope.mjs` the launcher that
loads the built `dist/`; `biome.json`, `knip.json`, `tsconfig.json` and `tsconfig.typecheck.json`
configure lint, unused-code detection, the build and the typecheck that includes tests.

`spikes/` holds one-off verification scripts that back facts in `DESIGN.md`; each has a `run.sh`. They are kept as they ran and are excluded from lint.

`docs/build-record.md` is one entry per merged PR: what was built and where it departs from the plan and why.

`docs/architecture.html` is the flow diagram: the pieces, one cycle in order, what a session receives and returns, a claim's life, where the loop waits on Mauria, the tree changing shape. Opens straight from disk.

## Install and run

Node 24 and pnpm 10.

```
pnpm install
pnpm build
./bin/noscope.mjs --help
```

`pnpm check` runs lint (biome), typecheck, tests (vitest), unused-code detection (knip) and
the build, which is what CI runs on every pull request. Every command in the design's
command list is known to the binary; exit codes are the table in `DESIGN.md` Step 7.
