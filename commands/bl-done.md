# Mark Story Done

Mark a backlog story as complete.

**Usage:** `/bl-done <story-id> [commit-hash]`

## Arguments

| Arg             | Required | Description                                    |
| --------------- | -------- | ---------------------------------------------- |
| `<story-id>`    | Yes      | Story ID: S34, S-34, or s34 (case-insensitive) |
| `[commit-hash]` | No       | Short git hash (defaults to HEAD)              |

## Steps

Run `bl done $ARGUMENTS` from the repo root.

The script will:

1. Update the story frontmatter (`status: done`, `commit`, `completed`); the story stays in
   `stories/`, since status is frontmatter, not location
2. Run sync automatically

After the script succeeds, commit and push the changed backlog files. Use `git -C <backlogPath>` form (no `cd`) — the backlog path comes from `backlog.json` (key: `backlog`), resolved from the repo root. The backlog repo is shared and uses an unstable `main` — direct commits to `main` are expected; do NOT create branches or worktrees in it.

```
git -C <backlogPath> add <changed-files>
git -C <backlogPath> commit -m "chore: <message> (<storyId>)"
git -C <backlogPath> push
```
