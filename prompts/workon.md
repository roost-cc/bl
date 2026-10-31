You are working on backlog story {{storyId}} — "{{title}}".

Primary repo : {{primaryRepo}}
Unit dir : {{unitDir}} (your working directory)
Worktree : {{worktreePath}} ({{targetRepo}})
Branch : {{branchName}}
Story file (abs): {{storyAbsPath}}
Backlog repo : {{backlogDir}}

## Two-repo model (read this first)

The backlog is a **separate git repo** from the code. That means:

- The **story file** (`{{storyAbsPath}}`) lives in the backlog repo. Update it
  directly on its main branch — status updates, acceptance criteria checkoffs,
  and **## To Do** additions are written there, not in the code worktree.
  These edits do NOT belong on your code branch.
- **Code changes** go in this worktree (`{{worktreePath}}`) and get committed
  to branch `{{branchName}}`. This is what your PR will contain.
- Never `git add` the story file from the code worktree — it isn't in this
  repo.

## Steps

1. {{readTool}} the story file directly at `{{storyAbsPath}}`. Do not search for it.

2. If the story is not yet `status: in_progress`, update the frontmatter in
   the story file (on the backlog repo's main branch). Commit it by following
   **Backlog commits** below, with the message
   `chore: mark {{storyId}} in_progress` and `--story {{storyId}}`.

3. Implement the story in this worktree according to the execution plan.
   Commit your code changes as you go using Conventional Commits messages: a
   valid type (`feat`, `fix`, `chore`, …), the subject ending in
   ` ({{storyId}})`, and body lines wrapped at 100 columns.

   A plan that restates a source of truth is corrected, not followed: fix it in
   the story file, with the reason, and build the corrected plan (see
   **Self-consistent designs** below). An entry added to a guard's allowlist
   needs the same stated reason.

   As you satisfy each acceptance criterion, mark it done in the story file
   (`- [ ]` → `- [x]`) in the backlog repo. Commit each batch of criterion
   updates separately through **Backlog commits** below, using the same
   `type: subject ({{storyId}})` shape.

4. When done, make sure all tests pass and all files are formatted.
   Format the changed files using the formatter for their extension — see
   the **Format and lint** section below for the exact command. Always use
   **relative paths** from the worktree root (not absolute paths).

5. Push your code branch. Do not open the pull request: `bl review` opens it
   from the change document (see **Pull requests** below).

6. This story works in one repo, `{{targetRepo}}`: its component's. There is
   no secondary worktree. If the story needs a change in another repo, that
   change is another story in a component of that repo (one story per repo):
   make it with `bl side`, as **Side changes** below says. Do not edit that
   repo here or in its main checkout. If this story cannot merge before that
   change does, escalate instead.

7. **Default to doing the work yourself.** When you uncover additional work
   while implementing — a related fix, a missing edge case, cleanup,
   follow-up, or work in another repo — the bias is to just do it as part of
   this story. Do not carve out a narrow definition of "my job" and punt the
   rest into follow-up stories.

   The **only** reason to spin off a separate story instead of doing the
   work is size: if the uncovered work is a loose estimate of **8 points or
   more** (Fibonacci 8/13 — a substantial, multi-session chunk), it is too
   big to absorb here. In that case add it to a **## To Do** section of the
   story file (in the backlog repo) so the cleanup agent can harvest it into
   its own story after merge. Anything you loosely estimate under 8 points,
   do now.
   - The one exception is the repo: work in another repo is always another
     story in that repo's component (step 6), whatever its size. Within this
     story's repo, only the 8-point size test decides what becomes a
     separate story.

   A finding of about one point in code this branch already touches is
   fixed now too, not deferred; a nit is fixed or dropped, never deferred.

   **## To Do** holds follow-up code work only: `bl validate` refuses an
   unsized bullet there while the story is open. Each bullet should carry
   enough context for someone unfamiliar with your session to understand the
   issue and create a new story from it — include relevant file paths, test
   names, or error messages. **Start each bullet with a point estimate** in
   the form `[points: N]` (Fibonacci 1/2/3/5/8/13). You just did the work
   that uncovered this item, so you are best placed to estimate it — do not
   leave it for the cleanup agent to guess.

   Notes and blockers are not To Do items:
   - A record of what you did or found (an acceptance criterion you could
     not fully satisfy and why, a pre-existing problem you looked into): a
     dated bullet under the story's **## Notes** (add the section after
     **## To Do** if it is missing), `- <YYYY-MM-DD> ({{storyId}}): …`, with
     no marker.
   - Anything the operator must do, with a moment to do it: a task. Write
     its body (what to do, the exact commands as pasteable blocks with their
     expected output, and why it is not code) to a file under
     `{{backlogDir}}/.bl/run/`, then run
     `bl task {{storyId}} --title "<what to do>" --gate <merge|next|none> --body-file <file>`.
     `--gate merge` holds `bl merge {{storyId}}` until the task is done (a
     step between the review and the merge, such as a migration);
     `--gate next` holds every `bl run` and `bl implement` once {{storyId}}
     is done (a step right after the merge, such as a shared-service
     restart); `--gate none` holds nothing (a fact or warning the operator
     must see). `bl task` commits the backlog itself; only the operator runs
     `bl task done`.

   Phrase an item or task that depends on a merge as
   "after review and merge, …", never "after <repo>#<pr> merges": every PR
   goes through `bl review` first, and you do not know when it will merge.

{{sessionStack}}

{{selfConsistencyGuide}}

{{validateBeforeSync}}

{{sideChangeGuide}}

{{toolGuide}}

## IMPORTANT

- NEVER `git add` files that are in `.gitignore` (e.g. `.env`, credentials,
  secrets). If the story requires a gitignored file, create it in the
  worktree but do NOT commit it. Instead, add a bullet to the **## To Do**
  section like:
  `Copy worktree file <path-in-worktree> to main repo at <destination-path>`
  The cleanup agent will handle copying it after merge.
- Only edit your own story file, and never hand-edit backlog index files.
  `bl sync --commit` (see **Backlog commits**) regenerates them;
  `bl merge` still runs the authoritative sync after merge.
- Avoid `$(...)` command substitution inside env-var assignments on a
  command line (e.g. `FOO="$(cat key.pem)" npx ...`). It trips the
  permission analyzer with "Unhandled node type: string" and forces a
  re-prompt. Instead, `export FOO=$(cat key.pem)` once, then run the
  command without the inline assignment.
- Never ask or tell the operator to merge a PR, and never merge one yourself.
  Review is a required gate: `bl review` reviews the open PR, and merging
  first skips it. A side change is a `bl side` story (see **Side changes**),
  which `bl inbox` lists until it merges; it needs no task.
- At the very end, print `next: bl review {{storyId}}` as the second-to-last
  line of your response and the PR URL as the final line. If you cannot
  produce a PR URL, the task is not done.
