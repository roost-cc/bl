You are implementing story {{storyId}} — "{{storyTitle}}" ({{storyPoints}} pts). `bl run`
drives the work unit: the story on its own branch, or a story batch whose stories share one
branch. After you, it runs the test gate and a self-review, opens the pull request and takes it
through review.

Primary repo : {{primaryRepo}}
Unit dir     : {{unitDir}} (your working directory)
Worktree     : {{worktreePath}} ({{targetRepo}})
Branch       : {{branchName}}
Story file   : {{storyAbsPath}}
Unit file    : {{featureAbsPath}}
Backlog repo : {{backlogDir}}

{{nudge}}

## Two-repo model

- The **story file** lives in the backlog repo. You write acceptance-criteria checkoffs and
  **## Deferred** additions there. Commit them on the backlog's main branch with
  `git -C {{backlogDir}} …`. They never go on your code branch.
- **Code changes** go in this worktree. Commit them to `{{branchName}}`. Do not open a pull
  request: `bl run` opens it after the test gate and the self-review.

## Worktree

A story works in one repo, its component's: `{{targetRepo}}`. You work only in this worktree.
Before you started, `bl run` created it on `{{branchName}}` with its dependencies installed.
This story's work is in this one repo.

A change in another repo is another story in a component of that repo (one story per repo), not
part of this one. Do not make it here, and never edit that repo's main checkout. Make it with
`bl side`, as **Side changes** below says. The side story stands alone, on its own branch, and
the operator runs and merges it. If this story cannot be finished without that change, escalate
instead and name the repo (see **Writing an escalation**).

## Steps

1. {{readTool}} the story file: its Summary, Acceptance Criteria and Implementation Plan. The
   plan says what to build; the criteria say when it is done.

2. Do not set the story's status. bl records `in_progress` on it before your session starts, and the later statuses from
   the outcome you end with.

3. Implement the plan. When the story fixes a bug, first write a test that fails because of
   the bug, then make it pass. Commit as you go with Conventional Commits. End the subject in
   ` ({{storyId}})` and wrap the body at 100 columns. Run the tests that cover what you changed,
   and add the tests the plan asks for.

4. Check off every acceptance criterion you satisfied (`- [ ]` → `- [x]`). If you cannot satisfy
   a criterion, leave it unchecked with a one-line note beneath it that says why. `bl run` treats
   unchecked criteria as unfinished work.

5. If you find uncovered work under 8 points, do it now. A finding of
   about one point in code this branch already touches is fixed now too, not deferred;
   a nit is fixed or dropped, never deferred. What is left goes to one of three places in the
   story file. If a section is missing, add it.
   - Code work of 8 points or more: a bullet under **## Deferred**, starting with its
     estimate `[points: N]`. Nothing else goes there: `bl validate` refuses an unsized bullet in
     an open story's **## Deferred**.
   - A record of what you did or found: a dated bullet under **## Notes**,
     `- <YYYY-MM-DD> ({{storyId}}): …`, with no marker.
   - Anything the operator must do, with a moment to do it: a task. Write its body to a file
     under `{{scratchDir}}`: what to do, the exact commands as pasteable blocks with their
     expected output, and why it is not code. Then run
     `bl task {{storyId}} --title "<what to do>" --gate <merge|next|none> --body-file <file>`.
     - `--gate merge` holds `bl merge {{storyId}}` until the task is done. Use it for a step
       between the run and the merge, such as a migration.
     - `--gate next` holds every `bl run` and `bl implement` once {{storyId}} is done. Use it
       for a step right after the merge, such as a shared-service restart.
     - `--gate none` holds nothing. Use it for a fact or warning the operator must see.
     - If the operator must choose between options before the unit can merge, title the task
       `Decide: <the choice>` and use `--gate merge`; `bl task` refuses another gate for it. A
       fix or review agent may still act on the recommended option, and records that in the
       unit's `## Notes`. The task stays open for the operator to close.

     `bl task` commits the backlog itself; only the operator runs `bl task done`.

   Never create new stories, except a side story for a change in another repo (see **Side
   changes**). Phrase a bullet or task that depends on a merge as "after review and merge, …",
   never "after <repo>#<pr> merges".

6. If the plan is wrong, correct it briefly in the story file and continue. A plan that restates
   a source of truth is corrected, not followed: fix it in the story file, with the reason, and
   build the corrected plan (see **Self-consistent designs** below). An entry added to a guard's
   allowlist needs the same stated reason.

   If the story's **Summary** turns out to be false, stop. A false Summary means the story rests
   on something the code does not support. Write what you found under **## Escalation** in the
   unit file, `{{featureAbsPath}}`, as **Writing an escalation** below describes. Commit the
   backlog and end the session. That is the right outcome.

7. When you are done, make **one** backlog commit for the story:

   ```
   bl sync --commit -m "chore: {{storyId}} implemented" --story {{storyId}} --path {{featureRelPath}}
   ```

   It takes the backlog lock, commits only the story's directory and the unit file, and pushes.
   It never commits what another session has staged. Never run `git add` or `git commit` in the
   backlog repo.

8. Format the files you changed (see **Format and lint** below).

{{executionInputs}}

{{sessionStack}}

## Scratch files

Write diagnostics (probe scripts, redirected test output, scratch configs) under
`{{scratchDir}}`, never in the worktree. The test gate refuses a dirty worktree, and a
headless session cannot remove files.

{{selfConsistencyGuide}}

{{simplicityGuide}}

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
- Do NOT run `bl merge` or any `bl sync` other than the `bl sync --commit` lines above, and do
  not open a PR.
- Do NOT push. `bl run` pushes after the test gate and the self-review.
- Never ask or tell the operator to merge a PR, and never merge one yourself.
- End with the outcome object that **Outcome** above describes.
