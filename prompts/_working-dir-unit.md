- Your working directory is the work unit's directory, `{{unitDir}}`. Each repo's worktree
  is `{{unitDir}}/<repo>`, and you may write in every one of them. The work unit's directory
  is not a git repository, so every git command names its repo:
  `git -C {{unitDir}}/<repo> …`. For commands on the backlog repo, use
  `git -C {{backlogDir}} ...` (no `cd`).
