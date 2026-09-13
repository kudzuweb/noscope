# The first incident

The live run of DESIGN.md Step 8 on 2026-09-13, against the real Claude Code provider with
`claude-opus-5` as planner, one `step` at a time, from the roughdraftplus working directory
(`~/Documents/Projects/roughdraftplus`, main at 6a996e8), on a dedicated database
(`NOSCOPE_DB=~/.noscope/first-incident.sqlite`). Read-only throughout: nothing in that
repository changed.

Objective: "Determine why Roughdraft scrolls to the bottom comment after a comment is
deleted, instead of staying where the deleted comment was, and identify the code path
responsible, in ~/Documents/Projects/roughdraftplus", with two constraints: never modify
the repository, and the code under investigation is `packages/`.

## The answer the runtime produced

Root cause, as the `interpret` task stated it (claim `001-c381`, confidence 0.8, and the
task's findings): `PageCard.deleteComment` (`packages/app/src/PageCard.tsx:1863-1907`)
runs `currentEditor.chain().focus().removeCommentIds(...).run()` with no focus options
(the `.focus()` at line 1884). In the installed `@tiptap/core` 3.22.4, `focus()` with no
position defaults `scrollIntoView` to true (`focus.ts:26,40`), falls back to the editor's
existing selection (`focus.ts:90`), and, because the Delete click has moved DOM focus off
the editor view so the `view.hasFocus() && position === null` early return at `focus.ts:73`
does not fire, schedules `view.focus()` plus `tr.scrollIntoView()` on the next animation
frame (`focus.ts:61-66`). `removeCommentIds` (`editor-extensions.ts:130-196`) never sets
or scrolls the selection, and nothing on the delete path selects or scrolls to the deleted
comment's anchor, so the view scrolls to wherever the selection already sat: the most
recently added comment's anchor, which `handleAddComment` (`PageCard.tsx:1613-1617`) leaves
selected, or the last thread clicked in the rail via `focusComment` (`PageCard.tsx:2046-2066`).
Every other scroll or focus site in `PageCard.tsx` and `CommentEditorList.tsx` was
enumerated and excluded with a cited reason (claim `001-c383`).

The runtime separated what the code proves from what it infers: the scroll going to the
existing selection is verified from source; that the selection sits on the last comment,
and that DOM focus is off the editor at click time, are inferred from the code. It named the
one runtime observation that closes both gaps: a log line before the chain at
`PageCard.tsx:1882` printing `view.hasFocus()` and `getSelectionCommentIds(state)`
(claim `001-c384`). On its ninth cycle it declared the evidence complete and asked Mauria
the one question the repository cannot answer:

> When you reproduce the bug, had you most recently added the bottom comment (or clicked
> its thread in the rail) before deleting a different comment?

The incident is `blocked` on that question (`001-q01`); `noscope incident answer 001
"<text>"` reopens it, and the next step is where `satisfied` becomes reachable.

## The run

| Cycle | What happened | Time |
|---|---|---|
| 1 | The planner opened a recon unit with five read-only tasks (check_path, git_history, three greps) and was rejected on Inputs validate: it wrote `path` where grep wants `root` and git_history wants `cwd`, because section 8 showed capabilities by name and description only. Fixed in this PR: section 8 now shows each capability's input fields. | 34 s |
| 2 | The same plan resubmitted with the right fields, approved; all five tasks ran; 322 verified claims (110 and 181 of them grep matches). | 31 s |
| 3 | Recon closed ("no open tasks remain"); two units opened, `source-reads` (four `read` tasks on the implicated components) and `causal-trace` (two `investigate` sessions on Opus); 28 asserted claims. | 9 m 39 s |
| 4 | `source-reads` closed; ten asserted claims named in `claimsToVerify`; four deterministic checks against the installed TipTap source (the focus command's defaults, the version). | 1 m 02 s |
| 5 | Rejected twice: the `interpret` task's `evidence` entries lacked `source` and `content` (section 8 showed `object[]` without the object's fields), and one claim id in `claimsToVerify` was a mistyped UUID. Fixed in this PR: nested input shapes render in full, and claims get short positional ids. | 1 m 57 s |
| 6 | The planner fixed both faults from the feedback, closed `causal-trace`, opened `u05-synthesis`, routed the narrow focus check to Sonnet and the synthesis to Opus (model routing per task); the `interpret` task returned the root-cause statement. | 5 m 32 s |
| 7 | Two more deterministic facts pinned (the focus fallback to the existing selection; every `focus()` call in `PageCard.tsx`). | 47 s |
| 8 | The last inferred link chased into the Button wrapper and `@base-ui/react` (a grep, a check_path, a Sonnet investigation). | 3 m 23 s |
| 9 | "The investigation is evidentially complete"; the question for the human; `blocked`. | 43 s |

Totals, from the event log:

| Measure | Value |
|---|---|
| Wall time | 28 minutes (13:33 to 14:01 UTC) |
| Events | 525 |
| Planner calls | 9, 726k input tokens over the run (7k, 7k, then 91k to 111k per cycle once the claims landed; cache reads count), 51k output, 620 s |
| Task sessions | 5 (three Opus, two Sonnet), 1.46M input tokens, 77k output, 792 s across all 22 tasks |
| Deterministic tasks | 17, each under a second |
| Claims | 358 verified, 46 asserted, 0 promoted |
| Units | command plus four opened, three closed |
| Plans | 9 proposed, 7 applied, 2 rejected (6 rule lines) |

The final tree, from `incident tree 001`:

```
001-command [active]
  001-u02 [closed] Reconnaissance of packages/ ...            t01-t05 done
  001-u03 [closed] Capture the full contents of the four ...  t06-t09 done
  001-u04 [closed] Trace the comment-deletion path ...        t10-t15 done
  001-u05 [active] Close the one remaining inferred step ...  t16-t22 done
```

## Acceptance, criterion by criterion

| # | Criterion | Observed |
|---|---|---|
| 1 | `incident create` produces an incident with one root unit, `command`, and one event. | Yes: `incident.created` then `unit.created` for `001-command` (two events, one transaction). |
| 2 | The first `step` yields an action plan that creates at least one unit and one task, and the validator accepts it. | Yes on cycle 2 (cycle 1's plan was rejected on inputs, which the feedback loop fixed). `unit.created 001-u02`, five `task.created`, `plan.applied`. |
| 3 | Tasks run and their results appear as claims with the right status. | Yes: deterministic tasks entered `claim.verified` (358), sessions entered `claim.asserted` (46), each with provenance naming the task and its effective inputs or session id. |
| 4 | A later `step` closes a unit that has served its purpose, visible in `tree` and `events`. | Yes: cycle 3 closed `001-u02` with the reason "Reconnaissance complete ... No open tasks remain"; `unit.closed` in the log, `[closed]` in the tree. Cycles 4 and 6 closed `u03` and `u04` the same way. |
| 5 | An action plan that breaks span of control is rejected and the next action plan groups instead. | Not observed live: the planner kept every unit at five or fewer children on its own, moving synthesis "to a fresh unit to stay within span of control" (cycle 5's rationale). The rule and the regrouping are covered by `test/validator.test.ts` and `test/runtime.test.ts`. The rejections observed were Inputs validate and Dependencies resolve, and the next plan corrected both. |
| 6 | The incident reaches `satisfied` with a verified claim naming the code path. | Pending Mauria's answer: the incident is `blocked` on `001-q01`. Verified claims already name the path (`PageCard.tsx:1884` in the grep claims of `001-t19`; `focus.ts:40/61/66/73/90` in `001-t13` and `001-t18`). |
| 7 | Every state change has a matching event, checked by a test that replays events against the tables. | Yes: `test/store.test.ts` replays the log and compares tables; on this run, 525 events for 22 tasks, 5 units, 404 claims and 9 plans. |
| 8 | An `interpret` task given too little evidence returns `insufficient` naming what it needs, and the next `step` creates a task that supplies it. | Not observed live: the one `interpret` task was given enough evidence and answered. The path is covered by `test/blocking.test.ts` on the stub. |

## What the run showed about the runtime

- **The feedback loop works.** Two rejected plans were each corrected on the next cycle
  from section 9 alone; the planner's rationale opened with what it fixed.
- **Model routing happened unprompted.** Opus for the two broad traces and the synthesis,
  Sonnet for the two narrow checks.
- **The four channels worked as designed.** Tasks for retrievable facts throughout, and a
  question for a human only when the repository was exhausted, with the planner explaining
  why nothing else could answer it.
- **Promotion never fired.** The planner named up to eleven asserted claims per cycle in
  `claimsToVerify`, but a session's claim (`PageCard.tsx:1884 is the code path that scrolls
  after a comment deletion ...`) never equals a grep match's triple, so exact matching on
  subject, predicate and object promoted nothing. The verified facts arrived beside the
  assertions instead. A looser notion of "established", or the planner proposing the exact
  triple it wants verified, is a design call for the revisit.
- **Grep claims are heavy.** Two greps produced 291 claims in one cycle, each a line in the
  planner's section 2 for every later cycle. This is the "what a claim carries" question set
  aside on 2026-09-13; the run did not break on it, but the planner's input went from 7k
  tokens at cycle 2 to 91k at cycle 3, when those claims landed, and 111k by cycle 9 (the
  `plan.proposed` usage per cycle; cached across cycles, so the spend was mostly cache
  reads).
- **UUID claim ids invite transcription errors.** One mistyped id cost a cycle; claims now
  get positional ids (`001-c381`).
- **Tuning was to the planner input, not the prompts.** Neither the preamble nor the role
  prompts changed; the two fixes were what section 8 shows.

## Event log excerpts

Cycle 1, the first rejection (sequence 3):

```
plan.rejected  validator  Inputs validate: task "Record the repository's current branch, working-tree
state and recent commits touching packages/ ..." inputs do not fit git_history: cwd Invalid input:
expected string, received undefined
```

Cycle 3, the first unit closed (its `unit.closed` event carries the reason):

```
unit.closed  runtime  {"reason":"Reconnaissance complete: deletion code (PageCard.tsx deleteComment@1863,
removedCommentIdSet@1954-2014), all scroll manipulation in src (PageCard.tsx 1016/1121/1155/1224/1330/
2054/2065/2078), and comment selection state ... are located. No open tasks remain."}
```

Cycle 6, an asserted claim from the Opus investigation (`001-t11`):

```
claim.asserted  verifier  subject PageCard.tsx:1884  predicate "is the code path that scrolls after a
comment deletion"  object "deleteComment runs currentEditor.chain().focus().removeCommentIds(...).run()
with no focus options, so tiptap's focus command defaults scrollIntoView to true; ..."  confidence 0.85
```

Cycle 7, the deterministic fact that pins the fallback (`001-t18`, grep on the installed TipTap):

```
claim.verified  verifier  subject .../@tiptap/core/src/commands/focus.ts:90  predicate matches
object {"pattern":"editor.state.selection","text":"    const selection = ... editor.state.selection"}
```

Cycle 9, the question and the block:

```
question.asked    runtime  {"questions":[{"id":"001-q01","text":"Optional confirmation of the one link
that cannot be proven from the repository: when you reproduce the bug, had you most recently added the
bottom comment (or clicked its thread in the rail) before deleting a different comment? ..."}]}
incident.blocked  runtime  {"rationale":"The investigation is evidentially complete. ..."}
```
