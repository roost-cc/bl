# Implement (terminal command — not a slash skill)

Start work on a backlog story or feature in an isolated git worktree with its own interactive
agent session: the manual single step. `bl run` takes the same target through the whole loop
unattended (see `bl-run.md`).

**This is run from the terminal, not from inside an agent session.**

```bash
bl implement <story-id>
bl list
bl merge <story-id>
```

```bash
bl implement F-3                    # a feature: one worktree/branch, stories in order
bl implement <id...>                # several targets: one tmux window each
```

## Arguments

| Arg       | Description                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id...>` | One or more story (S34, S-34, s34) or feature (F-3) IDs. A component is refused: make its stories a feature. A story that belongs to a feature is refused: use the feature. |

A story is started when its status is `refined` or `in_progress`. A feature needs `approved`,
`running`, or `escalated`, and refuses on open dependencies outside it.

## One or several

- **One target** — creates/resumes its worktree and launches one interactive
  agent session (the classic flow below).
- **Several targets** — the deferred ones are listed first, then each started
  target opens its own interactive session in a new tmux window. Outside tmux this
  exits with "several targets need tmux": start a tmux session and rerun, run
  them one at a time, or use `bl run`.

## Dependency gating

A story is only launched when every `depends_on` is already `done`/`superseded`
(i.e. **merged**). A dependency that is itself one of the targets counts as
unmet until its PR merges, so the dependent is **deferred** and reported, not
launched. So is a target whose files (its branch diff, else the backticked paths
in its Implementation Plan, outside `### Sources of truth`) overlap a
lower-numbered target's. After you review
and merge the launched PRs, re-run the same command and the newly-unblocked
targets start.

## What It Does

1. Guards against unpushed local commits on main (hard stop if ahead of origin)
2. Pulls latest `main` to ensure the worktree starts from the newest code
3. Creates a git worktree at `<root>/<branch>/<repo>` (the root is `backlog.json`
   `worktrees`, relative to the backlog) with a story branch
4. Installs dependencies (`pnpm install`) in the worktree if needed
5. Launches an agent session in the unit directory, `<root>/<branch>`, with full
   edit/commit/push permissions in every repo worktree under it
6. Writes a lock file in the unit directory while the session is running to prevent
   double-starts

When the target's `review_status` is `pending`, the session addresses the review instead
(the fix round).

## Resuming Interrupted Sessions

Re-running the same ID automatically resumes:

- If a worktree exists in the unit directory, it is reused (not recreated); a branch
  checked out anywhere else is refused, with the `git worktree move` that fixes it
- If an agent session exists for that unit directory, it is resumed
- No `--resume` flag needed — the script detects it automatically

## Guards

- **Done/superseded stories**: refuses to start work on completed stories
- **Unpushed main**: blocks if local main is ahead of origin (prevents orphaned branches)
- **Uncommitted changes**: warns if main has uncommitted changes
- **Concurrent sessions**: warns if a lock file exists in the unit directory

## Agent Permissions

Agents can freely:

- Edit and write any file in the worktree
- Run `pnpm install`, `pnpm test`, `ppp` (formatter)
- `git add`, `git commit`, `git push origin`, `git status`, `git diff`, `git log`
- Run `node` scripts

Agents must NOT:

- Hand-edit backlog index files (shared, auto-generated)
- Commit in the backlog repo with raw `git add` / `git commit`. Story-file edits are
  committed with `bl validate`, then `bl sync --commit -m … --story S-XXX`, which takes
  the backlog lock so parallel agents take turns
- Merge branches (you do this from the main repo)

## Multi-Agent Workflow

```
app.acme.com/                          <- main repo (stays on main)
worktrees/
  s67-spa-navigation/                  <- the unit directory of S-67
    app.acme.com/                      <- agent 1 working on S-67
  s66-residence-record/
    app.acme.com/                      <- agent 2 working on S-66
```

## After Work Is Complete

```bash
# List active worktrees
bl list

# Review the agent's work
cd ../worktrees/s67-spa-navigation/app.acme.com
git log --oneline main..HEAD

# Review the PR, then merge it: merge, sync, push, clean up
bl review S-67
bl merge S-67
```

See `bl-merge.md` for what the merge does.
