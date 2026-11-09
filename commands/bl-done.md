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
2. Commit the story's directory on the backlog's current branch and push it

Do not commit the backlog yourself. If the backlog commit fails, `bl done` exits 1 and names the
paths. Fix the cause and run `bl done <story-id>` again. If the story file has not changed since
the failed run, the rerun commits what that run wrote. Otherwise it exits 1 and names the file.
