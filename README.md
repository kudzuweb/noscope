# noscope

An agent runtime built on the Incident Command System as its primitive: a case runtime that
assembles a temporary organization around an objective, with capabilities, state and history
as the durable layer and the organization tree as derived state.

Named after FIRESCOPE, the effort that produced ICS, and for the pun: it is built so you never
have to zoom in. `DESIGN.md` is the design and build plan. Nothing else exists yet.

`spikes/` holds one-off verification scripts that back facts in `DESIGN.md`; each has a `run.sh`.

`docs/architecture.html` is the flow diagram: the pieces, one cycle in order, what a session receives and returns, a claim's life, where the loop waits on Mauria, the tree changing shape. Opens straight from disk.
