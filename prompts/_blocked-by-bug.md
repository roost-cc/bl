## Blocked by a bug

When a real bug blocks you, fix it yourself and keep going, even when it is outside this
feature's scope. A real bug might be a test that fails only sometimes, a timeout, a crash, or
wrong behaviour in code this branch never touched. "Flaky" and "not caused by this branch" are
not reasons to stop. Make a serious effort before you give up on anything.

1. **Find the cause.** Reproduce the failure: run the failing test repeatedly, and run it at the
   worker count the suite uses, because a timeout under parallel load is often contention. Read
   a Playwright trace (`--trace on`) or the service logs, and compare with `main`. Do not change
   code until you can say why it fails.
2. **Record it as an ad-hoc story attached to this feature.** Use the {{writeTool}} tool to write
   the body to `{{backlogDir}}/.bl/run/{{featureId}}.adhoc-<slug>.md`. It needs three sections:
   `## Summary` (the symptom, the cause and the fix), `## Acceptance Criteria` (with every
   criterion the fix meets checked `- [x]`), and `## Dependencies` (`None.`).

   First check whether the bug already has a backlog story: search for the symptom with
   `bl grep <words>` and `bl list -a`. If one exists, attach it instead of filing a new one:

   ```
   bl attach S-<id> {{featureId}} --no-sync
   ```

   Then check off in that story's file every criterion the fix meets, set `status: in_progress`
   in its frontmatter as for a new story, and go on from step 3 with its id. The story keeps its
   own sections; the body file is only needed if attach refuses.
   - If `bl attach` refuses because the story's repo is outside the feature, treat the bug as one
     in another repo: run `bl side` as below, and name the existing `S-<id>` in the side story's
     `## Summary`.
   - If `bl attach` refuses for any other reason (the story is `in_progress`, in another feature,
     or `done` or `superseded`), or exits 1 for any reason at all, still fix the bug in its own
     commit (step 3, the subject ending in ` ({{featureId}})`), but do not run `bl new` for it.
     Name the existing `S-<id>` in the body's `## Summary` and quote attach's refusal there, then
     file a task for the operator with that body file in place of step 4, and carry on with your
     task:
     `bl task {{featureId}} --title "Ad-hoc fix (done, <short sha>): <the bug>" --gate none --body-file {{backlogDir}}/.bl/run/{{featureId}}.adhoc-<slug>.md`.
     The operator decides at merge whether to move the story, file a new one, or supersede the
     old one.

   When no story exists, run:

   ```
   bl new {{featureId}} {{adhocComponent}} --type bug --points <1|2|3> --no-sync --title "<the bug, in a few words>" --body-file {{backlogDir}}/.bl/run/{{featureId}}.adhoc-<slug>.md
   ```

   `{{adhocComponent}}` is the component (the code boundary) of this feature's first story, and
   the story takes that component's repo. Use another component only if one clearly fits better.
   A bug in another repo is a side story instead, since it needs that repo's worktree: run
   `bl side <repo> --from {{featureId}} --type bug --points <1|2|3> --title "<the bug>" --body-file <the same file>`
   in place of `bl new`, fix it in the worktree it prints, and go on from step 3. `bl new` prints
   the new `S-<id>` and its file. Set `status: in_progress` in that file's frontmatter (`bl side`
   sets it for you). With every criterion checked, the loop treats the story as finished, and
   `bl merge` marks it done along with the feature.

3. **Fix the bug in its own commit.** The commit touches only that bug, has a Conventional
   Commits message, and its subject ends in ` ({{featureId}} S-<id>)`. Never skip or weaken
   a test to get past a bug. Run the tests that cover the fix.
4. **Commit the story to the backlog**, then carry on with your task:

   ```
   bl sync --commit -m "chore: S-<id> ad-hoc fix in {{featureId}}" --story S-<id> --path {{featureRelPath}}
   ```

   It takes the backlog lock and commits only those paths and the regenerated indexes. Never run
   `git add` or `git commit` in the backlog repo.

   If `bl new` or `bl attach` fails, file a task for the operator instead, with the same body
   file:
   `bl task {{featureId}} --title "Ad-hoc fix (done, <short sha>): <the bug>" --gate none --body-file {{backlogDir}}/.bl/run/{{featureId}}.adhoc-<slug>.md`.
   The operator makes it a story at merge.

Stop and escalate, the way your instructions describe, only for three things: an architectural
problem, a business rule that is unclear, or a conflict with the project's written principles
(its tenets, if it has them). A bug is never one of them.
