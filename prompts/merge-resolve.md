`bl merge {{featureId}}` is bringing {{unitKind}} {{featureId}} — "{{title}}" up to date with main
before it lands, and the merge of main into `{{branchName}}` needs you. Finish that merge in
each repo below, keeping what both sides meant.

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

1. Work only in the worktrees named above, with paths and `git -C <worktree> …` for each:
   you start in the unit directory, which is not a git repository.
   Never touch a repo's main checkout, never switch branches,
   and never run `git merge --abort`, `git reset` or `git rebase`: bl checks the merge you
   leave, and rolls it back itself when it cannot land.
2. Read both sides before you edit a conflicted file. The commits listed for each file are
   the ones that touched it on each side since the merge base: `git show <sha> -- <file>`
   shows what each meant. Then read the {{unitKind}} file for the branch's intent.
3. Keep both sides' intent. A conflict is two changes that both have to survive: never take
   one side wholesale (`git checkout --ours/--theirs`) unless the other side's change is
   already in it or is truly superseded, and say which in the merge commit body. Leave no
   conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) in any file.
4. Do not edit a file listed as regenerated: bl took it from the branch side and rebuilt it
   with the repo's own tool, and it is already staged.
5. Commit each repo's merge with `git -C <worktree> commit --no-edit` once `git status`
   shows no unmerged path. A fix the merged tree needs after that (a call site main renamed,
   a test the two sides now break together) is an ordinary commit on top, with a
   Conventional Commits message ending in ` ({{featureId}})`.
6. When the test gate failed (the section above says so), the merge itself went through:
   find why the merged tree fails, and fix it in commits on top of the merge. Read the gate's
   full log before you rerun anything.
7. Run the tests that cover the files you resolved. bl runs the full test gate after you,
   and one review round over your resolution (`git show --remerge-diff` of each merge and
   every commit after it) before anything reaches main.
8. Write diagnostics (probe scripts, redirected test output) under `{{scratchDir}}`, never in
   a worktree. Leave every worktree clean: the gate refuses uncommitted files.
9. Do not push, do not run `bl merge`, and do not edit the change document: bl pushes the
   branch once the resolution is reviewed.
10. If you cannot resolve a conflict without a decision only the operator can make (the two
    sides want incompatible things, or the resolution needs work no story covers), leave
    that repo's merge as it is and write **## Escalation** in the {{unitKind}} file, as
    **Writing an escalation** below describes: the file, what each side wanted, and the
    choice. Run `bl validate` until it reports nothing on the {{unitKind}} file (surface, do
    not fix, findings on other files), then commit it with
    `bl sync --commit -m "chore: escalate {{featureId}} merge with main" --path {{featureRelPath}}`.
    bl adds the files and both sides' commits to it and rolls the merge back.

{{escalationGuide}}

{{toolGuide}}

## IMPORTANT

- NEVER `git add` files that are in `.gitignore`.
- Never run `git add` or `git commit` in the backlog repo ({{backlogDir}}), whose index other
  sessions share; the `bl sync --commit` line in rule 10 is the only backlog commit.
- End your response with one line: `RESOLVED` when every merge is committed and the tree is
  clean, or `ESCALATED` if you wrote an Escalation.
