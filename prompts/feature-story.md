You are implementing story {{storyId}} — "{{storyTitle}}" ({{storyPoints}} pts) as part of
feature {{featureId}} — "{{title}}", on the feature's single branch.

Repos        : {{storyRepos}}
Unit dir     : {{unitDir}} (your working directory)
Lead worktree: {{worktreePath}} ({{targetRepo}})
Other repos  : {{otherWorktrees}}
Branch       : {{branchName}}
Story file   : {{storyAbsPath}}
Feature file : {{featureAbsPath}}
Backlog repo : {{backlogDir}}

The feature's stories, in dependency order (yours is one of them):
{{storiesPlan}}

{{nudge}}

## Before you start: the theme brief and the road map

{{readTool}} these with the feature file, before you change any code.

- **The feature's theme brief**, the documents its theme names for any work in it:

{{themeBrief}}

- **The road map**, `{{backlogDir}}/roadmap.md`: where the project is heading and the hazards on
  the way (gates such as go-live). The operator sets its statuses by hand. They inform; bl never
  gates on them. Work can go against an entry, for example a production deploy while a go-live
  hazard is not `done`. In that case, warn the operator with a task, `bl task {{featureId}} --title "<the warning>"
  --gate none` (see step 5). Then carry on with the Design as written; do not stop on your own.

## Two-repo model

- The **story file** and the **feature file** live in the backlog repo. You write
  acceptance-criteria checkoffs, and **## Deferred** and **## Notes** additions there.
  Commit them on the backlog's main branch with `git -C {{backlogDir}} …`. They never go on your
  code branch.
- **Code changes** go in each repo's worktree, `{{unitDir}}/<repo>`. Commit them to
  `{{branchName}}`. Do not open a pull request: the feature gets one PR after every story is
  implemented, and `bl run` opens it.

## Worktrees

You work only in the worktrees listed above: the lead worktree and each of the **Other repos**.
All of them are under the work unit's directory. Before you started, `bl run` created each one on
`{{branchName}}` with its dependencies installed, and started you in the work unit's directory.
Make each repo's changes in its own worktree and commit them there on `{{branchName}}`.
`bl merge` merges every repo of the feature. Do not push another repo or open a pull request for
it.

The feature's repos are derived from its stories ({{storyRepos}}, in the order bl prepares,
reviews and merges them: `bl` first, then by first story): a story's one repo is its
component's. Work in a repo that is not listed is one of two things:

- A drive-by change the work needs or found (a fix in a dependency, a doc the change makes stale,
  a blocking bug in another repo): make it with `bl side`, as **Side changes** below says. It
  joins this feature, and `bl run` gates and reviews its repo with the others.
- Work the feature's design is missing (a part of the Goal nobody cut a story for): escalate it,
  and name the repo and the work (see **Writing an escalation**). The operator can then add a story
  to the feature at refine and re-run.

Never create a worktree yourself, never use `bl implement --repo`, and never edit a repo's main
checkout.

## Steps

1. {{readTool}} the feature file (Premise, Design, Acceptance, Deferred) and then the story file.
   The Design section is the contract this story implements; the story's plan says which part.

2. Do not set the story's status. bl records `in_progress` on it before your session starts, and the later statuses from
   the outcome you end with.

3. Implement the plan. When the story fixes a bug, first write a test that fails because of the
   bug, then make it pass. Commit as you go with Conventional Commits. End the subject in ` ({{featureId}} {{storyId}})`
   and wrap the body at 100 columns. Run the tests that cover what you changed, and add the tests
   the plan asks for.

4. Check off every acceptance criterion you satisfied (`- [ ]` → `- [x]`). If you cannot satisfy
   a criterion, leave it unchecked with a one-line note beneath it that says why. `bl run` treats
   unchecked criteria as unfinished work.

5. If you find uncovered work under 8 points, do it now. A finding of
   about one point in code this branch already touches is fixed now too, not deferred;
   a nit is fixed or dropped, never deferred. What is left goes to one of three places:
   - Code work of 8 points or more: a bullet under the feature's **## Deferred**,
     starting with its estimate `[points: N]`. Nothing else goes there: `bl validate` refuses an
     unsized bullet in an open feature's **## Deferred**.
   - A record of what you did or found, or a hand-off to a later story: a dated bullet under the
     feature's **## Notes**, `- <YYYY-MM-DD> ({{storyId}}): …`, with no marker.
   - Anything the operator must do, with a moment to do it: a task. Write its body to a file
     under `{{backlogDir}}/.bl/run/`: what to do, the exact commands as pasteable blocks with
     their expected output, and why it is not code. Then run
     `bl task {{featureId}} --title "<what to do>" --gate <merge|next|none> --body-file <file>`.
     - `--gate merge` holds `bl merge {{featureId}}` until the task is done. Use it for a step
       between the run and the merge, such as a migration.
     - `--gate next` holds every `bl run` and `bl implement` once {{featureId}} is done. Use it
       for a step right after the merge, such as a shared-service restart.
     - `--gate none` holds nothing. Use it for a fact or warning the operator must see.
     - If the operator must choose between options before the unit can merge, title the task
       `Decide: <the choice>` and use `--gate merge`; `bl task` refuses another gate for it. A
       fix or review agent may still act on the recommended option, and records that in the
       unit's `## Notes`. The task stays open for the operator to close.

     `bl task` commits the backlog itself; only the operator runs `bl task done`.

   Never create new stories, except these two:
   - the ad-hoc story for a bug you fixed (see **Blocked by a bug**);
   - a side story for a change in another repo (see **Side changes**).

   Phrase a bullet or task that depends on a merge as "after review and merge, …", never "after
   <repo>#<pr> merges".

6. If the plan is wrong, correct it briefly in the story file and continue. A plan that restates
   a source of truth is corrected, not followed: fix it in the story file, with the reason, and
   build the corrected plan (see **Self-consistent designs** below). An entry added to a guard's
   allowlist needs the same stated reason.

   If the feature's **Premise** turns out to be false, stop. A false Premise means the design
   rests on something the code does not support. Write what you found under **## Escalation**
   in the feature file, as **Writing an escalation** below describes. Commit the backlog and end
   the session. That is the right outcome.

7. When you are done, make **one** backlog commit for the story:

   ```
   bl sync --commit -m "chore: {{storyId}} implemented in {{featureId}}" --story {{storyId}} --path {{featureRelPath}}
   ```

   It takes the backlog lock, commits only two things, the story's directory and the feature
   file, and pushes. It never commits what another session has staged. Never run `git add` or `git commit` in the backlog repo.

8. Format the files you changed (see **Format and lint** below).

{{sessionStack}}

## Scratch files

Write diagnostics (probe scripts, redirected test output, scratch configs) under
`{{scratchDir}}`, never in the worktree. The test gate refuses a dirty worktree, and a
headless session cannot remove files.

{{selfConsistencyGuide}}

{{simplicityGuide}}

{{executionInputs}}

{{blockedByBug}}

{{escalationGuide}}

{{sideChangeGuide}}

{{writingGuide}}

{{toolGuide}}

## Outcome

{{outcomeDelivery}}

{{implementOutcome}}

## IMPORTANT

- NEVER `git add` files that are in `.gitignore`.
- Do NOT run `bl merge`, open a PR, or run any `bl sync` other than the `bl sync --commit` lines
  above.
- Do NOT push. `bl run` pushes once, after every story is done.
- Never ask or tell the operator to merge a PR, and never merge one yourself.
- End with the outcome object that **Outcome** above describes.
