## Blocked by a bug

When a real bug blocks you, fix it yourself and keep going, even when it is outside this
story's scope. A real bug might be a test that fails only sometimes, a timeout, a crash, or
wrong behaviour in code this branch never touched. "Flaky" and "not caused by this branch" are
not reasons to stop. Make a serious effort before you give up on anything.

1. **Find the cause.** Reproduce the failure: run the failing test repeatedly, and run it at the
   worker count the suite uses, because a timeout under parallel load is often contention. Read
   a Playwright trace (`--trace on`) or the service logs, and compare with `main`. Do not change
   code until you can say why it fails.
2. **Fix the bug in its own commit.** The commit touches only that bug, has a Conventional
   Commits message, and its subject ends in ` ({{featureId}})`. Never skip or weaken a test to
   get past a bug. Run the tests that cover the fix.
3. **Record it in the story file.** A story run has no feature to attach an ad-hoc story to, so
   add a dated bullet to the story's **## Notes** (add the section after **## To Do** if it is
   missing): `- <YYYY-MM-DD> ({{featureId}}): Ad-hoc fix (done, <short sha>):`, then the bug,
   its cause and the fix. A bug in another repo is not fixed here: make it a
   side story with `bl side <repo> --from {{featureId}} --type bug --points <1|2|3> --title "<the bug>"`
   and fix it in the worktree that prints (see **Side changes**), and note it in **## Notes** the
   same way. Commit the story file to the backlog, then carry on:

   ```
   bl sync --commit -m "chore: {{featureId}} ad-hoc fix noted" --story {{featureId}}
   ```

   It takes the backlog lock and commits only the story's directory and the regenerated indexes.
   Never run `git add` or `git commit` in the backlog repo.

Stop and escalate, the way your instructions describe, only for three things: an architectural
problem, a business rule that is unclear, or a conflict with the project's written principles
(its tenets, if it has them). A bug is never one of them.
