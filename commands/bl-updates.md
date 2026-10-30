# Updates: Renovate's dependency updates as backlog stories (terminal commands)

Renovate opens the branch and the PR and, at the end of each cycle, writes a report listing
every branch it manages. `bl updates` turns that report into stories, tests and merges them, and
gives the operator two verbs to answer with. One report per run, one or two commands back; no
dashboard issue, no checkboxes, no PR-by-PR review (F-32).

```bash
bl updates sync                         # one story per open Renovate branch, from the report
bl updates run                          # rebase, gate, merge green branches (majors too)
bl updates status                       # where every open update story stands
bl updates approve S-840                # request: the runner regates and merges it on green
bl updates drop S-841 --reason "..."    # request: the runner closes the PR, supersedes the story
```

## The loop

1. **Renovate** runs on a schedule of your choosing and rewrites the report `backlog.json`
   `updates.report` names, relative to the backlog's parent directory (for example
   `renovate/reports/renovate-report.json`, F-50 D3).
2. **`bl updates sync`** reads the report. A branch with a PR number and no story gets one in
   the repo's home component (the one with `home: true`), `type: chore`, `status: refined`, with the
   PR title, an upgrades table and the `update_*` keys. A story whose branch or PR left the
   report is `superseded` ("merged or closed on the forge"). A missing report means a run is in
   progress or failed: sync says so and exits 0. With `updates.report` unset sync refuses,
   naming the key; `--report <path>` reads another file, `--dry-run` writes nothing.
3. **`bl updates run`** takes the operator's requests first (approve and drop, below), then
   security updates, then repo by repo, oldest first, one
   branch at a time: fetch, rebase onto `main`, gate (frozen install, `ci gate`, the story's
   test plugins). No LLM: a green update, majors included, is merged `--no-ff` into `main`,
   pushed, its remote branch deleted, the story `done` (F-50 D5). Everything else stays
   `in_progress` with the gate tail under `## Gate result`; a red major also gets Renovate's
   release notes (`update.notes`) under `## Release notes`, the start of its migration story,
   and a held security update gets `## Decision needed`. A red story is skipped while its
   Renovate head and `origin/main` are the ones its last gate saw, and gated again when either
   moves. `[S-id...]` runs only those stories; `--dry-run` prints the order;
   `--max-merges <n>` caps merges per repo (default 10).
4. **The report**: one file per day, `backlog/updates/<YYYY-MM-DD>.md`, with a section per run
   (merged, held, decisions needed, skipped) and one per request it executed. A run with
   nothing open still writes its `## Run <time>` heading: `bl inbox` prints one `runner:` line
   when the newest one is more than 8 h old, so a runner gone quiet is visible (F-50 D7). The
   tmux bell rings after a run.
5. **The operator** reads the report and `bl inbox`, and answers with `approve` and `drop`
   requests (F-50 D8). The operator's workstation runs no gate, merge or close for updates.

Schedule steps 2 and 3 on the runner at the Renovate cadence (for example a systemd user timer
running `bl updates sync` then `bl updates run` every 4 hours). Run them by hand any time: sync, run,
approve and drop share one lock, taken before any story is read, and a command that meets
another is refused. Only the installed checkout's `bl` may do so: a `bl` running from a feature
worktree refuses the four mutating verbs against the real backlog (a dry run is fine), and a
branch is tried against a temporary backlog (`BL_BACKLOG_DIR=<tmp>`) with the forge and git
stubbed, as its tests do.

## The operator's verbs

```bash
bl updates status          # open update stories by repo: id, state, type, PR, title, detail
bl updates status --json   # { stories: [...], last_report: { date, path, entry } | null }
```

States, read from the story file alone:

| State             | Meaning                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `new`             | No run has gated it yet.                                                                                                                                                                                                             |
| `green`           | The last gate was green but it is still open: a merge that failed (the report says why), or a merge whose remote branch is still to delete (the detail names the commit; the next run deletes it, nothing is gated or merged again). |
| `held`            | The last gate was red, or the rebase conflicted. The detail says whether the branch has moved since (then the next run gates it again; so it does when `main` moved).                                                                |
| `decision needed` | `## Decision needed` has content; the detail is its question.                                                                                                                                                                        |
| `skipped`         | Its repo is not in `backlog.json`; the run cannot take it.                                                                                                                                                                           |
| `approve pending` | The operator's approve waits on the runner's next run.                                                                                                                                                                               |
| `drop pending`    | The operator's drop waits on the runner's next run; the detail is the reason.                                                                                                                                                        |

The last line names the newest report and its last entry.

```bash
bl updates approve S-840
```

Both verbs are requests: each writes `update_request` on the story (`approve`, or `drop` with
`update_request_reason`), commits and pushes, and runs no gate, fetch, merge or close. A second
request replaces the first. Refused when the story is closed, not an update story, or of a repo
not in `backlog.json`. Until the runner acts, `bl updates status` shows `approve pending` or
`drop pending` and `bl inbox` lists the story under `pending`, waiting on the runner rather
than on the operator.

The runner's next `bl updates run` executes requested stories first, clears the request and
appends the outcome to the day's report.

An approve is the run for that story with the operator's say: a known-red head is gated again
instead of skipped, and a green gate merges whatever `## Decision needed` says. A red gate still
holds the story, with the evidence. The report gets `## Approve S-840 · <time>` with one line;
an asked decision gets a dated "approved by the operator" line. An approve that never reached
the gate (a failed fetch, a dirty main checkout) keeps its request for the next run.

```bash
bl updates drop S-841 --reason "koa 3 is not worth the migration this quarter"
```

A drop marks the story `superseded` with the reason under its Summary (and under
`## Decision needed` when one was asked), then closes the PR through the forge op
`change.close` with the reason as the comment, and appends `## Drop S-841 · <time>` to the
report. The story goes first, so a failure after the close never leaves an open story for a
closed PR. Renovate does not reopen a PR a user closed, and the sync keeps the superseded story
for that PR number, so nothing recreates it. A forge that is not configured, or a close that
fails, puts the story back, request and all, and the next run tries again. Both verbs take the
lock the sync and the run hold, before reading the story, so a local sync is never raced.

## Where things live

```
backlog/
  stories/S<n>-…/index.md                # one story per Renovate branch, in its repo's home component (update_repo, update_branch, update_pr, update_head)
  updates/<YYYY-MM-DD>.md                # the day's report: runs, approves, drops
  .bl/run/updates.lock                   # the run lock
  .bl/run/updates.<S-id>.gate-<n>.log    # a gate's whole output
bl/
  src/updates.js                         # sync and the CLI
  src/updates-run.js                     # the run machine
  src/updates-answer.js                  # status, approve, drop

  templates/story-update.md              # the update story
```

Configure once in `backlog.json`: `"updates": { "namespace": "acme",
"report": "renovate/reports/renovate-report.json" }` (the namespace is the owner
every report slug must carry; a slug under another owner is skipped; the report path is
relative to the backlog's parent directory, with no default), each repo's test plugins in its `repos` entry's
`"update_tests": ["<plugin>"]` (`[]` for none), and
the forge ops `change.find`,
`update.notes` (the one op allowed to read a PR body: Renovate's release notes for a red
major) and
`change.close` in the forge plugin block (`bl/templates/forge-github.json`).
