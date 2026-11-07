# Sync Backlog

Bring the backlog up to date with origin and push it, and optionally commit named paths first.
`bl sync` writes no index or table: bl renders those when they are read (F-79).

**Usage:** `/bl-sync`

```
bl sync
bl sync --commit -m "<type>: <subject> (S-XXX)" --story S-XXX [--story S-YYY …] [--path <backlog-relative>]
```

| Flag            | Description                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--commit`      | After the pull, commit the named paths to the backlog repo under the backlog lock, and push                                                                               |
| `-m, --message` | Commit message (required with `--commit`). Repeatable as with `git commit`: the first is the subject, each later one a body paragraph. Put the why/how of the change here |
| `--story <id>`  | A story you created or edited; its whole directory is staged. Repeatable                                                                                                  |
| `--path <path>` | A backlog-relative file or directory you wrote or moved yourself. Repeatable. `--commit` needs at least one `--story` or `--path`                                         |

## Without `--commit`

`bl sync` rebases `main` onto `origin/main` (with `--autostash`) and then pushes a `main` that
is still ahead. After a pull it regenerates `allowed-tools.json` when its inputs changed, and
commits that. With no `origin` remote it does nothing.

## `--commit`

After the pull, under the backlog lockfile (`<backlog>/.bl-new.lock`, shared with `bl new`),
`bl sync --commit` formats the changed Markdown files among the named paths with the backlog's
`.md` format plugin. It then stages exactly each `--story` directory and each `--path`, commits
them with `git commit --only`, and pushes. It never stages the whole backlog, so another
person's uncommitted story edit, even one made while the lock is held, stays out of the commit.
If nothing changed, it exits 0 without committing. `--commit` without `-m`, or without at least
one `--story` or `--path`, is a usage error (exit 2). So is a value-taking flag followed by
another option (`-m --story S-XXX`, `--story --commit`): the value was dropped, and the command
fails with `<flag> needs a value` rather than taking the option as the value. A value that
begins with `-` (other than a lone `-`) must go inline as `--message=<v>` (likewise
`--story=<v>` and `--path=<v>`).

The backlog repo is shared and uses an unstable `main`: the commit lands on `main` directly. Do
NOT create branches or worktrees in it.

## Agents

Agents that edit stories run `bl validate` until it is clean on the stories they touched, then
`bl sync --commit` (see `prompts/_validate-before-sync.md`). They never commit in the backlog
repo with raw `git add` / `git commit`.
