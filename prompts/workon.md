You are working on backlog story {{storyId}} — "{{title}}".

Primary repo : {{primaryRepo}}
Unit dir : {{unitDir}} (your working directory)
Worktree : {{worktreePath}} ({{targetRepo}})
Branch : {{branchName}}
Story file (abs): {{storyAbsPath}}
Backlog repo : {{backlogDir}}

## Two-repo model (read this first)

The backlog is a **separate git repo** from the code. That means:

- The **story file** (`{{storyAbsPath}}`) lives in the backlog repo. Update it directly on the
  backlog's main branch. Status updates, acceptance-criteria checkoffs and **## Deferred**
  additions go there, not in the code worktree. These edits do NOT belong on your code branch.
- **Code changes** go in this worktree (`{{worktreePath}}`). Commit them to branch
  `{{branchName}}`. That branch is what your PR will contain.
- Never `git add` the story file from the code worktree: it is not in this repo.

## Steps

1. {{readTool}} the story file directly at `{{storyAbsPath}}`. Do not search for it.

2. If the story is not yet `status: in_progress`, update the frontmatter in the story file, on
   the backlog repo's main branch. Commit it as **Backlog commits** below says, with the message
   `chore: mark {{storyId}} in_progress` and `--story {{storyId}}`.

3. Implement the story in this worktree by its execution plan.
   When the story fixes a bug, first write a test that fails because of the bug, then make it
   pass. Commit your code changes as you go with Conventional Commits messages:
   - a valid type (`feat`, `fix`, `chore`, …);
   - the subject ending in ` ({{storyId}})`;
   - body lines wrapped at 100 columns.

   A plan that restates a source of truth is corrected, not followed: fix it in the story file,
   with the reason, and build the corrected plan (see **Self-consistent designs** below). An
   entry added to a guard's allowlist needs the same stated reason.

   Each time you satisfy an acceptance criterion, check it off in the story file
   (`- [ ]` → `- [x]`) in the backlog repo. Commit each batch of checkoffs separately through
   **Backlog commits** below, with the same `type: subject ({{storyId}})` shape.

4. When you are done, all tests must pass and all files must be formatted. Format the changed
   files with the formatter for their extension. The **Format and lint** section below gives the
   exact command. Always use **relative paths** from the worktree root, not absolute paths.

5. Push your code branch. Do not open the pull request: `bl review` opens it from the change
   document (see **Pull requests** below).

6. This story works in one repo, `{{targetRepo}}`: its component's. There is no secondary
   worktree. If the story needs a change in another repo, that
   change is another story in a component of that repo (one story per repo). Make it with
   `bl side`, as **Side changes** below says. Do not edit that repo here or in its main checkout.
   If this story cannot merge before that change does, escalate instead.

7. **Do the work yourself by default.** While you implement, you may uncover more work: a related
   fix, a missing edge case, cleanup, follow-on work, or work in another repo. Do it as part of this story by
   default. Do not define "my job" narrowly and push the rest into new stories.

   Size is the **only** reason to make the work a separate story. Estimate the uncovered work
   loosely. If it is **8 points or more** (Fibonacci 8/13: a large chunk that takes several
   sessions), it is too big to do here. Add it to a **## Deferred** section of the story file,
   in the backlog repo. After merge, the cleanup agent can make it a story of its own. Do now
   anything you estimate under 8 points.
   - The one exception is the repo. Work in another repo is always another story in that repo's
     component (step 6), whatever its size. Within this story's repo, only the 8-point size test
     decides what becomes a separate story.

   A finding of about one point in code this branch already touches is fixed now too, not
   deferred; a nit is fixed or dropped, never deferred.

   **## Deferred** holds code work only: `bl validate` refuses an unsized bullet there while the
   story is open. Give each bullet enough context for someone who has not seen your session to
   understand the problem and create a story from it. Include the file paths, test names or error
   messages that apply. **Start each bullet with a point estimate** in the form `[points: N]`
   (Fibonacci 1/2/3/5/8/13). You found the work, so you can estimate it best.
   Do not leave the estimate for the cleanup agent to guess.

   Notes and blockers are not Deferred bullets:
   - A record of what you did or found goes in a dated bullet under the story's **## Notes**:
     `- <YYYY-MM-DD> ({{storyId}}): …`, with no marker. Examples are an acceptance criterion you
     could not fully satisfy and why, or a problem from before your change that you looked into. If the section is
     missing, add it after **## Deferred**.
   - Anything the operator must do, with a moment to do it, is a task. Write its body to a file
     under `{{backlogDir}}/.bl/run/`: what to do, the exact commands as pasteable blocks with
     their expected output, and why it is not code. Then run
     `bl task {{storyId}} --title "<what to do>" --gate <merge|next|none> --body-file <file>`.
     - `--gate merge` holds `bl merge {{storyId}}` until the task is done. Use it for a step
       between the review and the merge, such as a migration.
     - `--gate next` holds every `bl run` and `bl implement` once {{storyId}} is done. Use it
       for a step right after the merge, such as a shared-service restart.
     - `--gate none` holds nothing. Use it for a fact or warning the operator must see.

     `bl task` commits the backlog itself; only the operator runs `bl task done`.

   Phrase a bullet or task that depends on a merge as
   "after review and merge, …", never "after <repo>#<pr> merges". Every PR goes through
   `bl review` first, and you do not know when it will merge.

{{sessionStack}}

{{selfConsistencyGuide}}

{{simplicityGuide}}

{{validateBeforeSync}}

{{sideChangeGuide}}

{{writingGuide}}

{{toolGuide}}

## IMPORTANT

- NEVER `git add` files that are in `.gitignore` (e.g. `.env`, credentials, secrets). If the
  story needs a gitignored file, create it in the worktree but do NOT commit it. Instead, file a
  task for the operator (see above), with gate `merge`:
  `bl task {{storyId}} --title "Copy worktree file <path-in-worktree> to main repo at <destination-path>" --gate merge`
- Only edit your own story file. Never add a table that `bl` renders when a page is read (a
  feature's or component's `## Stories`, a `## Tasks`); `bl validate` reports one as
  `generated-section`. `bl sync --commit` (see **Backlog commits**) commits the paths it names and
  pushes.
- Do not put `$(...)` command substitution inside an env-var assignment on a command line
  (e.g. `FOO="$(cat key.pem)" npx ...`). The permission analyzer fails on it with
  "Unhandled node type: string" and prompts again. Instead, run `export FOO=$(cat key.pem)` once,
  then run the command without the inline assignment.
- Never ask or tell the operator to merge a PR, and never merge one yourself.
  Review is a required gate: `bl review` reviews the open PR, and merging first skips it.
  A side change is a `bl side` story (see **Side changes**), which `bl inbox` lists until it
  merges; it needs no task.
- At the very end, print `next: bl review {{storyId}}` as the second-to-last
  line of your response and the PR URL as the final line. If you cannot produce a PR URL, the
  story is not done.
