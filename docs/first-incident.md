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

The incident reached `satisfied` on cycle 12, after Mauria answered its one question. The
closing rationale, with every link cited to a verified claim:

Responsible code path: `PageCard.deleteComment` (`packages/app/src/PageCard.tsx:1863-1907`)
runs `currentEditor.chain().focus().removeCommentIds(...).run()` with no focus options (the
`.focus()` at line 1884). In the installed `@tiptap/core` 3.22.4, `focus()` defaults
`scrollIntoView` to true (`focus.ts:26,40`), keeps the editor's existing selection when no
position is given (`focus.ts:90`), and, unless the view already has DOM focus
(`focus.ts:73`), schedules `view.focus()` plus `tr.scrollIntoView()` on the next animation
frame (`focus.ts:61,66`). `removeCommentIds` (`editor-extensions.ts:130-196`) never sets or
scrolls the selection, so the scroll target is whatever selection the editor already had,
never the deleted comment's position.

Why the bottom comment: the editor is created without autofocus, so its selection starts at
the document start (`prosemirror-state state.ts:28`). The mount effect at
`PageCard.tsx:1421-1422` calls `setContent` whenever the parsed document differs from the
editor's JSON, which is guaranteed when the file carries YAML frontmatter or endmatter
(`critic-markup/index.ts:2047,2050` attach keys that `Node.toJSON` never emits), and comments
live in YAML endmatter, so any document with a comment to delete takes that branch.
`setContent` replaces the whole range (`setContent.ts:63`), ProseMirror's step map sends the
start caret to the end of the inserted content (`map.ts:105-106`), and `Selection.near`
resolves it to the end of the last textblock (`selection.ts:243`). Every deletion thereafter
scrolls the document end, where the bottom comment's anchor sits, into view, whichever
comment was deleted. That matches Mauria's answer: it happens after every deletion, and the
only prior interaction was the previous deletion and a manual scroll up, neither of which
moves the selection.

Every other scroll or focus site was enumerated and excluded with a cited reason. Two links
stay inferred because a read-only repository cannot prove them: that DOM focus has left the
editor when Delete is clicked (nothing on the path prevents the default), and that Mauria's
own file takes the `setContent` branch (it follows from comments living in endmatter). The
runtime named the confirming observation: log `editor.state.selection` and `view.hasFocus()`
before the chain at `PageCard.tsx:1882`. Fix direction, as a recommendation with no change
made: `focus(undefined, { scrollIntoView: false })` at line 1884, as `focusComment` and
`focusSuggestion` already do at 2054, 2065 and 2078, or drop `focus()` from the chain as
`applyPendingApprovals` does.

Before the answer, on cycle 9, the runtime's working explanation had the selection resting
on the last-added or last-clicked comment's anchor; it declared the evidence complete and
asked the one question the repository could not answer:

> When you reproduce the bug, had you most recently added the bottom comment (or clicked
> its thread in the rail) before deleting a different comment?

Mauria's answer, "No, it happens after every deleted comment", contradicted that link. The
next cycle's planner said so in its rationale, replaced it with the document-end explanation
above, verified each of its code facts deterministically, and closed.

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
| 10 | Mauria answered (`incident answer`, reopened). The planner read the answer as contradicting its inferred link, said so, and sent one grep and one Opus investigation after where the selection rests; the investigation found the mount-time `setContent` mapping. | 9 m 37 s |
| 11 | The synthesis unit closed and a verification unit opened; four greps pinned the app, TipTap and ProseMirror facts of the new chain, and an Opus `interpret` assembled the final statement. | 3 m 33 s |
| 12 | `satisfied`, with the verification unit closed and the rationale citing verified claims for every link. | 42 s |

