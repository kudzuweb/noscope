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

## Third run

The same objective run a third time on 2026-09-15 (10:15 to 11:09 UTC), with round 3 merged
(PRs 28 to 37, then the two fixes the run forced, 38 and 39), from the same roughdraftplus
working directory at commit 6a996e8, on `NOSCOPE_DB=~/.noscope/third-run.sqlite`, with the
scratch document restored from its pristine copy before each `create`, the same two
constraints as run 002, and one priority: "settling by observation over reading". Mauria was
asleep; the session running the build stepped it by hand and answered the operational
questions as the operator, saying so in each answer.

The run is two incidents on one database. Incident 001 ran the size-up on Haiku, transferred
command to Opus 5 as the briefing recommended, and got one good command turn; then the review
turn, a resumed call carrying the planner's draft, came back from the API with `stop_reason`
`refusal` (category `reasoning_extraction`: "reverse engineering or duplicating model
outputs"), and the same session refused every later resume in under a second. The runtime
retried the flagged session forever, which became PR 38 (a refused session is filed, released
and replaced once; a second refusal stops the cycle). A fresh Opus 5 session then refused its
command turn on a prompt that was only the change report and the incident file. Claude
Code's advice is to change the model, and the design routes the IC's model per incident, so
incident 002 was created with `--ic-model claude-sonnet-5`, the override recorded on the
transfer beside the briefing's own recommendation (Haiku). Incident 001 cost $1.11 and is
kept as the record of the refusal.

### The answer, and how it was reached

The same code path as runs 001 and 002: the rail's Delete button, `deleteComment` in
`PageCard.tsx`, the bare `.focus()` at line 1884 chained before `removeCommentIds`, TipTap's
`focus()` defaulting `scrollIntoView` to true and leaving the selection where it was (a caret
near the document end), and the animation-frame `scrollIntoView` that scrolls the caret to
five pixels inside the bottom edge of the container. The reproduce observed it twice, with
two different middle comments deleted from two different positions, both landing at the same
`scrollTop` (5481) and the same selection offset (14695 of 14695), which the interpret read
as the landing point being a property of the code path and not of the deleted comment. The
three other rail actions (`focusComment` and `focusSuggestion`) pass `{ scrollIntoView:
false }` and `deleteComment` does not.

Two things run 002 had settled this run left open, and said so: the causal claim (002-c021)
is inferred at 0.65 with the strongest alternative named (a coincident scroll from
`removeCommentIds` or a layout pass), and the origin of the pre-delete selection at the
document end (002-c024, inferred at 0.4) was not observed; run 002 had observed the
mount-time `setContent` at line 1422 mapping it there. The IC declared `satisfied` on the
reports with those two links open, judging that neither changes the cause or the responsible
line, which is the same judgment run 002's closing rationale made.

### Measures beside runs 001 and 002

| Measure | Run 001 | Run 002 | Run 003 (incident 002) |
|---|---|---|---|
| Cycles | 12 plans, 10 applied, 2 rejected | 8 plans, 7 applied, 1 rejected | 3 command turns, 2 plans drafted, 1 applied, 1 rejected on 5 rule lines |
| Wall time | 54 min | 63 min | 29 min, plus the 40 min incident 001 spent refused and the two fixes |
| Events | 632 | 367 | 138 |
| Planner | 12 calls, 1.09M input, 74k output, $2.40 to $12.72 | 8 calls, 265k input, 84k output, $4.76 | 2 calls, 17k input, 15k output, $0.50 |
| IC | none | none | 5 calls on Sonnet 5, 277k input (all cache writes), 32k output, $1.28; the last turn's context was 134k, above the 120k handoff threshold, so one more turn would have handed off |
| Initial IC | none | none | 1 Haiku call, 608k input (mostly cache reads), 68 s, $0.15, 21 tool calls |
| Sessions | 7, $3.96 to $27.44 | 11, $11.44 | 3 (one reproduce, one investigate, one interpret), $1.99; plus 5 leader turns on the root, $0.94 |
| Deterministic tasks | 22 | 7 | 2 |
| Claims | 404 verified, 67 asserted | 162 verified, 86 asserted | 11 verified, 13 asserted |
| Human channel | 1 question about the bug | 2 questions and 1 capability request about the fixture | 2 questions from the size-up about intended behavior, answered as out of scope by the operator; none from the IC |
| Total cost at list rates | $6.37 to $40.15 | $16.20 | $4.86, or $5.97 with incident 001 |

### The round-3 changes, cycle by cycle

| Step | What happened | Round 3 under test |
|---|---|---|
| Size-up | Haiku classified the incident ("bug hunt: comment deletion scroll behavior"), found `.focus()` at line 1884 in its one look, sketched two units, recommended Haiku as commander with a reason, asked two questions, and listed hazards. In incident 001 the briefing had sketched a `fix_designer` unit and a "implement the fix" objective. | The briefing's shape and the transfer happened as designed; the size-up over-scopes into fixing and asks intended-behavior questions the objective does not need. Its role text should say that a diagnostic objective takes no fix objective and no question about intended behavior. |
| IC's first turn | Sonnet evaluated the briefing item by item: accepted the reproduction and the trace, rewrote the "confirm the fix would work" objective into establishing what each `.focus()` call site passes, discarded the fix unit and the plan unit citing the operator's answers, and set five period objectives and two priorities. | The evaluation ruling worked: 3 of 5 accepted, 1 rewritten, 1 discarded, each with a why, and the IC was not bound by the Haiku's plan. |
| Draft 1 and review | The planner drafted one working unit with a Sonnet leader holding five tasks and an interpret at command. The IC amended (small changes to instructions). The validator rejected the amended plan on five Effect-policy lines: the unit's Bash allowlist named `grep`, `rg`, `git log`, `git status`, `git diff`, and the rule compared against the seven-command in-process list. | The review round ran as ruled (draft, verdict, apply). The rejection was the runtime's fault: PR 39 gives sessions their own read-only list and names it in the planner's rule. |
| IC's second turn | The IC restated the period, noted the rejection and its cause, and added a priority that a new unit's allowlist use only the published list. | The IC read `command.rejected` and steered; a rejected turn did not advance the period number. |
| Draft 2 and review | The planner put all five tasks directly under `command` and no new unit, "not to be rejected a second time on the allowlist"; the IC approved, calling that a better route than its own. | A validator rejection changed the organization's shape: the planner traded a unit for safety. With PR 39 that pressure is gone. |
| Dispatch | The reproduce (Sonnet, 34 tool calls, 268 s, $0.59) confirmed the behavior twice; the read and grep landed 11 verified claims; the investigate read the installed TipTap's `focus()`; the interpret produced 13 claims with the causal chain and the alternative. All ran under `command`, so the root leader, which is the IC's own session, took the investigate as an assignment inside itself and was resumed after each task for a turn, then reported "met, picture changed". | Per-task events and costing held for tasks run inside a leader's session. Two findings: with the tasks under `command`, the IC's session did the investigate itself, against the ruling that its digging is assigned; and five leader turns on a 100k context cost $0.94, since each resumed call rewrote the whole context at cache-write rates, as R3-3 measured. |
| IC's third turn | The IC read the report and declared `satisfied` with a rationale citing the observed claims and holding scope. | The IC's judgment closed the incident; no planner call was needed. |

Not exercised this run: strike teams (no task declared one), lacks at the leader (no
`insufficient`, no resource request), the handoff (the IC closed one turn before the
threshold), and a `not_met` report.

### What the run found in the runtime

- **Opus 5 refuses the IC's resumed turns.** Category `reasoning_extraction`, twice on one
  session and once on a fresh one; the first command turn on a fresh session passed each
  time. Sonnet 5 ran every turn. The prompts that drew it ask the model to judge and rewrite
  another model's structured output, which is the IC's job; whether wording can avoid it is
  open. Fixed in the runtime by PR 38 (a refusal replaces the session, twice stops the
  cycle); the category was not captured from the stream (review shows `unstated`), only the
  transcript carried it, which is a gap for PR 38's follow-up.
- **The effect policy checked the wrong list.** Fixed by PR 39; the planner's rule now names
  the list.
- **Tasks under `command` run inside the IC.** The built rule that a leader runs matching
  tasks inside its own session applies to the root, so a planner that puts session tasks
  under `command` has the IC do the work. Design call for the revisit list: session-backed
  tasks under `command` should run in their own sessions, or the planner should be told to
  put session work under a unit.
- **Leader turns on a large context are the new cost centre.** Five root-leader turns at
  60k to 115k context cost $0.94, more than the planner's two calls; the resumed-call cost
  model from R3-3 (whole context at cache-write rates) held.
- **The size-up over-scopes.** Both briefings proposed fixing the bug and asked what the
  intended behavior should be; the IC discarded those items each time, at the cost of a
  question round before the IC started. The initial IC's role text should tie its objectives
  and questions to the kind of incident.
- **Reproduce is still the cost centre per task** ($0.59, 910k input mostly cached, 268 s)
  but one was enough where run 002 needed five, because the IC's period objectives told the
  planner exactly what to observe.

## Fourth run

The same objective run a fourth time on 2026-09-15 (23:00 to 23:36 UTC), with round 4 merged
(PRs 40 to 51; every event carries the runtime tag `3b2cd7a`, main after R4-11 merged), from
the same roughdraftplus working directory at commit 6a996e8, on
`NOSCOPE_DB=~/.noscope/fourth-run.sqlite`, with the scratch document restored from its
pristine copy before `create`, run 003's objective, two constraints and priority word for
word, and `--ic-model claude-opus-5` chosen on purpose so that the fallback from R4-7 would
be exercised. The session running the build stepped it by hand, one detached `step` per
cycle, and answered the size-up's two questions as the operator, saying so in each answer.

The run is one incident of four steps. The size-up on Haiku wrote a diagnostic briefing
(three objectives, two units, no fix anywhere), recommended Opus 5 as commander, and asked two
questions about intended behavior, which the operator answered as out of scope. The IC on
Opus 5 took two command turns: the validator rejected the first on "Situation grounded", and
the second, resumed on the same session, passed. Its review turn, a resumed call carrying the
planner's draft, was refused (`reasoning_extraction`) in 1.1 seconds; the runtime retried the
review on Opus 4.8, recorded the transfer as `fallback`, and every later IC call ran there,
five calls with no refusal. Period 1 ran the reproduce and the reproduce unit reported;
period 2 accepted that report, re-cut the code unit, ran its four session tasks and took its
report; period 3 accepted that report and set `satisfied`.

### The answer, and how it was reached

The same code path as runs 001 to 003: the rail's Delete button (`CommentEditorList.tsx`
lines 727 to 737), `deleteComment` at `PageCard.tsx:1863`, the bare `.focus()` at line 1884
chained before `removeCommentIds`, TipTap's `focus` command defaulting `scrollIntoView` to
true, its animation-frame `scrollIntoView`, ProseMirror's `EditorView.scrollToSelection`
assigning `scrollTop` on the page's one scrollable container, and the selection sitting at
the document end (14696 of 14697) before and after every deletion, so the container scrolls
to the bottom, where the last comment's anchor is. The three sibling `focus()` calls at lines
2054, 2065 and 2078 pass `{ scrollIntoView: false }` and `deleteComment`'s does not; the IC's
closing rationale names that omitted option as the operative difference and designs no fix.

