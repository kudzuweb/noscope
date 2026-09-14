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
| Planner calls | 12, 1.09M input tokens over the run (4k, 7k, then 91k to 130k per cycle once the claims landed; cache reads count), 74k output, 930 s |
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


## Prompt changes from this run

Round 2 changed the prompts in these ways, each motivated by a cycle of this run (the
planner's system prompt and rules in `src/planner.ts`, the session preamble in
`src/providers/base.ts`, the role texts in `src/capabilities/investigate.ts`):

| Change | The cycle that motivated it |
|---|---|
| Every claim carries a basis, observed or inferred, and the preamble defines what a confidence number means. | Cycle 3: `001-t11` asserted the link that Mauria's answer later falsified at 0.75, saying "is inferred" only inside the claim's text. |
| The investigate role adds, for every inferred claim, a "settled by:" evidence item naming the runtime observation or file that would settle it. | Cycle 3: `001-t11` did so only because that one brief asked; no other brief did, and the planner acted on it at cycle 9. |
| The interpret role names the strongest alternative and what would decide it, and treats the hypothesis in the brief's head as under test. | Cycle 6: `001-t17`'s brief told the session which chain to confirm and what to mark inferred; it returned that chain at 0.8 to 0.9. |
| The planner settles a link the repository cannot establish by reproducing it or by a question in the same plan, never by more reading. | Cycles 6 to 9: four cycles verifying around the resting-selection link that only running the app could settle. |
| A brief to interpret carries the question and the evidence by reference, never the expected conclusion. | Cycle 5: a plan rejected on 31 hand-copied evidence items; cycle 6: the leading brief above. |
| The plan carries a situation, and the rationale says only why this plan. | Every cycle: plans of 2.6k to 13.3k output tokens, the longest taking 155 seconds, each rationale restating the whole chain. |

## Second run

The same objective rerun on 2026-09-14 (03:52 to 04:56 UTC), with round 2 merged (PRs 20
to 26; from cycle 5 it ran with the first two of the three fixes the run forced, below),
from the same roughdraftplus working directory at the same commit 6a996e8, on `NOSCOPE_DB=~/.noscope/second-run.sqlite`.
Roughdraft 0.1.10 served a scratch document at `~/.noscope/second-run/document.md`: a
heading, an intro line and 42 body paragraphs, with five comments in YAML endmatter anchored
in body paragraphs 1, 12, 16, 32 and 39 (the sessions' numbering, which this section
follows), so the page scrolls and the editor takes the `setContent` branch. Two constraints: the app
runs at that URL on a scratch copy of the document, which `reproduce` may change; the
repository is read only. Nothing tracked in the repository changed; the screenshots that
landed in its tree are below.

### The answer, and how the step that code cannot prove was settled

The same code path: the bare `focus()` at `PageCard.tsx:1884` in `deleteComment`, Tiptap's
`focus` command defaulting `scrollIntoView` to true and scheduling `view.focus()` plus
`editor.commands.scrollIntoView()` in an animation frame once the Delete button has taken
DOM focus, ProseMirror's `scrollToSelection` writing the container's `scrollTop`, and the
selection resting at the document end because the mount-time `setContent` at line 1422
maps it there and rail-card clicks never move it (`findCommentRange`'s traversal returns
false for non-text nodes, so it yields null). The closing rationale on cycle 8: every link
from the Delete click to the `scrollTop` write is verified from source or observed on the
live page; the one residual attribution, whether line 1422 originates the end selection or
preserves one already there, changes neither the cause, the responsible line nor the fix.

Run 001 reached the resting selection through Mauria: its cycle 9 question tested a wrong
explanation, her answer falsified it, and a cycle 10 investigation found the document-end
explanation, pinned as code facts and never observed. Run 002 asked no question about the
bug. It settled the link by five `reproduce` sessions on Playwright:

| Cycle | What the browser showed |
|---|---|
| 1 | Deleting c1, c3, c2 and c4 in turn scrolled the container to `scrollTop` 5481 of 5681 every time, leaving only c5 visible; the caret sat at the end of paragraph 42 at every deletion; the window never scrolled. |
| 5 | With the caret placed in paragraph 20 before deleting, the view scrolled to 2307 and showed the caret's paragraph, not c5. On every load the selection was at position 14696 of 14697 before any interaction; clicking a card never moved the selection (c1, c2 and c3 were tried). A real click moved DOM focus from the editor to the Delete button; the scrolling animation frame was scheduled synchronously inside that click's handler. With the editor keeping DOM focus and a programmatic delete, the comment was removed and nothing scrolled. |
| 6 | The served bundle at the coordinates of the captured stack frame reads `.chain().focus().removeCommentIds(...).run()`, the shape of lines 1884 and 1885; `view.hasFocus()` was false at the capture-phase click on Delete; `setContent` moved a start and a mid-document selection to 14696. |
| 7 | The JSON comparison at line 1421 evaluated true at mount (the two documents differ only by the endmatter key), so line 1422 ran; on a real card click the `descendants` traversal made 44 callbacks on block nodes and none on text. |

The two questions the planner did ask, both at cycle 4, were operational: the scratch
document had run out of comments, and which browser Mauria uses. The operator answered
both and provided the reset (`incident provide`, below). Chrome is this machine's default
browser, verified in the LaunchServices preferences.

### Measures beside run 001

No thresholds; the measure is what it took to reach the same answer.

| Measure | Run 001 | Run 002 |
|---|---|---|
| Cycles | 12 plans, 10 applied, 2 rejected on 6 rule lines. | 8 plans, 7 applied, 1 rejected on 1 rule line. |
| Wall time | 54 minutes, stepped by hand, with Mauria's answer between cycles 9 and 10. | 63 minutes, stepped by hand, including six minutes blocked at cycle 4, during which the operator answered, built `incident provide` and provided the reset. |
| Events | 632 | 367 |
| Planner | 12 calls, 1.09M input tokens (4k, 7k, then 91k to 130k once the grep claims landed), 74k output, 930 s, est $2.40 to $12.72. | 8 calls, 265k input tokens (8k, 58k, 28k, 29k, 25k, 33k, 40k, 44k), 84k output, 1023 s, $4.76. The drop after cycle 2 is consistent with R2-3 collapsing the 139 grep claims that landed in cycle 1 (inferred from the rule, not measured). |
| Sessions | 7: five investigate (three Opus, two Sonnet) and two interpret; 2.8M input, 121k output, 1300 s, est $3.96 to $27.44. | 11: one investigate, five reproduce and five interpret, all Opus; 4.7M input (almost all cache reads), 192k output, 2322 s, $11.44. The five reproduce sessions are $6.48 of it. |
| Deterministic tasks | 22 | 7 |
| Claims | 404 verified, 67 asserted, 0 promoted. | 162 verified, 86 asserted, 0 promoted. |
| Human channel | 1 question, about the bug. | 2 questions and 1 capability request, all about the fixture and the browser. |
| Total cost at list rates | est $6.37 to $40.15 (usage carried no cost then). | $16.20 |

### The round-2 changes, cycle by cycle

Each round-2 change was watched for on every cycle. Where one did not happen, the reason.

