You are resuming work on story {{storyId}} — "{{title}}" after a review.

Primary repo : {{primaryRepo}}
Unit dir : {{unitDir}} (your working directory)
Worktree : {{worktreePath}} ({{targetRepo}})
Branch : {{branchName}}
Story file (abs): {{storyAbsPath}}
Change doc (abs): {{changeAbsPath}}
Backlog repo : {{backlogDir}}

## Two-repo model

- The **story file** (`{{storyAbsPath}}`) and its **change document**
  (`{{changeAbsPath}}`) live in the backlog repo. The review feedback is
  in the `## Review Log` section of the change document, not in the
  worktree.
- **Code changes** go in this worktree and get committed to `{{branchName}}`.
- A story works in one repo, its component's (`{{targetRepo}}`); there is no
  secondary worktree. A fix a review item asks for in another repo is
  another story in a component of that repo (one story per repo): create it
  with `bl new <C-id> --depends-on {{storyId}}` (or have this story depend
  on it), and note the item as deferred to that story.

## Steps

1. {{readTool}} the story file at `{{storyAbsPath}}` for the full context,
   and the change document at `{{changeAbsPath}}`. The review feedback is
   the **latest** session — the first `### Session` block under
   `## Review Log` in the change document. Earlier sessions are prior
   cycles' history; do not re-address checked items there.

2. Address each unchecked item in the latest session by modifying the
   code in this worktree. Commit your changes using Conventional Commits
   messages — a valid type, the subject ending in ` ({{storyId}})`, body
   wrapped at 100 columns — one commit per logical fix, as usual.

3. As each item is resolved, edit the change document in the backlog repo:
   - Flip `- [ ]` to `- [x]` in place.
   - Append a short `→ <resolution>` note on the same item — typically
     the short commit SHA and a few words ("→ fixed in 3a1f9bc — now
     throws ConfigError"). For deferred items, note the deferral reason
     instead ("→ deferred to S-471 — out of scope").
   - Preserve the Must/Should/Nits grouping and the prior sessions
     untouched.

4. Make sure all tests pass and all files are formatted. Format the
   changed files using the formatter for their extension — see the
   **Format and lint** section below for the exact command.

5. When every item in the latest session is checked off, update the
   YAML frontmatter of the change document: set `review_status: fixed`.
   Do NOT set `review_status: addressed` — that is the reviewer's
   sign-off, written only by a `bl review` session after it verifies
   your fixes. `fixed` means "claimed resolved, awaiting re-review".

6. Commit the change-document edits **once** in the backlog repo, after
   the final item is checked off and `review_status: fixed` is set, by
   following **Backlog commits** below with `--story {{storyId}}` (it
   stages the story's directory, change document included) and the
   message:

   ```
   chore: address review feedback ({{storyId}}, session <YYYY-MM-DD>)
   ```

   where `<YYYY-MM-DD>` is the date of the session you just addressed.
   Code-side commits in this worktree remain one per fix as usual.

7. Push your code changes:

   ```
   git push origin {{branchName}}
   ```

8. If all acceptance criteria are now also met, mark them done in the
   story file. (Do not run `bl done` — the reviewer or cleanup agent
   handles that. `bl done` and `bl merge` refuse until a re-review
   sets `review_status: addressed`.)

{{validateBeforeSync}}

{{toolGuide}}

## IMPORTANT

- NEVER `git add` files that are in `.gitignore`.
- Never hand-edit backlog index files; `bl sync --commit` regenerates them.
- Do NOT delete `.pr-review.md` — that file is no longer produced. If you
  see one in the worktree it's pre-S-458 leftover; remove it by hand
  outside this session.
- Commit the story file with `bl sync --commit`, never `git` in the backlog
  repo; the backlog is a separate repo from this worktree.
- Avoid `$(...)` command substitution inside env-var assignments.
- At the very end, output the PR URL as the final line of your response.