Run 003 had left the causal link inferred at 0.65 with an alternative named. Run 004
observed it: the reproduce (the task `001-t04`, Opus 5, 37 tool calls, 278 seconds, $1.85)
instrumented the page's `scrollTop` setters and `scrollIntoView` before deleting, and the
single recorded `scrollTop` assignment carried a stack from `scrollToSelection` through
TipTap's `focus` command's animation frame to the app's delete callback, identical for two
different middle comments (c2 from `scrollTop` 1189 and c3 from 2070, both to 5481). The one
link that reproduction left inferred, at 0.7, was that the minified callback at bundle
offset `770:2220` is `PageCard.tsx`'s `deleteComment`; the code unit's trace task
(`001-t09`) compared the captured minified bodies token for token against
`PageCard.tsx:1882-1891` and `CommentEditorList.tsx:727-737` and raised it to observed at
0.95. Its other two readings established that `removeCommentIds` adds only mark and range
steps and never sets a selection (`001-t10`), and that of every scroll-capable call in the
two component files exactly one runs on the delete path (`001-t11`); the interpret
(`001-t12`) reconciled code with measurement and found no disagreement.

Two residuals are stated, not chosen, and the IC's verdict says neither bears on the named
path or the mechanism. The first is the selection's origin, open since run 003: why the
caret sat at the document end on page load is unattributed (the claim `001-c209`, at
confidence 0.5), with the `focus("end")` effect at `PageCard.tsx:1428-1436` named as an
unobserved candidate. Run 002 had observed the origin, the mount-time `setContent` at line
1422 mapping the caret to the end, and run 004 did not reach it: the enumeration task
`001-t11` read lines 1355 to 1479 of `PageCard.tsx`, which include line 1422, and its claim
named lines 1428 to 1436 instead; nothing carries an earlier incident's findings into a new
one, so each run starts from its own briefing. The second residual is a 13 pixel scroll on
selecting a card, off the delete path (`001-c215`). So the acceptance's last question is
answered no: the selection's origin was not settled.

### Measures beside runs 001 to 003

| Measure | Run 001 | Run 002 | Run 003 (incident 002) | Run 004 |
|---|---|---|---|---|
| Cycles | 12 plans, 10 applied, 2 rejected | 8 plans, 7 applied, 1 rejected | 3 command turns, 2 plans drafted, 1 applied, 1 rejected on 5 rule lines | 4 command turns, 1 rejected on 4 rule lines; 3 plans drafted (one a redraft), 2 applied, 0 rejected |
| Wall time | 54 min | 63 min | 29 min, plus the 40 min incident 001 spent refused and the two fixes | 32 min from the first command turn to `satisfied`, 35 min from `create`; the size-up's questions held it for 19 seconds |
| Events | 632 | 367 | 138 | 422 |
| Planner | 12 calls, 1.09M input, 74k output, $2.40 to $12.72 | 8 calls, 265k input, 84k output, $4.76 | 2 calls, 17k input, 15k output, $0.50 | 3 calls, 115k input, 27k output, $1.79 |
| IC | none | none | 5 calls on Sonnet 5, 277k input (all cache writes), 32k output, $1.28; the last turn's context was 134k, above the 120k handoff threshold, so one more turn would have handed off | 8 calls: 3 on Opus 5 (82k input, 9k output, $0.89, the third refused) and 5 on Opus 4.8 (482k input, 42k output, $4.94); the last turn's context was 170k, above the 120k handoff threshold, so one more turn would have handed off |
| Initial IC | none | none | 1 Haiku call, 608k input (mostly cache reads), 68 s, $0.15, 21 tool calls | 1 Haiku call, 825k input (mostly cache reads), 95 s, $0.20, 28 tool calls |
| Sessions | 7, $3.96 to $27.44 | 11, $11.44 | 3 (one reproduce, one investigate, one interpret), $1.99; plus 5 leader turns on the root, $0.94 | 5 (one reproduce, three investigate, one interpret), all Opus 5, $5.75; plus 6 leader turns on the two units, $2.37 |
| Deterministic tasks | 22 | 7 | 2 | 5, one failed |
| Claims | 404 verified, 67 asserted | 162 verified, 86 asserted | 11 verified, 13 asserted | 162 verified, 54 asserted (10 of them inferred) |
| Human channel | 1 question about the bug | 2 questions and 1 capability request about the fixture | 2 questions from the size-up about intended behavior, answered as out of scope by the operator; none from the IC | 2 questions from the size-up about intended behavior, answered as out of scope by the operator; none from the IC or the planner |
| Total cost at list rates | $6.37 to $40.15 | $16.20 | $4.86, or $5.97 with incident 001 | $15.96 |

Where the $11.10 over run 003 went, from the two reviews' per-role tables:

| Seat | Run 003 | Run 004 | Difference |
|---|---|---|---|
| The IC | Five calls on Sonnet 5 cost $1.28. | Eight calls cost $5.83: three on Opus 5 ($0.89, including $0.37 for the refused review) and five on Opus 4.8 ($4.94). | Run 004 spent $4.55 more, from Opus prices and three more calls: the rejected first turn, the refused review and the correction round's second review. |
| Task sessions | One reproduce on Sonnet 5 ($0.59), one investigate on Sonnet 5 ($0.61) and one interpret on Opus 5 ($0.79) cost $1.99. | The planner put every session on Opus 5: the reproduce cost $1.85 for the same shape of work as run 003's (37 tool calls against 34, 278 seconds against 268), three investigates $2.53 and the interpret $1.37, $5.75 together. | Run 004 spent $3.76 more, and the reproduce's model accounts for $1.26 of it. |
| Leader turns | Five turns of the root's Sonnet 5 session cost $0.94. | Six turns on Opus 5 cost $2.37: the reproduce unit's report ($0.23) and the code unit's four continues and its report ($2.16), the continues alone $1.81 because each rewrote a context of 34k to 100k at cache-write rates for 74 output tokens. | Run 004 spent $1.43 more. |
| The planner | Two calls cost $0.50. | Three calls cost $1.79, the third a redraft ($0.72) for one `dependsOn` entry. | Run 004 spent $1.29 more. |
| The size-up | One Haiku call cost $0.15. | One Haiku call cost $0.20. | Run 004 spent $0.05 more. |

### The IC's verdicts, and what each cost

| Verdict | Where | What it cost |
|---|---|---|
| Accepted, on the reproduce unit's report | The period 2 command turn (Opus 4.8, 76k input, 16.9k output, 215 seconds, $1.18), which also set the period and rewrote the situation with the report's claims by id. | The verdict is part of the command turn, so it cost nothing beyond the turn; the unit closed on it. |
| Accepted, on the code unit's report | The period 3 command turn (Opus 4.8, 170k input, 11.4k output, 151 seconds, $1.27), which also set `satisfied`. | The same: nothing beyond the turn. |
| Revise | None was given. | Nothing; the revise path (R4-3) had no occasion. |
| Reassign | None was given. | Nothing; the reassign path (R4-4) had no occasion. |
| Approve, on the period 1 draft | The review turn, refused on Opus 5 ($0.37 for the refusal, 1.1 seconds) and retried on Opus 4.8 (23k input, 5.5k output, 74 seconds, $0.38). | It cost $0.75 with the refusal counted. |
| Correct, on the period 2 draft | The review turn on Opus 4.8 (99k input, 7.6k output, 100 seconds, $0.96) found the one defect the validator would have rejected: the reconcile task named the new grep in `evidenceFrom` but not in `dependsOn`. | The correction round cost $2.84 and 168 seconds: this turn, the planner's redraft ($0.72, 57 seconds) and the approval below. |
| Approve, on the redraft | The review turn on Opus 4.8 (114k input, 850 output, 11.7 seconds, $1.16). | It cost $1.16 for 850 output tokens, because the resumed call wrote its whole 114k context to cache. |

Both reports were accepted, so no unit was revised and none was reassigned. The IC chose
`correct` over `amend` for the one-line defect because an `amend` carries the whole plan and
the planner held the five tasks' definitions; the runtime asked the planner to re-emit the
plan for one entry.

### Wall time per cycle beside the tasks' seconds

| Step | Cycle wall time | Dispatch span | Tasks' seconds summed | Parallel factor |
|---|---|---|---|---|
| 1, the command turn rejected | The IC's turn took 66 seconds and no task ran. | There was no dispatch. | No task ran. | There was none. |
| 2, period 1 | The cycle took 502 seconds from the resubmitted command turn to the reproduce unit's report. | The dispatch took 303 seconds. | Five tasks summed to 278 seconds: the four deterministic ones finished within 72 milliseconds of starting together, and the reproduce ran 278 seconds alone. | The factor was 0.92x. |
| 3, period 2 | The cycle took 959 seconds from the command turn to the code unit's report. | The dispatch took 667 seconds. | Five tasks summed to 612 seconds: one grep, three investigates of 125, 112 and 257 seconds, and an interpret of 118 seconds. | The factor was 0.92x. |
| 4, period 3 | The IC's turn took 151 seconds and no task ran. | There was no dispatch. | No task ran. | There was none. |

Parallel dispatch saved nothing. The factor is the tasks' summed seconds over the dispatch
span, and the span includes the leader turns after the tasks, which is why it sits below
1.0 with no overlap. In period 1 the runtime did start five tasks in the same 7
milliseconds, but the code unit's investigate depended on the TipTap grep that failed at
once, so the reproduce was the only session task running and the code unit did nothing all
period. In period 2 the planner wrote that "the three readings run in parallel", and two of
the three investigates had no dependency and were ready at the start, but all three ran
inside the code unit's leader session, which R4-9 keeps sequential: the second started when
the first ended and the third when the second ended, with continue turns between them.

### The round-4 changes, cycle by cycle

| Step | What happened | Round 4 under test |
|---|---|---|
| Size-up | Haiku classified the incident ("diagnosis: a scroll behavior bug hunt"), found `.focus()` at line 1884 in 28 tool calls, sketched a reproduce unit on Haiku and a code unit on Opus 5, recommended Opus 5 with a reason, listed four hazards, and asked two questions about intended behavior. | R4-8 held on objectives and units: no fix objective and no fix unit, where both of run 003's briefings had proposed one. It did not hold on questions: both questions asked what the behavior should be, which the role text says a diagnosis does not need. R4-12 stamped the runtime tag on every event from the first. |
| 1, the IC's first turn | Opus 5 evaluated the briefing item by item (two accepted, three rewritten, the questions discarded as answered), set four period objectives and three priorities, wrote the situation, assigned two greps and a `git_history` under command, and was rejected: its situation listed four inferred links under claim ids it had invented (`ic-inf-1-focus-triggers-scroll` and three more), and no claim existed yet. | R4-5's situation is the IC's, and the validator's "Situation grounded" rule checked it against the claim table; the turn cost $0.31 and 66 seconds, and the period number did not advance. R4-6's `assignTasks` carried the deterministic work under command. |
| 2, the resubmitted turn, the draft, the refusal, the pass | The same turn resubmitted with the four links written into the hypothesis and the period objectives, each naming the task ref that settles it. The planner drafted two units, both with Opus 5 leaders: the reproduce unit with one reproduce task, the code unit with an investigate carrying a strike team of two Sonnet 5 readers and an interpret, plus a grep of `node_modules/@tiptap/core` under command that the investigate depended on. The review turn on Opus 5 was refused; Opus 4.8 approved the draft as drafted. Five tasks started at once; the TipTap grep failed in 4 milliseconds (`ENOENT`, no such directory), the other three deterministic tasks landed 157 verified claims, and the reproduce observed the bug twice with the instrumented stack. The reproduce unit's leader reported met, picture changed, and the pass stopped. | R4-7 captured the category from the record (`reasoning_extraction` on `command.failed`, where run 003 recorded `unstated`), retried the review on Opus 4.8 once, recorded the transfer of kind `fallback`, and moved the root unit's leader so every later call stayed there. R4-6 ran the root's deterministic tasks with no leader turn; the planner's rule put the session tasks under led units. R4-9 started the five tasks together. R4-10 created both units as type `base` under the root of type `ic`. R4-1's block under the report, which `incident show` prints with the change report's renderer, shows the reproduce task, its seven claims by id and its 37 tool calls by tool, and the IC's verdict cites those claim ids. The strike team was declared but its task never ran. |
| 3, the verdict, the re-cut, the code unit's pass | The IC accepted the reproduce unit's report, citing its claims by id, rewrote the situation with eleven proven claims and one inferred link (the minified-to-source mapping, `001-c163`, at 0.7), and set four period objectives that dropped the TipTap re-read because the running bundle had been observed. The planner cancelled the two stranded tasks and re-cut the code unit as a grep, three investigates and an interpret; the IC corrected one `dependsOn` line, the planner redrafted, the IC approved. The four session tasks ran in the leader's session one after another with a continue turn between each; the leader reported met with the two residuals stated. | R4-2's `accepted` closed the reproduce unit and recorded `report.reviewed`. R4-5's "Inferred links are worked" rule had one link to check, and the plan settled it by the trace task. The review round pre-empted the validator: the "Dependencies resolve" rule that cost run 002 a cycle was caught by the IC before the validator saw the plan. R4-3, R4-4 and R4-11 had no occasion: the verdict was accepted, and two units are one short of the third repeat that prints the offer to save a config. |
| 4, the closing turn | The IC accepted the code unit's report on its observed claims, wrote a situation with twelve proven claims, no inferred link and fourteen kept, recorded the answer and the two residuals in the period objectives, and set `satisfied`. | R4-2's second `accepted` closed the last unit; the incident closed on the IC's judgment with no planner call. |

