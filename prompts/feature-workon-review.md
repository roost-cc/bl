You are resuming {{unitKind}} {{featureId}} — "{{title}}" after a review.

Repos        : {{storyRepos}}
Unit dir     : {{unitDir}} (your working directory)
Lead worktree: {{worktreePath}} ({{targetRepo}})
Branch       : {{branchName}}
Unit file    : {{featureAbsPath}} ({{unitKind}})
Change doc   : {{changeAbsPath}}
Backlog repo : {{backlogDir}}

## Two-repo model

- The **{{unitKind}} file** and its **change document** live in the backlog repo. The review
  feedback is in the change document's `## Review Log` section, not in the worktree.
- **Code changes** go in each repo's worktree, `{{unitDir}}/<repo>`. Commit them there to
  `{{branchName}}`.
- The repos above are the {{unitKind}}'s, in the order bl reviews and merges them. A review item
  can ask for a fix in a repo that no story names. That fix is a missing story, not a new
  worktree: write it under **## Escalation**, name the repo, and stop.

## Steps

1. {{readTool}} the {{unitKind}} file and the change document. The review feedback is the
   **latest** session: the first `### Session` block under `## Review Log` in the change
   document. Earlier sessions are history; do not re-address checked items there.

2. Address each unchecked **Must fix** and **Should fix** item with the **smallest change that
   satisfies it**. Make one commit per item, with Conventional Commits, the subject ending in
   ` ({{featureId}})`. Do no refactoring, renaming, reformatting or cleanup beyond what the item
   needs. Do not edit code that the item does not concern, unless the fix cannot work without the
   edit. The next review must read every line that a fix round adds. On F-2, fix rounds wrote
   more code than the feature itself and caused most of the later findings.
   An item may need a larger change, such as a new abstraction or a redesign of a contract. Then
   do not make the change. Write **## Escalation** in the {{unitKind}} file, as
   **Writing an escalation** below describes: which item, what it would need, and why a fix round
   cannot do it. Commit the backlog, and stop.

3. **Sweep the class, not just the instance.** Each item names a `Class:` and lists the instances
   that the reviewer found. That list is where you start, not where you stop. Before you fix,
   search the code this branch changed (`git diff main...HEAD`) for every instance of that class:
   - the function's other input classes;
   - the paired operation (before/after, read/write, create/rollback, acquire/release);
   - the other callers of the same helper.

   Fix them together, usually with one shared check or helper instead of several patches. Add a
   table-driven test over every instance and input class. An instance in code that the branch did
   not change goes to **## Deferred** as `[points: N] (pre-existing, same class as <item>) …`,
   not into this fix. The exception is an instance of about one point in code this branch already
   touches: fix it here, do not defer it.
   "Smallest change" means no unrelated edits. It never means that you leave a known instance of
   the same class behind. On F-3, fixing one instance per round cost three review rounds for one
   class.

4. Items are written as invariants, not instances. An item may state a property, such as "the
   read/write invariant holds for every field" or "no partial write can leave X inconsistent".
   Then add or extend a test that proves the invariant across the input classes that the reviewer
   listed, not only the example they quoted. The re-review runs that test, and it sends back a fix
   without one.

5. Do not touch **Nits** unless the item is tagged `[safe]`. Regressions come from fixing
   cosmetic items in the same round as Must-fix items. Leave an untagged nit unchecked with a
   `→ dropped (nit)` note: a nit is fixed or dropped, never deferred.

6. As you resolve each item, edit the change document: flip `- [ ]` to `- [x]` and append
   `→ <resolution>`. The resolution holds the short SHA, `class <name>: fixed <every instance>`,
   and the name of the test that proves it.
   Keep the Must/Should/Nits grouping and the earlier sessions as they are.

7. Run the full test suite for this repo and format the changed files (see **Tests** and
   **Format and lint** below).

8. Set `review_status: fixed` in the change document's frontmatter. Never write `addressed`:
   that is the reviewer's sign-off. Commit the backlog once:

   ```
   bl sync --commit -m "chore: address review feedback ({{featureId}}, session <YYYY-MM-DD>)" --path {{changeRelPath}} --path {{featureRelPath}}
   ```

9. Push: `git push origin {{branchName}}`.

{{sessionStack}}

## Scratch files

Write diagnostics (probe scripts, redirected test output, scratch configs) under
`{{scratchDir}}`, never in the worktree. The test gate refuses a dirty worktree, and a
headless session cannot remove files.

{{blockedByBug}}

{{escalationGuide}}

{{writingGuide}}

{{toolGuide}}

## IMPORTANT

- NEVER `git add` files that are in `.gitignore`.
- Do NOT edit backlog index files or run any `bl sync` other than the `bl sync --commit` line in
  step 8.
- Commit the change document and the {{unitKind}} file only with that `bl sync --commit` line. It
  takes the backlog lock and commits only those files and the regenerated indexes. Never run
  `git add` or `git commit` in the backlog repo ({{backlogDir}}), because other sessions share
  its index.
- Format the {{unitKind}} file and the change document with
  `bl format --no-story {{featureRelPath}} {{changeRelPath}}`.
- At the very end, output the PR URL as the final line of your response.
