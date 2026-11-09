`bl merge {{featureId}}` is bringing {{unitKind}} {{featureId}} — "{{title}}" up to date with main
before it lands. The merge of main into `{{branchName}}` needs you. Finish that merge in each repo
below, and keep what both sides meant.

Repos        : {{storyRepos}}
Unit dir     : {{unitDir}} (your working directory)
Lead worktree: {{worktreePath}} ({{targetRepo}})
Branch       : {{branchName}}
Unit file    : {{featureAbsPath}} ({{unitKind}})
Change doc   : {{changeAbsPath}}
Backlog repo : {{backlogDir}}

## What needs you

{{mergeRepos}}

{{gateFailure}}

## Rules

1. Work only in the worktrees named above, with paths and `git -C <worktree> …` for each. You
   start in the work unit's directory, which is not a git repository.
   Never touch a repo's main checkout, and never switch branches. Also
   never run `git merge --abort`, `git reset` or `git rebase`. bl checks the merge you leave, and
   rolls it back itself when it cannot land.
2. Read both sides before you edit a conflicted file. The commits listed for each file are the
   ones that touched it on each side since the merge base. `git show <sha> -- <file>` shows what
   each one meant. Then read the {{unitKind}} file for the branch's intent.
3. Keep both sides' intent. A conflict is two changes that both have to survive. Never take one
   side whole (`git checkout --ours/--theirs`), unless the other side's change is already in it
   or is truly superseded. If you do, say which in the merge commit body. Leave no conflict
   marker (`<<<<<<<`, `=======`, `>>>>>>>`) in any file.
4. Do not edit a file listed as regenerated. bl took it from the branch side and rebuilt it with
   the repo's own tool, and it is already staged.
5. When `git status` shows no unmerged path, commit each repo's merge with
   `git -C <worktree> commit --no-edit`. After that, a fix the merged tree needs is an ordinary
   commit on top, with a Conventional Commits message ending in ` ({{featureId}})`. Examples are
   a call site that main renamed, or a test that the two sides now break together.
6. If the test gate failed (the section above says so), the merge itself went through. Find why
   the merged tree fails, and fix it in commits on top of the merge. Read the gate's full log
   before you rerun anything.
7. Run the tests that cover the files you resolved. After you, bl runs the full test gate and one
   review round over your resolution, before anything reaches main. The round reads
   `git show --remerge-diff` of each merge and every commit after it.
8. Write diagnostics (probe scripts, redirected test output) under `{{scratchDir}}`, never in a
   worktree. Leave every worktree clean: the gate refuses uncommitted files.
9. Do not push, do not run `bl merge`, and do not edit the change document. bl pushes the branch
   once the resolution is reviewed.
10. Some conflicts need a decision that only the operator can make. Either the two sides want
    things that cannot both be true, or the resolution needs work that no story covers. If you cannot
    resolve a conflict without such a decision, do these steps:
    1. Leave that repo's merge as it is.
    2. Write **## Escalation** in the {{unitKind}} file, as **Writing an escalation** below
       describes: the file, what each side wanted, and the choice.
    3. Run `bl validate` until it reports nothing on the {{unitKind}} file. Report findings on
       other files, but do not fix them.
    4. Commit the {{unitKind}} file with
       `bl sync --commit -m "chore: escalate {{featureId}} merge with main" --path {{featureRelPath}}`.

    bl adds the files and both sides' commits to the escalation and rolls the merge back.

{{escalationGuide}}

{{writingGuide}}

{{toolGuide}}

## Outcome

{{outcomeDelivery}}

```json
{ "summary": "<one line: what you resolved>", "resolved": true, "reason": null }
```

- Set `resolved` to `true` when every merge is committed and every worktree is clean.
- Set it to `false` when a merge is not resolved, and give the reason in one line in `reason`.
  Otherwise `reason` is `null`. bl rolls the merge back and stops for the operator. If you wrote
  **## Escalation** (rule 10), bl stops whatever `resolved` says.

## IMPORTANT

- NEVER `git add` files that are in `.gitignore`.
- Never run `git add` or `git commit` in the backlog repo ({{backlogDir}}), because other sessions
  share its index. The `bl sync --commit` line in rule 10 is the only backlog commit.
- End with the outcome object that **Outcome** above describes.
