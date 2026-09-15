# An instructions-only run: the round 3 build session read as an incident

The session that designed and built round 3 on the night of 2026-09-14 to 15 ran the ICS
structure by instruction alone: one Claude Code session as Incident Commander, subagents as
builders and reviewers, Mauria's standing rules as the protocol, and no runtime enforcing
any of it. This is that session read the way `incident review` reads a noscope run, from its
transcript and its subagents' transcripts, so the runtime can be compared with instructions
on the same terms. Every figure below is computed from
`~/.claude/projects/-Users-mauriaparker/da050f04-42b2-4162-9421-387ea5d066a1.jsonl` and the
26 transcripts under its `subagents/` directory, summing usage once per message id as the
provider does, priced at the same list rates and cache factors `src/review.ts` uses
(2026-06-24 rates; cache writes at 2x, reads at 0.1x). Wall times are first to last assistant
message. The session's own context is the 1M window; nothing was compacted.

## The incident

Objective: build round 3 of `BUILD-PLAN.md` overnight, one PR at a time, and run the first
incident a third time. Set by Mauria at 2026-09-15 00:55 CDT with push and merge authority
for the build. Constraints: her standing working agreements (a PR per plan row, review by
subagents, docs travel with the change, provenance labels). Priorities: none stated beyond
the plan's order; the session took "keep the app working between PRs" and "review every PR"
as its own. The session had already spent the evening (20:48 to 00:55 CDT) in the design
conversation that produced the plan; that stretch is the size-up, and it is counted
separately.

Outcome: satisfied. Eleven plan PRs and two run-forced fixes merged, run 003 closed on the
same code path as runs 001 and 002 at $4.86, the write-ups landed. 10 hours 16 minutes of
wall time from the go to the last merge, 5 hours 17 minutes of it the build.

## Cycles

A cycle here is one stretch of the IC's attention between merges. The IC's context figure
is the sum of every call's whole context in the window, the way `command.turned` records
it; the IC ran on Opus 5 throughout.

| Cycle | IC calls | IC input context | IC output | IC cost | Tool calls | Agents spawned |
|---|---|---|---|---|---|---|
| Size-up: the design conversation, 20:48 to 00:55 CDT | 108 | 19.4M | 93k | $14.99 | 64 (Bash 44, SendMessage 8, Read 4) | 1 (the quipu keeper) |
| R3-0 spikes run and landed; R3-1, R3-2, R3-3 builders and PR 28's reviewer spawned | 57 | 17.9M | 38k | $10.55 | 45 | 6 |
| PRs 28, 30, 29, 31 reviewed, fixed, rebased, merged | 47 | 17.3M | 21k | $9.56 | 32 | 2 |
| R3-4 built, two reviews, merged (PR 32) | 17 | 6.8M | 14k | $4.01 | 11 | 5 |
| R3-5, R3-6, R3-7 built in parallel, five reviews, rebases, merged (35, 33, 34) | 71 | 32.5M | 38k | $18.00 | 42 | 9 |
| R3-8, R3-9 built in parallel, three reviews, merged (37, 36) | 19 | 9.7M | 7k | $5.20 | 10 | 1 |
| Run 003: two incidents stepped by hand, two fixes (38, 39) built and merged, write-ups | 93 | 52.7M | 52k | $28.61 | 79 (Bash 73) | 2 |
| Total, build only (excluding the size-up) | 304 | 136.9M | 169k | $75.94 | 219 | 25 |

The IC's context at its last call was 625k tokens. The runtime's IC would have handed off
at 120k, five times over.

## Tasks

