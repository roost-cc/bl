# Merge (terminal command — not a slash skill)

Merge a reviewed story or feature: gates, merge into main, sync, push, and remove the
worktrees.

```bash
bl merge S-67
bl merge S-67 --keep         # keep the branch after merging
bl merge S-67 --switch-main  # switch a stale main checkout back to main first
bl merge F-3                 # a feature: every repo, every listed story
bl merge S-1 S-2             # several: in dependency order, stopping at the first failure
```

A story that belongs to a feature is refused: merge the feature.

## Gates

- Every target repo's main checkout must be on `main` (a stale one is switched back with
  `--switch-main`).
- `review_status` is not `pending`/`fixed`, and the latest review session has no unchecked
  Must/Should items (open nits do not block).
- `## Escalation` holds nothing but `None.` (stories and features alike).
- For a feature, every `backlog.json` `repos` entry sets `deployable` (true for the repos a
  release manifest records; there is no default).

There is no CI gate: no repo has hosted CI, and the test gate runs before review.

## What it does

A story has one repo, its component's; a worktree on its branch in another repo is refused,
naming the repo. A feature's repos are its stories' repos, merged in one order: `bl` first when a
story is in it, then every other repo by its first story in dependency order. A worktree on the
feature branch in a repo no story names is refused, naming the repo, before anything merges.
Per repo, in that order:

1. Merges the branch into main (`--no-ff`)
2. Pushes main to origin and closes the branch's open PR (forge ops `change.find` and
   `change.close`)
3. Removes the worktree directory and deletes the local branch (unless `--keep`)

`bl` goes first because a later repo's pre-push gate may read backlog output the new `bl`
generates (a link check over the component indexes, say). Right after `bl` merges, `bl merge`
runs `bl sync --commit` with the merged code, and only then merges the other repos. When the repo
is `bl` itself, that sync runs as a child process from the merged `bl` checkout, since the running
`bl` still has the old code loaded. A failure in that sync, or in a later repo, stops before
anything is marked done; resume with `bl merge <id>`. Each repo's merge SHA is written to the story's
`commit:` map as the repo lands (under the backlog lock, re-reading the map on disk and replacing
the file atomically, so two merges running at once keep each other's SHAs), so a resume marks the
story done with every repo's SHA. A repo whose branch is already gone locally (merged on the forge,
or landed by an earlier run) records the tip of its `main` after the push, which is its
`origin/main`; a merge SHA an earlier run already recorded for that repo is kept.

A feature worktree other than the first repo's with uncommitted changes (tracked or untracked)
is refused before anything in that repo is touched. Such a branch with no commits ahead of
`origin/main` (local `main` without an origin), one `bl run` prepared that no story changed, is not merged,
pushed or recorded in `commit:`: `bl merge` reports "no changes in <repo>" and removes its
worktree and branch.

Then it marks the story done (for a feature: every listed story and the feature), runs the
authoritative `bl sync` on the backlog (under the backlog lock), commits only the backlog paths
it changed. A story's open `## To Do` goes to a triage session; a feature's `## Deferred` list
is printed for you to decide on once.

The unit's change document (`change.md` beside its `index.md`) records each repo's merge commit
in its `repos:` entry's `merged:` and in `## Merge`, and its `status` becomes `merged`. Once every
repo of a **feature** is pushed, `bl merge` also tags each touched repo's merge commit with the
feature id (`F-3`, or `F-3.2` for its second change; annotated with the title and the change
document's path), pushes the tags last, and writes `releases/F-3.json` in the backlog with the
`main` commit of every repo whose `repos` entry sets `deployable: true`, read from its `origin` (never the local
checkout); `## Merge` links it. A repo whose `origin` main cannot be read stops the command
before anything is tagged, and a failed tag takes back the tags that run made, local and remote;
either way the command exits 1 before it writes the manifest or marks anything done, and
`bl merge F-3` again resumes once the cause is fixed. A failed backlog commit also exits 1. A
story merged alone gets no tag and no manifest. When anything waits on you, the last line
is `inbox: <n> item(s) need you (bl inbox)`.

If the merge has conflicts, it stops and asks you to resolve manually.