Not exercised this run: a `revise` or `reassign` verdict (both reports were accepted), a
saved config, a strike team that ran (the one declared was on the cancelled task), lacks at
the leader, the handoff (the last turn was 170k, one turn short), a `not_met` report, and a
refusal on the fallback.

### What the run found in the runtime

Each is a candidate for round 5, with its evidence.

- **The situation rule has no first turn.** The IC's first command turn wanted to list the
  four links it had not observed as inferred, and the schema's inferred entry takes a claim
  id, so it invented four. "Situation grounded" rejected the turn ($0.31, 66 seconds), and
  the resubmitted turn put the links in the hypothesis as prose with the task refs that
  settle them, which the rule cannot check. A first turn has no claims by construction, so
  either the role text says where unobserved links go before claims exist, or an inferred
  entry may name a task ref instead of a claim id until one exists.
- **R4-8 stopped the fix and not the questions.** The briefing had no fix objective and no
  fix unit, and still asked two intended-behavior questions (`001-q01`, `001-q02`), which
  blocked the incident until the operator answered as out of scope and the IC discarded them.
  R4-8's live test (`test/size-up.test.ts`) asserts that no question matches "intended", or
  "should" followed by it, the, deletion or focus, and both of these would have failed it,
  so the role text's clause on questions did not hold on Haiku in this run.
- **A grep on a missing root fails silently and strands its dependants.** The planner set the
  TipTap grep's root to `node_modules/@tiptap/core` at the repository root, and roughdraftplus
  is a pnpm workspace: the package is at `packages/app/node_modules/@tiptap/core`, a symlink
  into `node_modules/.pnpm/` (verified by `readlink`, 2026-09-15). The grep failed with
  `ENOENT` in 4 milliseconds, the investigate and interpret that depended on it stayed
  pending for the whole period with no event saying why, and the code unit did no work until
  the IC read the failure in the change report and the planner cancelled and re-cut. The
  IC's review had praised the grep for reading the installed version and did not check the
  path either. Candidates: the validator or the dispatcher checks a deterministic task's root
  exists before the pass (what `check_path` does today, by hand); a failed dependency marks
  its dependants blocked with the reason.
- **The planner routed every session to Opus 5 and the IC did not object.** The IC's own
  evaluation said "Haiku is fine for recording" of the reproduce unit, the planner put the
  reproduce and both leaders on Opus 5, and the review turn approved the draft without a
  word on models. The reproduce cost $1.85 against run 003's $0.59 on Sonnet 5 for the same
  work; leaders on Opus 5 made six leader turns $2.37. The period objectives carry no model,
  and nothing in the IC's role text or its review prompt (`src/units/ic.ts:93`,
  `src/ic.ts:862`) asks it to compare the draft's models with its own routing.
- **A `correct` verdict costs a plan round for one line.** The IC chose `correct` because
  `amend` requires the whole plan re-emitted, so a `dependsOn` entry cost a second planner
  call ($0.72) and a second review ($1.16 for 850 output tokens on a 114k context), $2.84
  and 168 seconds in all. An amend that patches by ref would have cost one short turn.
- **Continue turns are the leader's cost centre.** The code unit's four continue turns
  produced 74 output tokens each after the first (347) and cost $0.35, $0.03, $0.51 and
  $0.92 as the session's context grew from 34k to 100k with every investigate it ran inside
  itself; the last one wrote 91k to cache and read 8.6k, the intermittent cache read from
  R3-3 again. A leader whose remaining tasks are already sequenced by the plan is being
  asked, at full context price, whether to continue.
- **Independent investigates inside a leader do not run at once.** The planner's rule says
  independent tasks run together and the planner wrote that its three readings would; two
  of the three had no dependency and were ready together; all three ran one after another
  because they run inside the leader's session. The 0.92x factor above is the measure. Either
  the rule text says which tasks the sequencing applies to, or an investigate with no
  dependency runs in its own session when another is already in the leader's.
- **Opus 5 refuses the review turn, seen twice.** Two command turns on one Opus 5 session
  passed, the second a resumed call, and the review turn over the planner's draft was refused
  in 1.1 seconds, as in run 003. The fallback worked as ruled: five calls on Opus 4.8,
  review turns among them, none refused, so the IC on Opus 4.8 is a working configuration,
  at $4.94 for five calls against Sonnet 5's $1.28 for five in run 003.
- **The IC's turns are long.** The period 2 command turn wrote 16.9k output tokens in 215
  seconds, restating the reproduce's findings in the objectives, the situation, the
  hypothesis and the verdict; the closing turn wrote 11.4k more. Its context reached 170k
  on the last turn, one turn from the handoff, in an incident of three periods.
