You are resuming work on story {{storyId}} — "{{title}}" after a review.

Primary repo : {{primaryRepo}}
Unit dir : {{unitDir}} (your working directory)
Worktree : {{worktreePath}} ({{targetRepo}})
Branch : {{branchName}}
Story file (abs): {{storyAbsPath}}
Change doc (abs): {{changeAbsPath}}
Backlog repo : {{backlogDir}}

## Two-repo model

- The **story file** (`{{storyAbsPath}}`) and its **change document** (`{{changeAbsPath}}`) live
  in the backlog repo. The review feedback is in the `## Review Log` section of the change
  document, not in the worktree.
- **Code changes** go in this worktree. Commit them to `{{branchName}}`.
- A story works in one repo, its component's (`{{targetRepo}}`); there is no secondary worktree.
  A review item may ask for a fix in another repo.
  That fix is another story in a component of that repo (one story per repo). Create it with
  `bl new <C-id> --depends-on {{storyId}}`, or make this story depend on it. Then note in the item that the new story does the fix.

## Steps

1. {{readTool}} the story file at `{{storyAbsPath}}` for the full context, and the change
   document at `{{changeAbsPath}}`. The review feedback is the **latest** session: the first
   `### Session` block under `## Review Log` in the change document. Earlier sessions are the
   history of earlier rounds; do not re-address checked items there.

2. Address each unchecked item in the latest session: change the code in this worktree. Commit
   your changes with Conventional Commits messages: a valid type, the subject ending in
   ` ({{storyId}})`, and the body wrapped at 100 columns. Make one commit per logical fix, as
   usual.

3. As you resolve each item, edit the change document in the backlog repo:
   1. Flip `- [ ]` to `- [x]` in place.
   2. Append a short `→ <resolution>` note on the same item. It is usually the short commit SHA
      and a few words ("→ fixed in 3a1f9bc — now throws ConfigError"). For an item that another
      story will do, write that story and the reason instead ("→ deferred to S-471 — out of
      scope").
   3. Keep the Must/Should/Nits grouping and the earlier sessions as they are.

4. Check that all tests pass and that all files are formatted. Format the changed files with the
   formatter for their extension. The **Format and lint** section below gives the exact command.

5. Commit the change-document edits **once** in the backlog repo. Do it after you check off the
   final item. Follow **Backlog commits** below with
   `--story {{storyId}}` (it stages the story's directory, change document included) and this
   message:

   ```
   chore: address review feedback ({{storyId}}, session <YYYY-MM-DD>)
   ```

   `<YYYY-MM-DD>` is the date of the session you just addressed. In this worktree, code commits
   stay one per fix, as usual.

6. Push your code changes:

   ```
   git push origin {{branchName}}
   ```

7. If all acceptance criteria are now met too, mark them done in the story file. Do not run
   `bl done`: the reviewer or the cleanup agent does that. `bl done` and `bl merge` refuse until a
   re-review signs the change off.

## Outcome

{{outcomeDelivery}}

{{fixOutcome}}

{{validateBeforeSync}}

{{writingGuide}}

{{toolGuide}}

## IMPORTANT

- NEVER `git add` files that are in `.gitignore`.
- Never add a table that `bl` renders when a page is read (a `## Stories` or `## Tasks` table);
  `bl validate` reports one as `generated-section`.
- Do NOT delete `.pr-review.md`. bl no longer writes that file. If you see one in the worktree,
  it is a leftover from before S-458; remove it by hand outside this session.
- Commit the story file with `bl sync --commit`, never with `git` in the backlog repo. The
  backlog is a separate repo from this worktree.
- Avoid `$(...)` command substitution inside env-var assignments.
- End with the outcome object that **Outcome** above describes.
