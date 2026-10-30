- Your working directory is the unit directory, `{{unitDir}}`. Each repo's worktree
  is `{{unitDir}}/<repo>`, and you may write in every one of them. The unit directory
  is not a git repository, so every git command names its repo:
  `git -C {{unitDir}}/<repo> …`. For commands targeting the backlog repo, use
  `git -C {{backlogDir}} ...` (no `cd`).