- **A run does not know the runs before it.** The selection's origin was in a file a task
  read (`PageCard.tsx:1422`, in `001-t11`'s read of lines 1355 to 1479) and in run 002's
  record, and no seat connected them; each incident starts from its own briefing. Whether an
  incident should be able to cite another's claims is a design call for the revisit.

## Fifth run

The same objective run a fifth time on 2026-09-16 (06:59 to 07:57 UTC; 01:59 to 02:57 CDT),
with round 5 merged (PRs 53 to 62 on `round-5`; every event carries the runtime tag
`ef5ad67`), from the same roughdraftplus working directory at commit 6a996e8, on
`NOSCOPE_DB=~/.noscope/fifth-run.sqlite`, with the scratch document restored from its
pristine copy before `create`, run 003's objective, two constraints and priority word for
word, and no `--ic-model`, so the IC ran on Sonnet 5 by R5-6's default. The session running
the build stepped it by hand, one detached `step` per cycle, unattended; nothing asked
for an operator, since the size-up proposed no question.

The run is one incident of five cycles, each one operational period, each accepted whole.
The size-up on Haiku wrote a diagnostic briefing (three objectives, two units, no fix, no
question), recommended Haiku as commander, and command went to Sonnet 5 by the default
with the recommendation recorded. The IC's first turn accepted all five briefing items,
the first briefing any run has kept whole. Period 1 ran the reproduce alone and its unit
reported; the code unit, planned in the same period, never started (below). Period 2 ran
the code unit's three greps and its investigate, then an instrumented reproduce in a new
unit, one after the other; period 3 ran the reconciliation interpret and a
name-correspondence check under the code unit; the fourth command turn crossed the handoff
threshold at 128,967 tokens of context, the outgoing IC wrote its handoff document, and a
fresh session reviewed period 4's draft and ran it: a capture-phase focus reproduction, a
sourcemap probe, two greps and the final statement. The successor's one command turn
accepted that unit's report and set `satisfied`, 55.0 minutes after the first command turn
was recorded (57.9 from `create`), at $9.52.

### The answer, and how it was reached

The same code path as runs 001 to 004: `deleteComment` at `PageCard.tsx:1863-1910`, the
bare `.focus()` at line 1884 chained before `removeCommentIds` where the file's other focus
calls pass `{ scrollIntoView: false }` (`001-c013`, observed), TipTap's `focus` command
taking its `delayedFocus` branch when the view does not already have focus (`001-c014`,
`001-c015`, from the installed `focus.ts`), the animation frame that calls `view.focus()` and
`editor.commands.scrollIntoView()`, ProseMirror's `scrollToSelection` writing `scrollTop`
5481 on the one container the rail and the editor share (`001-c026`, the stack captured
live: `Object.scrollIntoView`, `n4.dispatch`, `Uie.dispatchTransaction`, `n4.updateState`,
`n4.updateStateInner`, `n4.scrollToSelection`, `oD`, the setter), and the selection sitting
near the document end before and after every deletion, so the destination is the same
whichever comment is deleted (`001-c076`, `001-c088`: the anchor's offset 354 and its
absolute position unchanged by the deletion; 5481 for c2, c3, c4 and c1 across three
reproductions).

Two things are new. The first reproduce (`001-t01`) read `document.activeElement` before and
after the click and found the editor both times (`001-c006`, `001-c007`), which the IC's
period 2 turn marked against the focus story; the instrumented reproduce (`001-t07`)
caught a focus hop to the Delete button and back within about 21 milliseconds
(`001-c025`), and the IC's period 3 turn reclassified `001-c007` from against to for,
naming the first reading a resolution gap. Period 4's capture-phase reproduce (`001-t11`)
then observed the precondition `delayedFocus` needs: at the capture-phase click, before
React's handler runs, `activeElement` is the Delete button and the ProseMirror view reports
`hasFocus()` false (`001-c071`, `001-c072`), and the `scrollTop` write lands inside a
`requestAnimationFrame` callback about 20 milliseconds after the click, with both the
write-time stack and the frame's scheduling stack captured verbatim (`001-c074`). Run 002
had observed the same (`hasFocus()` false at the capture-phase click, its cycle 6); runs
003 and 004 did not, and this run observed it with the write's timing beside it.

The second is how the origin link was graded. Run 004's trace task (`001-t09` there)
compared the minified callback at bundle offset `770:2220` with `PageCard.tsx:1882-1891`
token for token and raised the link from the bundle to `deleteComment` to observed at 0.95.
Run 005's IC set a period 4 priority not to call a mangled or anonymous frame observed on
name similarity or calling position; the sourcemap probe (`001-t12`) found none by three
routes (no `sourceMappingURL` in the 1,870,223-character bundle, the `.map` URL answered
with the SPA's `index.html` exactly as a fabricated path was, no map or build directive in
the repository, `001-c063` to `001-c068`); and the final statement (`001-t15`, Opus)
graded the origin link inferred at 0.7 (`001-c083`), the IC accepted at 0.7 to 0.8 and
deferred the open item as the production build's limit. The two runs settled the same
link differently. Run 004's reading is the more defensible on this link: a token-for-token
match of a minified body against its source is a content comparison, not a name
resemblance, and nothing in run 005 did it. Run 005's discipline is the sounder rule and
was applied to the wrong gap, and the run held the observation that would have closed the
link and did not deliver it: `001-t11`'s scheduling stack reads `window.requestAnimationFrame`
from `Object.focus (289:55242)` from `770:2220` from `onClick (738:12806)` through React's
dispatch, the same `770:2220` run 004 matched to `deleteComment`, and `001-c075` says so at
0.8; the final statement wrote that the scheduling stack "is not quoted in the attached
result" (`001-c083`, `001-c095`, `001-c096`), because the brief renderer attached
`001-t11`'s observations and not its claims, where the session had put the stack text
(the finding below). The write side is observed to a three-frame segment matched by
literal method name and call order against the bundled `prosemirror-view`
(`001-c048` to `001-c052`, from the grep `001-t09`), and two alternatives the code trace
raised, a `scrollTop` clamp from the container shrinking and a remounted container, are
ruled out on runtime evidence (`001-c031`, `001-c032`, `001-c092`, `001-c093`).

### Measures beside runs 001 to 004

| Measure | Run 001 | Run 002 | Run 003 (incident 002) | Run 004 | Run 005 |
|---|---|---|---|---|---|
| Cycles | 12 plans, 10 applied, 2 rejected | 8 plans, 7 applied, 1 rejected | 3 command turns, 2 plans drafted, 1 applied, 1 rejected on 5 rule lines | 4 command turns, 1 rejected on 4 rule lines; 3 plans drafted (one a redraft), 2 applied, 0 rejected | 5 command turns, 0 rejected; 4 plans drafted, 4 applied, 0 rejected, 0 redrafts |
| Wall time | 54 min | 63 min | 29 min, plus the 40 min incident 001 spent refused and the two fixes | 32 min from the first command turn to `satisfied`, 35 min from `create`; the size-up's questions held it for 19 seconds | 55.0 min from the first command turn to `satisfied`, 57.9 min from `create`; nothing waited on an operator |
| Events | 632 | 367 | 138 | 422 | 365 |
| Planner | 12 calls, 1.09M input, 74k output, $2.40 to $12.72 | 8 calls, 265k input, 84k output, $4.76 | 2 calls, 17k input, 15k output, $0.50 | 3 calls, 115k input, 27k output, $1.79 | 4 calls on Opus 5, 115k input, 37k output, 470 s, $1.80 |
| IC | none | none | 5 calls on Sonnet 5, 277k input (all cache writes), 32k output, $1.28; the last turn's context was 134k, above the 120k handoff threshold, so one more turn would have handed off | 8 calls: 3 on Opus 5 (82k input, 9k output, $0.89, the third refused) and 5 on Opus 4.8 (482k input, 42k output, $4.94); the last turn's context was 170k, above the 120k handoff threshold, so one more turn would have handed off | 10 calls on Sonnet 5, none refused: 5 command turns, 4 reviews, 1 handoff; 802k input, 80k output, 869 s, $2.94; the fourth command turn's context was 128,967, so command was handed off mid cycle 4 |
| Initial IC | none | none | 1 Haiku call, 608k input (mostly cache reads), 68 s, $0.15, 21 tool calls | 1 Haiku call, 825k input (mostly cache reads), 95 s, $0.20, 28 tool calls | 1 Haiku call, 688k input (mostly cache reads), 61 s, $0.19, 21 tool calls, 0 questions |
| Sessions | 7, $3.96 to $27.44 | 11, $11.44 | 3 (one reproduce, one investigate, one interpret), $1.99; plus 5 leader turns on the root, $0.94 | 5 (one reproduce, three investigate, one interpret), all Opus 5, $5.75; plus 6 leader turns on the two units, $2.37 | 8 (four reproduce and one investigate on Sonnet 5, $2.54; three interpret, two on Opus 5 and one on Sonnet 5, $1.47), $4.01; plus 5 leader turns on the four units, $0.59 |
| Leader turns beside endings that needed no turn | none | none | 5 turns on the root, one per ending | 6 turns: 1 on the reproduce unit, 5 on the code unit (4 continues, 1 report); every session ending called its leader | 5 turns for 4 reports (1 each on `001-u02`, `001-u04`, `001-u05`; 2 on `001-u03`, one a continue with nothing ready); 14 endings needed no turn |
| Deterministic tasks | 22 | 7 | 2 | 5, one failed | 6, none failed |
| Claims | 404 verified, 67 asserted | 162 verified, 86 asserted | 11 verified, 13 asserted | 162 verified, 54 asserted (10 of them inferred) | 96 asserted, all from sessions: 52 observed, 44 inferred; 0 verified (R5-1) |
| Evidence beside claims | not counted | not counted | not counted | 4 deterministic results under the new rendering (R5-1's replay), beside 162 grep-promoted claims in the run itself | 6 deterministic results (`001-t02` 17 matches in 5 files, `001-t04` 87 in 16, `001-t03` 26 in 6, `001-t09` 26 in 1, `001-t14` 1 in 1, `001-t13` none), beside 96 claims |
| Human channel | 1 question about the bug | 2 questions and 1 capability request about the fixture | 2 questions from the size-up about intended behavior, answered as out of scope by the operator; none from the IC | 2 questions from the size-up about intended behavior, answered as out of scope by the operator; none from the IC or the planner | none: the size-up proposed no question, and the IC, the planner and the units raised none |
| Total cost at list rates | $6.37 to $40.15 | $16.20 | $4.86, or $5.97 with incident 001 | $15.96 | $9.52 |

The acceptance asked for cost at or below run 003's $4.86 and wall time below 29 minutes
with run 004's evidence. The run cost $9.52, $4.66 over, and took 55 minutes, 26 over, with
evidence better than run 004's on the reproduce side (the instrumented stack, the
capture-phase focus reading, the sourcemap probe) and weaker on the origin link's grading.
Where the money went, from the three reviews' per-role tables:

| Seat | Run 003 | Run 004 | Run 005 |
|---|---|---|---|
| The IC | Five calls on Sonnet 5 cost $1.28. | Eight calls cost $5.83, three on Opus 5 and five on Opus 4.8. | Ten calls on Sonnet 5 cost $2.94: five command turns $1.53, four reviews $0.81, the handoff turn $0.60. Run 005 made two more command turns and two more reviews than run 003, and the handoff. |
| Task sessions | Three sessions cost $1.99. | Five sessions, all Opus 5, cost $5.75. | Eight sessions cost $4.01: four reproduces on Sonnet 5 $1.63 (`001-t01` $0.78, `001-t07` $0.34, `001-t12` $0.09, `001-t11` $0.42), one investigate on Sonnet 5 $0.91, three interprets $1.47 (`001-t08` $0.63 and `001-t15` $0.64 on Opus 5, `001-t10` $0.20 on Sonnet 5). Run 004's one Opus reproduce cost $1.85; run 005's four on Sonnet cost $1.63 together. |
| Leader turns | Five turns on the root cost $0.94. | Six turns on Opus 5 cost $2.37. | Five turns on Sonnet 5 cost $0.59, on inputs of 20k to 30k tokens (contexts of 11k to 21k). |
| The planner | Two calls cost $0.50. | Three calls cost $1.79. | Four calls on Opus 5 cost $1.80 ($0.29, $0.47, $0.37, $0.68), a fifth of the run; the planner's own seat is the one model choice round 5 did not touch. |
| The size-up | One Haiku call cost $0.15. | One Haiku call cost $0.20. | One Haiku call cost $0.19. |

Against run 003, the difference is two more command turns and two more planner calls (the
IC $1.66 more, the planner $1.30 more) and five more sessions ($2.02 more), and the
leaders cost $0.35 less. Against run 004, the IC cost $2.89 less, the sessions $1.74 less
and the leaders $1.78 less, for two more IC calls and three more sessions.

### The IC's verdicts, and what each cost

Every report was accepted and every draft approved, so no revise, reassign, correct or
amend occurred and R4-3, R4-4 and R5-3's patch path had no occasion. Each verdict on a
report is part of the command turn that set the next period; each approve is a review
turn on the same session, resumed with the draft alone.

| Call | Context, cache write, cache read | Output, seconds, cost | What it decided |
|---|---|---|---|
| Command turn 1 (fresh session) | 15,800 written, 0 read. | 9,109 output, 101 s, $0.16. | It accepted the briefing's five items, set three period objectives and three priorities, seeded two open items from the briefing, and assessed `on_track`. |
| Review 1 | 32,692 context; 32,690 written, 0 read. | 3,650 output, 41 s, $0.17. | Approve: the draft ran the reproduce unit and the code unit's greps together, held the models to the rule, and worked both open items. |
| Command turn 2 | 51,406 context; 51,404 written, 45,635 read (the call summed 97,043 input over its API turns). | 8,341 output, 83 s, $0.30. | Accepted `001-u02`'s report on its eleven observed claims by id, closed the unit, marked `001-c007` against the picture, settled `001-o02`, assessed `priors_updated`. |
| Review 2 | 60,438 context; 27,746 written, 32,690 read. | 3,117 output, 37 s, $0.15. | Approve: the instrumented reproduce in a new unit, the stale interpret cancelled and re-cut, Opus on the reconcile with its why. |
| Command turn 3 | 81,907 context; 30,501 written, 51,404 read. | 15,030 output, 163 s, $0.28. | Accepted `001-u04`'s report on ten observed claims, closed it, folded 21 claims into the picture, reclassified `001-c007` to for and marked `001-c019` against, narrowed `001-o01`, assessed `priors_updated`. |
| Review 3 | 100,621 context; 40,183 written, 60,436 read. | 3,316 output, 39 s, $0.21. | Approve: one grep and a Sonnet interpret to test the stack's names against the bundled source frame by frame. |
| Command turn 4 | 128,967 context; 47,060 written, 81,905 read. | 14,062 output, 158 s, $0.35. | Accepted `001-u03`'s report, crediting its self-correction of `001-t08`'s overstatement, closed it, marked nine claims against the stronger picture, deferred `001-c047`'s side finding, set the focus-timing and sourcemap objectives, assessed `priors_updated`. |
| Handoff | 139,497 context; 139,495 written, 0 read. | 4,171 output, 49 s, $0.60. | It wrote an 11,695-character document: the period, every unit's state, the hypothesis, two set-asides and two next moves. |
| Review 4 (fresh successor) | 56,580 context; 46,418 written, 10,160 read. | 6,666 output, 72 s, $0.29. | It evaluated the handoff (13 of 13 items accepted) and approved period 4's draft, naming the two independent reproduces and the reasoned Opus on the final statement. |
| Command turn 5 | 88,136 context; 78,597 written, 9,537 read. | 12,937 output, 126 s, $0.45. | Accepted `001-u05`'s report, folded in `001-c063` to `001-c096`, deferred `001-o01` at the production build's limit, assessed `priors_updated`, set `satisfied`. |

The handoff cost $0.89 of IC calls where a resumed review cost $0.15 to $0.21 ($0.60 for
the document and $0.29 for the fresh session's review), and the successor's command turn,
resumed on that review, read 88k. Cache reads: five of the eight resumed calls read the previous
call's context; the first review, the handoff turn and the successor's command turn did
not read the previous call's context (the first two wrote their whole context, the third
78,597 of its 88,136), the intermittent miss the Reference table records.

### Wall time per cycle beside the tasks' seconds

| Step | Command turn | Cycle wall time after it | Dispatch span | Tasks' seconds summed | Parallel factor | Critical path and possible factor |
|---|---|---|---|---|---|---|
| 1, period 1 | 101 s | 505 s: the planner 90 s, the review 41 s, the dispatch. | 371 s: the reproduce `001-t01` 323 s, then its unit's report turn 46 s. | One task, 323 s. The code unit's three greps and investigate were ready and never started. | 0.87x. | 323 s (`001-t01`), 1.00x possible: the interpret `001-t06` depended on `001-t01`, which related the two units and held the code unit's pass behind the reproduce unit's. |
| 2, period 2 | 83 s | 833 s: the planner 153 s, the review 37 s, the dispatch. | 642 s: three greps in 0.1 s, `001-t05` 350 s, the code unit's continue turn 81 s, then `001-t07` 138 s and its unit's report turn 69 s. | Five tasks, 488 s. | 0.76x. | 350 s (`001-t03` then `001-t05`), 1.40x possible: `001-t07` had no dependency and ran after `001-t05` because `001-t08` depended on both, relating the units again. |
| 3, period 3 | 163 s | 552 s: the planner 57 s, the review 39 s, the dispatch. | 455 s: the grep in 0.0 s, `001-t08` 213 s, `001-t10` 149 s, the report turn 91 s. | Three tasks, 362 s. | 0.80x. | 362 s (`001-t08` then `001-t10`), 1.00x possible: the plan was a chain. |
| 4, period 4 | 158 s, then the handoff 49 s | 753 s: the planner 170 s, the handoff, the successor's review 72 s, the dispatch. | 458 s: two greps and `001-t12` (58 s) beside `001-t11` (203 s), then `001-t15` 185 s, the report turn 68 s. | Five tasks, 445 s. | 0.97x. | 388 s (`001-t11` then `001-t15`), 1.15x possible. The two reproduces ran together as the priority asked. |
| 5, the closing turn | 126 s | No plan and no dispatch. | none | none | none | none |

The run was a chain. Its seats' seconds sum to 3,371 (the IC 869, the planner 470, the
sessions 1,619, the leaders 354, the size-up 61), against 3,474 seconds from `create` to
`satisfied`, so almost nothing overlapped anything: the only work that ran beside other
work was the greps, and `001-t12` beside `001-t11`. Two things made it so. The dispatcher's
`relatedUnits` (`src/dispatcher.ts:407-427`) serializes two whole units when any unended
task of one depends on any unended task of the other, so the code unit waited behind the
reproduce unit in period 1 and the instrumented reproduce behind the code unit's
investigate in period 2, though neither dependent task could have started before its
dependency in any case. And every one of the four reports said the picture changed, which
halts the pass: in period 1 the halt cancelled the code unit's pass that the serialization
had delayed, so it ran nothing; in period 2 `001-t08` had become ready when `001-t07`
landed and waited for period 3; in periods 3 and 4 nothing else was runnable. Each period
then costs a command turn, a planner call and a review before the next wave: $0.62 of
seats in cycle 1, $0.92 in cycle 2, $0.86 in cycle 3, $1.92 in cycle 4 with the handoff,
$0.45 for the closing turn, and 4 to 8 minutes of wall time each. Run 003 reached the
answer in one dispatch because its plan put the reproduce, the investigate and the
interpret under command in one period.