| Cycle | What happened | Round 2 under test |
|---|---|---|
| 1 | Two units and a seven-task chain in one plan: check_path, git_history and two greps feeding an Opus investigate, a Playwright reproduce in parallel, and an interpret depending on both; all ran in the cycle. 144 verified and 18 asserted claims. | The situation was written (hypothesis, empty proven and inferred lists), the chain ran by ref in one cycle, tasks named evidence in `evidenceFrom` rather than copying it, the reproduce named `playwright_browser`, and the interpret brief carried only the question. One thing did not happen: the interpret came back `insufficient` because the brief rendered the reproduce result as `undefined: undefined` per observation, a runtime bug fixed on this PR. |
| 2 | Section 10 read the situation back; the plan listed seven proven claims and seven inferred links each with what settles it, kept eleven claims in view, closed the code unit, and sent three greps against the Tiptap and PageCard sources, a discriminating reproduce and an interpret fed by 24 claim ids and six task ids. | Every change happened, though the interpret's brief still carried the unfixed renderer's `undefined: undefined` lines for both reproduce results; it worked from the claims instead and returned eleven. Planner input was 58k here, with the greps fresh, and 28k the cycle after, once they collapsed. The discriminating reproduce came back `insufficient`: cycle 1's reproduce had deleted four comments and its deletions were persisted, so the scratch document held one comment, then none. |
| 3 | Rejected on one rule line: the interpret named a grep in `evidenceFrom` that it depended on only through the reproduce between them, and Dependencies resolve wants the direct `dependsOn`. | Whether a transitive dependency should satisfy the rule is a design call for the revisit; the planner dropped the grep next cycle and kept the reproduce and the interpret. |
| 4 | The plan re-issued the discriminating reproduce with a UI seeding step, asked two questions (restore the fixture; which browser) and requested a capability (a way to reset the scratch document); the incident went `blocked` and the queued tasks waited. | The channels fired as designed, but a capability request had no way back to `open`: `incident answer` counted every request as waiting forever. `incident provide` was built on this PR, the operator restored the document from a pristine copy, answered both questions and provided the reset. |
| 5 | A 28-second plan that added nothing and let the queued chain run: the reproduce ran its three tests and the interpret confirmed the hypothesis with sixteen claims. | The planner held structure steady instead of duplicating work; every change happened. |
| 6 | Closed the first reproduce's unit; one reproduce read the served bundle at the captured stack coordinates and measured `hasFocus()` at the click, exercising `setContent` and the traversal live; an interpret reconciled. | Every change happened. The plan named thirteen inferred links with what settles each. |
| 7 | A new unit for the two secondary mechanisms: one reproduce that deleted nothing, one interpret. | Every change happened. The primary path was already closed on cycle 6; cycles 6 and 7 bought confidence on the secondary links, at $4.63 together, $3.25 of it the four sessions. |
| 8 | Closed the last unit, nominated seven claims for verification, `satisfied`. | The closing rationale said why the residual attribution does not change the answer, rather than spending another cycle on it. |

### What the run found in the runtime

- **A stale build ran the first attempt.** `bin/noscope.mjs` runs `dist/` with no staleness
  check, and main's `dist/` predated round 2 because `pnpm check` had run in worktrees.
  The first cycle ran without a situation, `evidenceFrom` or `reproduce`; that attempt was
  discarded and the run restarted after `pnpm build`. Logged as a papercut.
- **The brief renderer assumed investigate's shape.** A reproduce result attached by
  reference rendered as `undefined: undefined` per observation. Fixed: observations render
  by their own fields (`where: what`, or `step: observed` with the screenshot path), and
  the brief test covers a reproduce result.
- **A capability request blocked an incident for good.** Fixed with `incident provide`:
  the answer to the oldest unanswered request, recorded as `capability.answered`, read by
  the planner in section 1, and reopening the incident once nothing else waits.
- **Reproduce consumes its fixture.** Every deletion persisted to the scratch document, so
  the second reproduce found nothing to delete; the planner's UI-seeding fallback was never
  needed because the operator restored the file, but two cycles and the block were spent
  on it. A reproduce task that restores its fixture first, or a fixture the runtime copies
  fresh per task, belongs on the revisit list.
- **Named screenshots escaped the output directory.** Every reproduce session named its
  screenshots, and Playwright MCP resolves a named file against the server's working
  directory rather than `--output-dir`, so twelve screenshots landed in the roughdraftplus
  working tree, untracked. Moved to `~/.noscope/second-run/screenshots/`; fixed by starting
  the server inside its output directory.
- **Dependencies resolve rejects transitive chains.** One cycle lost; see cycle 3.
- **Promotion still never fires.** Seven claims nominated on the closing plan, none
  matched a verified triple, as in run 001.
- **Reproduce is the cost centre.** Five sessions, 3.3M input tokens (mostly cache reads),
  1227 s, $6.48; each installs instrumentation and takes screenshots around the steps it is
  there to observe. The brief is small (the first reproduce's first cache write was 57k of
  its 1.39M input), so the size is inferred to come from the session's own tool calls.