Every subagent was a session-backed task on Opus 5. A builder is a unit leader in the plan's
terms (it owned one PR's scope, worked its tasks in order, and reported); a reviewer is a
single resource with one assignment. The quipu keeper is a task force of one that ran for
the whole night.

| Task | Wall time | Turns | Input context (of which cache read) | Output | Tool calls | Cost |
|---|---|---|---|---|---|---|
| build-r3-1 (tool and subagent events, plus its review fixes and rebase) | 27 min | 96 | 17.8M (17.4M) | 20k | 93 | $13.83 |
| build-r3-2 (status is a label) | 9 min | 55 | 7.1M (6.9M) | 9k | 54 | $5.20 |
| build-r3-3 (persistent sessions, fixes, the cache probes) | 24 min | 58 | 7.7M (7.5M) | 15k | 56 | $5.76 |
| build-r3-4 (unit leaders, sixteen review fixes) | 46 min | 136 | 40.4M (39.6M) | 47k | 134 | $29.25 |
| build-r3-5 (strike teams, the LeaderTurn reshape, four fixes) | 38 min | 128 | 32.4M (31.7M) | 39k | 125 | $23.66 |
| build-r3-6 (lacks at the leader, two reviews' fixes, the rebase) | 74 min | 221 | 74.0M (72.4M) | 84k | 217 | $54.71 |
| build-r3-7 (the IC above the planner, sixteen fixes, the rebase) | 47 min | 162 | 53.5M (52.7M) | 56k | 159 | $36.06 |
| build-r3-8 (initial IC, eight fixes, the rebase) | 37 min | 141 | 36.5M (35.8M) | 54k | 138 | $25.84 |
| build-r3-9 (IC handoff, two reviews' fixes, the rebase, then PR 38) | 84 min | 182 | 55.0M (53.3M) | 85k | 176 | $45.40 |
| 16 reviewers (one to two per PR; 3 to 9 min each) | 93 min total | 509 | 52.8M (51.0M) | 87k | 493 | $46.02 |
| quipu keeper (resident all night, 16 changes recorded) | 436 min | 152 | 29.3M (26.2M) | 43k | 136 | $44.93 |

By role:

| Role | Calls or agents | Input context | Output | Wall time | Cost |
|---|---|---|---|---|---|
| IC (this session, build only) | 304 calls | 136.9M | 169k | 5 h 17 min | $75.94 |
| Builders | 9 agents, 1,179 turns | 324.4M | 409k | 6 h 26 min summed | $239.70 |
| Reviewers | 16 agents, 509 turns | 52.8M | 87k | 1 h 33 min summed | $46.02 |
| Keeper | 1 agent, 152 turns | 29.3M | 43k | 7 h 16 min resident | $44.93 |
| Size-up (the design conversation) | 108 calls | 19.4M | 93k | 4 h 7 min | $14.99 |
| Total | | 562.8M | 801k | | $421.58 |

Ninety-eight percent of the input was cache reads: the builders' long contexts were re-read
on every turn at 0.1x, which is what makes a 74M-token builder cost $55 and not $370.

## Reviews and verdicts

Every PR got at least one review; R3-4, R3-7 and the two rebases got two. Sixteen reviews
returned 85 findings; the IC read each report against what it knew, applied 83, overruled 2
with a reason (a keep-the-fixture-canonical call on PR 31 and a wording call on PR 35), and
made eight rulings of its own where a finding needed one, each recorded in the quipu as the
session's rather than Mauria's. No review was approved as drafted; every PR changed after
review. Reviews caught, among other things: a citation WebFetch's summarizer had invented
(PR 28), a killed session losing its tool calls (PR 31), the envelope's input figure summing
across API turns so the handoff trigger read double the real context (PR 36), a paid
size-up vanishing on a schema refinement (PR 37), and the IC being told its `not_met`
reports go to itself (PR 32).

## Questions to the human

None during the build. Mauria sent two messages after the go: the analysis request at
01:29 and nothing else. The session decided everything else itself and recorded which
decisions were its own. Two operational questions from the run's size-ups were answered by
the session as operator, each answer saying so.

## What went wrong, and what caught it

| What | Caught by | Cost |
|---|---|---|
| A commit on the R3-0 branch ran after an edit script failed partway (the session broke its own never-commit-in-the-same-command rule) | The session, reading the output | One extra commit |
| A CI wait loop spun for an hour on a PR whose rebase had made it conflict again, with no checks reported | The hourly heartbeat, which found the loop still running | 55 minutes of wall time |
| Two builders claimed schema version 5; three PRs raced on `LeaderTurn` | Rebases, each reviewed a second time | About 40 minutes of rebasing across R3-6, R3-7, R3-9 |
| Opus 5 refused the runtime IC's resumed turns | The run; fixed by PR 38 and a model change | 40 minutes and $1.11 |
| The effect policy rejected a read-only allowlist | The run; fixed by PR 39 | 15 minutes |

## The runtime beside the instructions

What the runtime enforced in run 003 that instructions did not enforce here, and the
reverse. The runtime's figures are run 003's; the session's are the build's.

| Dimension | The runtime (run 003) | Instructions only (this session) |
|---|---|---|
| The record | Every call, tool call, claim, verdict and transfer is an event with usage and cost; `incident review` printed this analysis in one command. | Reconstructed after the fact from transcripts by a script; usage and tool calls were there, but which task a call served, what a claim rested on, and why a decision was made had to be read out of prose. |
| Seat boundaries | The IC could not run a tool during a turn, could not apply a plan the validator rejected, and could not close without observed claims. | The IC ran 219 tool calls itself, including building R3-0 and R3-10b by hand and stepping the live run, because nothing stopped it and delegating would have cost more than doing. |
| Plan before spend | Every period had objectives written before any task ran; the planner's draft was reviewed before dispatch. | The plan was written and reviewed the evening before; within the build the IC briefed each builder from the plan block and did not re-plan per PR. Equivalent, and cheaper, because the plan was fixed. |
| Reports | One report per unit, shaped (met, what changed, claims cited), and the IC saw it in the change report at the top of its next turn. | Builders reported in prose of their own shape, often truncated at 16k; the IC asked for the rest by message three times. |
| Reviews | None in the runtime yet: the validator checks shape, and the IC reviews the planner's draft, not the work. | Sixteen reviews found 85 defects the builders' own checks passed. This is the biggest gap in the runtime's structure: nothing reviews a unit's work before the IC accepts its report. |
| Handoff and context | The IC's context was watched per call; a handoff would have fired at 120k (it reached 134k on the closing turn). | The IC ran to 625k with no handoff, on a 1M window, with a handoff file refreshed by hand at three points and a heartbeat cron as the recovery mechanism. |
| Lacks | A retrievable fact is the leader's; the rest go up and block the unit. | Builders asked the IC by message when blocked (twice); the IC answered from context. Same shape, by convention. |
| Cost | $4.86 for a three-turn investigation; leader turns on a 100k context were the largest line. | $422 for a night's build; builders on 40M to 74M contexts were the largest line, and nothing bounded a builder's context or told it to hand off. |
| Refusals | One refusal loop found and fixed within the run. | None: this session and its subagents were never refused, on the same model, doing work of the same kind (judging and rewriting other sessions' output). The runtime's prompts drew the safeguard where the interactive session's did not. |

## What this says about whether the runtime is useful

Three things the instructions-only run did well came from the plan being fixed in advance:
the IC never re-planned, briefed from the plan's own text, and merged in order. The runtime
gets the same from period objectives, at the cost of a planner call per period.

Three things the instructions-only run did badly are exactly what the runtime enforces: the
IC did work itself whenever delegation looked slower; reports came back in whatever shape
the builder chose and were cut off; nothing bounded any session's context or spend. The
runtime made each of those impossible or visible in run 003.

One thing the instructions-only run had that the runtime lacks is review of the work itself
before acceptance. Sixteen reviews changed every PR. In the runtime a unit's report is
accepted by the IC on the leader's word and the claims it cites; the closest thing to a
reviewer is the `interpret` task, which reconciles evidence but does not check a unit's work
against its assignment. A review seat between a unit's report and the IC's acceptance, or a
reviewer strike team the IC can send at a report, is the first thing this comparison argues
for.

And one thing to weigh against all of it: the runtime's IC on Opus 5 was refused by the
model's own safeguards, and this session on Opus 5 was not, though both judged other
sessions' output all night. The difference is the prompt's shape, not the work, and until
the shape that draws the safeguard is understood, the runtime's IC runs on Sonnet 5.