### The models the planner chose

Every model the planner named, with the `modelWhy` the plan carried, read from the
`plan.proposed` events (`incident review` does not list them yet, R5-6's record).

| Period | Seat | Model | `modelWhy` |
|---|---|---|---|
| 1 | Leaders of `001-u02` and `001-u03` | Sonnet 5 | none, none needed |
| 1 | `001-t01` reproduce, `001-t05` investigate | Sonnet 5 | none, none needed |
| 1 | `001-t06` interpret (cancelled in period 2) | Opus 5 | "This task decides the incident's conclusion: it must weigh several competing mechanisms against numeric runtime measurements and code citations, distinguish what is directly observed from what is only consistent, and refuse an attractive but unproven lead; that judgement is the one step here that is weighing evidence to a conclusion rather than recording or reading." |
| 2 | Leader of `001-u04`; `001-t07` reproduce | Sonnet 5 | none, none needed |
| 2 | `001-t08` interpret | Opus 5 | "This task weighs three independent bodies of evidence (a multi-file code trace, eleven runtime claims and a raw call-stack log) against each other to reach a single attribution and to mark the boundary between observed and inferred; it is conclusion-drawing over conflicting evidence, not recording or reading, and the period objective turns on getting that boundary right." |
| 3 | `001-t10` interpret | Sonnet 5 | none; the rationale said the weighing to a conclusion was already `001-t08`'s on Opus, and the IC's review agreed that a name-and-order check is Sonnet's |
| 4 | Leader of `001-u05`; `001-t11` and `001-t12` reproduce | Sonnet 5 | none, none needed |
| 4 | `001-t15` interpret | Opus 5 | "This task weighs some sixty claims and four new bodies of evidence, several of them in tension (a prior reconciliation found to overstate, a graded correspondence table, and new runtime and sourcemap findings), into a single per-link verdict with confidences that will close the incident; that is weighing evidence to a conclusion, not recording or reading, and the cost of a wrongly-marked observed link here is the incident's answer being wrong." |

No `plan.warned` was recorded: every Opus task carried a why, and every `dependsOn` was
also in `evidenceFrom.tasks`. The IC's four reviews each named the models and held the
draft to the rule in their rationale.

### The round-5 changes, cycle by cycle

| Step | What happened | Round 5 under test |
|---|---|---|
| Size-up | Haiku classified the incident ("diagnosis: comment deletion scroll behavior"), found `deleteComment` at lines 1863 to 1910 in 21 tool calls, checked four needs, sketched a reproduce unit and an investigation unit on Haiku, listed four hazards, recommended Haiku as commander, and proposed no question. Command went to Sonnet 5 by the default, the recommendation recorded on the transfer. | R5-6's default put the IC on Sonnet 5 and recorded rather than followed the recommendation. R5-8 had nothing to gate: for the first time the size-up asked no intended-behavior question, so the incident was never blocked and `create` returned in 61 seconds; whether R4-8's clause held by chance or by the role text cannot be told from one run. |
| 1, the first turn, the draft, the pass | Sonnet accepted all five briefing items, kept the size-up's `.focus()` finding as an open item rather than a fact, and assessed `on_track`. The planner drafted two units, Sonnet leaders, the reproduce, three greps feeding a Sonnet investigate, an Opus interpret with a why depending on the trace and the reproduce. The validator passed the draft and the IC approved it in one review. The reproduce ran alone (41 tool calls, 323 s, $0.78) and its unit's leader, called once at close, reported met, picture changed; the pass halted and the code unit never started. | R5-2 seeded the first picture from the briefing and the IC edited it, with two runtime-numbered open items (`001-o01`, `001-o02`) both worked by the plan's `settles`. R5-3 validated before the review: 0 rule lines, 1 IC read. R5-6 held: Sonnet everywhere, Opus on the interpret with its why, and the review said so. R5-7's rule shaped the draft (the planner wrote that only the interpret waits on the reproduce) and could not see what the dispatcher did with it: `relatedUnits` held the code unit behind the reproduce unit, and the halt on the report cancelled it, so the period's critical path line reads 1.00x possible for a plan that allowed two. R5-5: the ending called nobody (`unit.continued` by the runtime) and the leader took one turn, the report. |
| 2, the verdict, the re-cut, the two passes | The IC accepted the report citing eleven claims by id, closed the unit, marked `001-c007` against the picture and assessed `priors_updated`. The planner added an instrumented reproduce under a new unit, cancelled the stale interpret and re-cut it under the code unit reading all three evidence bodies; approved as drafted. The code unit's pass ran the three greps in 0.1 s and the investigate (38 tool calls, 350 s, 1.41M input tokens, 1.33M of them cache reads, $0.91); with `001-t08` still waiting on `001-t07`, its leader was called at close, tried to assign a reconcile investigate of its own, and was refused on four rule lines for the one assignment (no `question` input, no model, 150,000 tokens with 0 of 56,000 left, 900 seconds with 250 left), then continued to nothing ($0.12, 81 s). The instrumented reproduce then ran (19 tool calls, 138 s, $0.34) and its leader reported met, picture changed. | R5-4 ran the investigate and both reproduces in sessions of their own with the leaders' contexts at 11k to 21k, but `001-t05` and `001-t07` ran one after the other, not together: `001-t08` depended on both, which related their units. R5-1: the greps landed as three evidence lines and no claim; the investigate's eleven claims cite no grep, so their basis is the session's own. R5-5's call at close with nothing ready produced the run's one turn with no decision behind it. R5-10 had no failure to settle and "Paths exist" refused nothing, since every grep root existed. |
| 3, the correspondence check | The IC accepted the instrumented report on ten observed claims, folded 21 claims into the picture, reclassified `001-c007` to for, marked the clamp alternative `001-c019` against, and narrowed `001-o01` to whether the stack's names correspond to the source. The planner added one grep and a Sonnet interpret beside the running `001-t08`; approved. `001-t08` (Opus, 213 s, $0.63) reconciled and claimed a one-to-one stack-to-source match; `001-t10` (Sonnet, 149 s, $0.20) confirmed three frames by literal name and call order and found `001-t08`'s claim overstated (`001-c062`); the leader reported met, picture changed, with the self-correction in its changes. | R5-2's living picture did what the row says: an assessment per turn (`on_track`, then `priors_updated` four times), a stance reversed on finer evidence, the unit's slice folded in. R5-11 briefed the resumed turn with the changed sections; by the session's context the third command turn added about 21k tokens over the second review where the second had added about 18k over the first, so the briefing did not shrink (below). |
| 4, the handoff, the settling period | The IC accepted the code unit's report, marked nine claims against the stronger picture, set two independent settling objectives and a stopping rule, and its context reached 128,967 tokens; it wrote the handoff document ($0.60) and was released. The planner drafted one Sonnet-led unit with two independent reproduces, two greps and an Opus final statement with its why. The fresh session evaluated the handoff (13 of 13 accepted) and approved the draft. The two greps and the sourcemap probe ran beside the focus-timing reproduce, the final statement followed, and the leader reported met, picture changed. | The handoff ran live for the first time (R3-9, R5-11): the threshold was crossed on the fourth command turn under the changed-section briefing, which R5-11's row was written to prevent. R5-7 held inside the unit: 0.97x measured against 1.15x possible, the closest of the run. R5-6: Sonnet on both reproduces and the leader, Opus on the final statement with its why, which the successor's review named. R5-1's basis rule entered all seventeen of the final statement's claims `inferred`, since each cites a session task beside the greps. |
| 5, the closing turn | The successor accepted the report, folded in 34 claims, deferred `001-o01` under period 4's stopping rule and set `satisfied` at inferred 0.7 to 0.8 on the origin link. | R5-2's deferral with a why is what let the incident close with an open item on the record rather than a fifth period. R5-6: ten Sonnet 5 IC calls, review turns among them, none refused, where Opus 5 refused the review in runs 003 and 004. |

Which of the eleven rows earned its keep, in the acceptance's words. R5-6 did: Sonnet on
every reproduce, investigate and leader, Opus on three interprets each with a why, the IC
on Sonnet 5 through ten calls with no refusal, and four reproduces for $1.63 against run
004's one for $1.85. R5-4 and R5-5 did: eight sessions of their own, leaders' contexts of
11k to 21k where run 004's code leader grew to 124k, fourteen endings that called nobody,
five leader turns for $0.59 against six for $2.37. R5-1 did: six evidence lines and 96
claims where run 004's file carried 162 grep-promoted claims, and the planner's largest
input 38k against run 004's 56k. R5-2 did: the assessments, the reversed stance and the
deferral are the story of the run and are in the record. R5-7 did its half and the
dispatcher undid it: both plans that allowed parallel work were serialized by
`relatedUnits`, and the critical path line is what shows it. R5-3, R5-8 and R5-10 had no
occasion: no draft broke a rule, no question was proposed, no task failed; each cost
nothing and proved nothing this run. R5-11 did not: the changed sections were most of the
file every period, the context grew 30k to 47k per period across the command turn and the
review, and the handoff came on the fourth command turn at 129k, against run 004's 170k on
its fourth under whole-file briefings, past the threshold either way.

### What the run found in the runtime

Each is a candidate for round 6, with its evidence.

- **`relatedUnits` serializes units, and should hold tasks.** `src/dispatcher.ts:407-427`
  relates two units when any unended task of one depends on any unended task of the other,
  and a related unit's pass waits for the other's to end. In period 1 `001-t06` depended on
  `001-t01`, so the code unit's three greps and its investigate, which needed nothing from
  the browser, waited behind the reproduce (events 38 to 91 are `001-t01` alone) and never
  started, since the halt ended the pass; in period 2 `001-t08` depended on `001-t07`, so the instrumented
  reproduce started at 07:23:16, after `001-t05` had landed at 07:21:53 and the leader had
  turned, though nothing of its own waited. The critical path line reads 1.00x and 1.40x
  possible against 0.87x and 0.76x measured. R5-7's warning could not fire: every
  `dependsOn` was a real `evidenceFrom` one. The fix candidate is to hold the dependent
  task rather than the dependent unit: a pending task whose dependency is in another unit
  waits as it does within one, and the units' passes run at once.
- **A met report always changes the picture, and the halt costs a period.** The leader's
  `pictureChanged` (`src/models.ts:672`, "whether what the unit found changes the picture
  the incident is working from, so the IC should act before anything new starts") was
  true on all four reports, and each halted the pass (`src/dispatcher.ts:587`). A unit
  whose objective is met has by construction changed the picture. In period 1 the halt
  cancelled the code unit's pass; in period 2 it left `001-t08`, ready, for the next period.
  A period costs its command turn, planner call and review before the next wave, $0.86
  to $0.92 of seats in cycles 2 and 3, where the period took 12 to 15 minutes, 4 to 5 of
  them the command turn, the planner and the review, which is why a run whose session work
  sums to 27 minutes took 55. Candidates: the halt holds only tasks that depend on the
  reporting unit's output, or the report says which other units the change concerns; or
  the IC's verdict runs while unrelated ready work continues.
- **A unit's share counts cache reads as spend, so one session exhausts it.** The
  investigate `001-t05` read 1,410,251 input tokens, 1,329,151 of them cache reads across
  38 tool calls; `unitShare` (`src/units/base.ts:213-256`) charges `inputTokens +
  outputTokens` of every `task.usage` against the plans' allotment (56,000 here: `001-t05`'s
  40,000 and `001-t08`'s 16,000), so the code unit's leader was told it had 0 of 56,000 left
  with 1,457,269 spent or bound, and its one assignment was refused under "Budget within
  share" (event 176). A plan's token budget is written as if it were new tokens; the
  runtime charges the billed input, which for a session that reads files is mostly the
  same context re-read per tool call. Either the share is charged at what the tokens cost
  (cache reads at a tenth) or in uncached and cache-write tokens, or the plan's budget
  field is defined as billed input and the planner told what a session bills. The same
  turn was refused on `question` missing and no model named, so the leader's assignment
  schema was also unclear to it; that turn ($0.12, 81 s) then continued to nothing.
- **A leader called at close with nothing ready is a call for process.** R5-5 calls the
  leader "when nothing is ready and the unit owes a report". In period 2 the code unit
  owed nothing it could report (`001-t08` waited on another unit) and the leader answered
  continue after trying to assign. A unit whose remaining task waits on another unit's
  task has no decision to make; the call could be skipped when every pending task of the
  unit waits on a task outside it.
- **R5-11 did not stop the handoff.** The IC's context on its command turns was 15,800,
  51,406, 81,907 and 128,967 tokens (`contextTokens`, the figure the threshold reads); the
  review turns between them sat at 32,692, 60,438 and 100,621. By those figures and the
  retained answers (7k to 12k characters of turn JSON, about 2k to 3k tokens; the billed
  output of 8k to 15k is mostly reasoning the session does not keep), the resumed
  briefings were about 18k, 21k and 28k tokens and the review prompts about 15k, 7k and
  16k, so the session grew 30k to 47k per period (35.6k, 30.5k and 47.1k between command
  turns). The whole file at the same moments is
  bounded by the planner's context, 20k, 30k and 38k including the planner's own preamble
  and rule texts, so the changed-section briefing was within a few thousand tokens of the
  whole file: every period changed the command picture, the claims, the tasks, the units,
  the reports and the situation. The exact saving cannot be derived, since the briefing
  text is not in the log; the bound says it was small. By summed input the third turn
  (81,907) read less than the second (97,043), which is the measure R5-11's acceptance
  test uses; the second turn's call spanned two API messages (45,635 read and 51,404
  written), and by context, which is what the threshold reads, every turn grew. Candidates: the
  review turn on its own short-lived session rather than the IC's, since it carries the
  draft alone and adds 7k to 16k to the IC's context each period; the change report not
  restating the claims section 2 already carries; a higher threshold for Sonnet 5, whose
  window is not the constraint at 129k.
- **The planner's seat is on Opus 5 and nothing weighed it.** Four calls cost $1.80, the
  same as run 004's three, a fifth of the run and more than the IC's five command turns.
  R5-6 governs the models the planner names, not its own; the Model choices row says
  "Opus 5 is the default for anything nontrivial" from 2026-09-12. A run with the planner
  on Sonnet 5 would show whether the drafts hold up; this run's drafts were approved four
  times without a correction.
- **A result attached by reference loses its claims, and the run lost its best
  observation to it.** `renderTaskResult` (`src/capabilities/session.ts:66-83`) renders an
  attached session result's `summary`, `conclusion`, `reasoning` and `observations` and
  not its `claims`. `001-t11`'s observation for its last step says "rafSchedStack
  captured" and puts the stack's text in a claim's object (`001-c074`); the final
  statement (`001-t15`), briefed with `001-t11` in `evidenceFrom.tasks` and with claims
  `001-c001` to `001-c062` (the ones that existed when the plan was drafted; `001-t11`'s
  did not yet), wrote three claims that the stack was not attached (`001-c083`,
  `001-c095`, `001-c096`) and graded the origin link 0.7. The stack names
  `Object.focus (289:55242)` called from `770:2220` from `onClick`, the offset run 004
  matched to `deleteComment` token for token; the incident closed without it. Candidates:
  the attached result renders its claims with their objects; or a task that depends on
  another in the same plan is briefed with that task's claims when they land, not only
  with the ones the plan could name.
- **An interpret's claims are `inferred` by rule, so the observed count reads low.**
  R5-1's verifier keeps a claim's basis only when every task it cites is a completed
  deterministic task in the brief's `evidenceFrom`; `001-t08` and `001-t15` cite the
  session tasks they weigh (`001-t07`, `001-t05`, `001-t11`, `001-t12`), so all 32 of their
  claims entered `inferred`, including "no sourcemap exists" at 0.95 (`001-c090`), which
  restates six observed claims of `001-t12`. The three interprets produced 47 of the 96
  claims (15, 15 and 17), 38 of them inferred; the observed 52 are the four reproduces' 37,
  the investigate's 6 and the correspondence check's 9 (the last citing nothing, so its
  own labelling stands). Run 004 had 54 asserted with 10 inferred beside 162 grep-promoted
  verified ones. The rule is right that an interpret observes nothing itself; the count
  then needs the reader to look through to what it rests on, which `review` could print as
  claims by the capability that made them.
- **The two runs graded one link differently, and neither compared bodies this time.** Run
  004's trace raised the bundle-to-source link to 0.95 by a token-for-token comparison;
  run 005 forbade name similarity, found no sourcemap, and graded it 0.7 while holding the
  scheduling stack above. A body comparison is an observation a `reproduce` or an
  `investigate` can make in one task; nothing carries run 004's from one incident to the
  next, which is the open question on memory across incidents.
- **Two notes from Mauria for round 6**, made 2026-09-16 00:54 to 00:56 CDT while the round
  was merging (relayed by the orchestrating session; not in the run's record): a deployable
  rebase unit per incident, so that units' branches integrate without waiting on each
  other's merges; and two-wave parallel builds for the orchestrator, the rows that rewrite
  shared files first and the rule and text rows after, since this round's rows conflicted
  on `DESIGN.md`, `docs/architecture.html` and the build record when rebased (R5-8's
  record).
