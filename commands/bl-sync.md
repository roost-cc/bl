# Sync Backlog

Regenerate all backlog index files from story frontmatter, and optionally commit.

**Usage:** `/bl-sync`

```
bl sync
bl sync --commit -m "<type>: <subject> (S-XXX)" --story S-XXX [--story S-YYY …]
```

| Flag            | Description                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--commit`      | After regenerating, commit to the backlog repo inside the same lock hold                                                                                                  |
| `-m, --message` | Commit message (required with `--commit`). Repeatable as with `git commit`: the first is the subject, each later one a body paragraph. Put the why/how of the change here |
| `--story <id>`  | A story you created or edited; its whole directory is staged. Repeatable, required with `--commit`                                                                        |

## The lock

`bl sync` holds the backlog lockfile (`<backlog>/.bl-new.lock`, shared with `bl new` and
`bl new --feature`) while it regenerates, so concurrent syncs — parallel batch sub-agents
share one backlog working tree — take turns instead of tearing index writes or racing on
`.git/index.lock`. The lock is re-entrant within a process, so `bl new` (which already
holds it) can sync without deadlocking. A stale lock from a dead process is reclaimed; a
live one times out after 30s with an `rm <lockfile>` hint.

## `--commit`

Inside one lock hold: regenerate, then stage exactly the paths the sync wrote plus each
`--story` directory, and
commit them with `git commit --only`. It never stages the whole backlog, so another
person's uncommitted story edit — even one made while the lock is held — stays out of the
commit. If nothing changed, it exits 0 without committing. `--commit` without `-m` or
without at least one `--story` is a usage error (exit 2). So is a value-taking flag followed
by another option (`-m --story S-XXX`, `--story --commit`): the value was dropped, and the
command fails with `<flag> needs a value` rather than taking the option as the value. A
value that begins with `-` (other than a lone `-`) must go inline as `--message=<v>`
(likewise `--story=<v>` and `--path=<v>`).

The backlog repo is shared and uses an unstable `main` — the commit lands on `main`
directly; do NOT create branches or worktrees in it. Push afterwards if you need to:
`git -C <backlogPath> push`.

## Agents

Agents that edit stories run `bl validate` until it is clean on the stories they touched,
then `bl sync --commit` (see `prompts/_validate-before-sync.md`). They never commit in the
backlog repo with raw `git add` / `git commit`. `bl merge` still runs the authoritative
sync after a merge.
