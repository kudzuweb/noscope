# noscope

An agent runtime built on the Incident Command System as its primitive: an incident runtime that
assembles a temporary organization around an objective, with capabilities, state and history
as the durable layer and the organization tree as derived state.

Named after FIRESCOPE, the effort that produced ICS, and for the pun: it is built so you never
have to zoom in. `DESIGN.md` is the design. `BUILD-PLAN.md` breaks it into fifteen PR-sized steps. Nothing is built yet.

`spikes/` holds one-off verification scripts that back facts in `DESIGN.md`; each has a `run.sh`.

`docs/architecture.html` is the flow diagram: the pieces, one cycle in order, what a session receives and returns, a claim's life, where the loop waits on Mauria, the tree changing shape. Opens straight from disk.

## Install and run

Node 24 and pnpm 10.

```
pnpm install
pnpm build
./bin/noscope --help
```

`pnpm check` runs lint (biome), typecheck, tests (vitest), unused-code detection (knip) and
the build, which is what CI runs on every pull request. Commands that are not built yet
print the PR that delivers them and exit 3.
