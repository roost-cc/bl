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
  the way (gates such as go-live). Its statuses are set by hand and inform; bl never gates on
  them. When the work would go against an entry (a production deploy while a go-live hazard is
  not `done`), warn the operator with a task, `bl task {{featureId}} --title "<the warning>"
  --gate none` (see step 5), and carry on with the Design as written; do not stop on your own.

## Two-repo model

- The **story file** and the **feature file** live in the backlog repo. Status
  updates, acceptance-criteria checkoffs, and **## Deferred** and **## Notes**
  additions are written there and committed on the backlog's main branch with
  `git -C {{backlogDir}} …`. They never go on your code branch.
- **Code changes** go in each repo's worktree, `{{unitDir}}/<repo>`, and are committed to
  `{{branchName}}`.
  Do not open a pull request: the feature gets one PR after every story is
  implemented, and `bl run` opens it.

## Worktrees

You work only in the worktrees listed above: the lead worktree and each of the **Other repos**,
all under the unit directory. `bl run` created every one of them on `{{branchName}}` before you
started, with its dependencies installed, and started you in the unit directory. Make each repo's
changes in its own worktree and commit them there on `{{branchName}}`; `bl merge` merges every
repo of the feature. Do not push another repo or open a pull request for it.

The feature's repos are derived from its stories ({{storyRepos}}, in the order bl prepares,
reviews and merges them: `bl` first, then by first story): a story's one repo is its
component's. Work in a repo that is not listed is one of two things:

- A drive-by change the work needs or found (a fix in a dependency, a doc the change makes stale,
  a blocking bug in another repo): make it with `bl side`, as **Side changes** below says. It
  joins this feature, and `bl run` gates and reviews its repo with the others.
- Work the feature's design is missing (a part of the Goal nobody cut a story for): escalate (see
  **Writing an escalation**), naming the repo and the work, so the operator can add a story to
  the feature at refine and re-run.

Never create a worktree yourself, never use `bl implement --repo`, and never edit a repo's main
checkout.

## Steps

1. {{readTool}} the feature file (Premise, Design, Acceptance, Deferred) and
   then the story file. The Design section is the contract this story
   implements; the story's plan says which part.

2. Set `status: in_progress` in the story frontmatter.

3. Implement the plan. Commit as you go with Conventional Commits, the subject
   ending in ` ({{featureId}} {{storyId}})`, body wrapped at 100 columns. Run the
   tests that cover what you changed; add tests the plan asks for.

4. Check off every acceptance criterion you satisfied (`- [ ]` → `- [x]`). A
   criterion you cannot satisfy stays unchecked with a one-line note beneath it
   saying why — the loop treats unchecked criteria as unfinished work.

5. Uncovered work under 8 points: do it now. A finding of about one point in code this branch
   already touches is fixed now too, not deferred; a nit is fixed or dropped, never deferred.
   What is left goes to one of three places:
   - Follow-up code work of 8 points or more: a bullet under the feature's **## Deferred**,
     starting with its estimate `[points: N]`. Nothing else goes there: `bl validate` refuses an
     unsized bullet in an open feature's **## Deferred**.
   - A record of what you did or found, or a hand-off to a later story: a dated bullet under the
     feature's **## Notes**, `- <YYYY-MM-DD> ({{storyId}}): …`, with no marker.
   - Anything the operator must do, with a moment to do it: a task. Write its body (what to do,
     the exact commands as pasteable blocks with their expected output, and why it is not code)
     to a file under `{{backlogDir}}/.bl/run/`, then run
     `bl task {{featureId}} --title "<what to do>" --gate <merge|next|none> --body-file <file>`.
     `--gate merge` holds `bl merge {{featureId}}` until the task is done (a step between the
     run and the merge, such as a migration); `--gate next` holds every `bl run` and
     `bl implement` once {{featureId}} is done (a step right after the merge, such as a
     shared-service restart); `--gate none` holds nothing (a fact or warning the operator must
     see). `bl task` commits the backlog itself; only the operator runs `bl task done`.

   Never create new stories, except the ad-hoc story for a bug you fixed (see **Blocked by
   a bug**) and a side story for a change in another repo (see **Side
   changes**). Phrase a bullet or task that depends on a merge as
   "after review and merge, …", never "after <repo>#<pr> merges".

6. If the plan is wrong, correct it briefly in the story file and continue. If
   the feature's **Premise** turns out to be false — the design rests on
   something the code does not support — stop: write what you found under
   **## Escalation** in the feature file, as **Writing an escalation** below
   describes, commit the backlog, and end the session. That is the right outcome.

7. Make **one** backlog commit for the story when you are done:

   ```
   bl sync --commit -m "chore: {{storyId}} implemented in {{featureId}}" --story {{storyId}} --path {{featureRelPath}}
   ```

   It takes the backlog lock and commits only the story's directory, the feature file and the
   index files the sync regenerates, never what another session has staged. Never run
   `git add` or `git commit` in the backlog repo.

8. Format the files you changed (see **Format and lint** below).

{{sessionStack}}

## Scratch files

Write diagnostics (probe scripts, redirected test output, scratch configs) under
`{{scratchDir}}`, never in the worktree. The test gate refuses a dirty worktree, and a
headless session cannot remove files.

{{blockedByBug}}

{{escalationGuide}}

{{sideChangeGuide}}

{{toolGuide}}

## IMPORTANT

- NEVER `git add` files that are in `.gitignore`.
- Do NOT run `bl merge`, open a PR, or run any `bl sync` other than the
  `bl sync --commit` lines above.
- Do NOT push. `bl run` pushes once, after every story is done.
- Never ask or tell the operator to merge a PR, and never merge one yourself.
- End your response with one line: `DONE {{storyId}}` when every criterion is
  checked, or `ESCALATED {{storyId}}` if you wrote an Escalation.