Totals, from the event log (`incident review 001` computes the same figures since PR 19, with the planner's per-cycle spend and the cost bounded at list rates):

| Measure | Value |
|---|---|
| Wall time | 54 minutes of runtime (13:33 to 14:27 UTC), across twelve cycles, with Mauria's answer between cycles 9 and 10 |
| Events | 632 |
| Planner calls | 12, 1.09M input tokens over the run (7k, 7k, then 91k to 130k per cycle once the claims landed; cache reads count), 74k output, 930 s |
| Task sessions | 7 (four Opus, two Sonnet, one Opus interpret twice), 2.8M input tokens, 121k output, 1301 s across all 29 tasks |
| Deterministic tasks | 22, each under a second |
| Claims | 404 verified, 67 asserted, 0 promoted |
| Units | command plus five opened, five closed |
| Plans | 12 proposed, 10 applied, 2 rejected (6 rule lines) |
| Questions | 1 asked, 1 answered |

The final tree, from `incident tree 001`:

```
001-command [active]
  001-u02 [closed] Reconnaissance of packages/ ...            t01-t05 done
  001-u03 [closed] Capture the full contents of the four ...  t06-t09 done
  001-u04 [closed] Trace the comment-deletion path ...        t10-t15 done
  001-u05 [closed] Close the one remaining inferred step ...  t16-t24 done
  001-u06 [closed] Verify by deterministic search the code facts behind the resting-selection explanation ...  t25-t29 done
```

## Acceptance, criterion by criterion

| # | Criterion | Observed |
|---|---|---|
| 1 | `incident create` produces an incident with one root unit, `command`, and one event. | Yes: `incident.created` then `unit.created` for `001-command` (two events, one transaction). |
| 2 | The first `step` yields an action plan that creates at least one unit and one task, and the validator accepts it. | Yes on cycle 2 (cycle 1's plan was rejected on inputs, which the feedback loop fixed). `unit.created 001-u02`, five `task.created`, `plan.applied`. |
| 3 | Tasks run and their results appear as claims with the right status. | Yes: deterministic tasks entered `claim.verified` (358), sessions entered `claim.asserted` (46), each with provenance naming the task and its effective inputs or session id. |
| 4 | A later `step` closes a unit that has served its purpose, visible in `tree` and `events`. | Yes: cycle 3 closed `001-u02` with the reason "Reconnaissance complete ... No open tasks remain"; `unit.closed` in the log, `[closed]` in the tree. Cycles 4 and 6 closed `u03` and `u04` the same way. |
| 5 | An action plan that breaks span of control is rejected and the next action plan groups instead. | Not observed live: the planner kept every unit at five or fewer children on its own, moving synthesis "to a fresh unit to stay within span of control" (cycle 5's rationale). The rule and the regrouping are covered by `test/validator.test.ts` and `test/runtime.test.ts`. The rejections observed were Inputs validate and Dependencies resolve, and the next plan corrected both. |
| 6 | The incident reaches `satisfied` with a verified claim naming the code path. | Yes, on cycle 12: `incident.closed` with the rationale above; the validator's Status is earned rule held (every task completed, verified claims present, no channel raised). Verified claims name the path (`PageCard.tsx:1884` in `001-t19`'s grep claims, `focus.ts:40/61/66/73/90` in `001-t13` and `001-t18`, the mount-time `setContent` and the ProseMirror mapping in `001-t25` to `001-t28`). |
| 7 | Every state change has a matching event, checked by a test that replays events against the tables. | Yes: `test/store.test.ts` replays the log and compares tables; on this run, 632 events for 29 tasks, 6 units, 471 claims and 12 plans. |
| 8 | An `interpret` task given too little evidence returns `insufficient` naming what it needs, and the next `step` creates a task that supplies it. | Not observed live: the one `interpret` task was given enough evidence and answered. The path is covered by `test/blocking.test.ts` on the stub. |

## What the run showed about the runtime

- **The feedback loop works.** Two rejected plans were each corrected on the next cycle
  from section 9 alone; the planner's rationale opened with what it fixed.
- **Model routing happened unprompted.** Opus for the two broad traces and the synthesis,
  Sonnet for the two narrow checks.
- **The four channels worked as designed.** Tasks for retrievable facts throughout, and a
  question for a human only when the repository was exhausted, with the planner explaining
  why nothing else could answer it. The answer changed the conclusion: the planner read it
  as contradicting its inferred link, said so in the next rationale, and found the stronger
  explanation, which is the reason the channel exists.
- **Promotion never fired.** The planner named up to eleven asserted claims per cycle in
  `claimsToVerify`, but a session's claim (`PageCard.tsx:1884 is the code path that scrolls
  after a comment deletion ...`) never equals a grep match's triple, so exact matching on
  subject, predicate and object promoted nothing. The verified facts arrived beside the
  assertions instead. A looser notion of "established", or the planner proposing the exact
  triple it wants verified, is a design call for the revisit.
- **Grep claims are heavy.** Two greps produced 291 claims in one cycle, each a line in the
  planner's section 2 for every later cycle. This is the "what a claim carries" question set
  aside on 2026-09-13; the run did not break on it, but the planner's input went from 7k
  tokens at cycle 2 to 91k at cycle 3, when those claims landed, 111k by cycle 9 and 130k
  by cycle 12 (the `plan.proposed` usage per cycle; cached across cycles, so the spend was
  mostly cache reads).
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

Cycle 12, the close:

```
unit.closed      runtime  {"reason":"All five tasks completed. The resting-selection chain is now backed
by verified claims (001-c451..c462) and the final root-cause statement (001-c463..c471) was assembled
and reconciled with Mauria's answer to 001-q01. No work remains in this unit."}
incident.closed  runtime  {"rationale":"The objective ... is established. Responsible code path (verified
by deterministic search): PageCard.tsx:1884 ..."}
plan.applied     runtime  {"incidentStatus":"satisfied", ...}
```

