# Run: the loop for a story or feature (terminal commands — not slash skills)

One verb set serves stories and features; the id's prefix picks the kind. A feature is one
branch, one pull request, one review cycle, and one merge over an ordered set of stories that
may span components and repos. A refined story that belongs to no feature goes through the same
loop on its own branch. The operator touches a feature twice (`approve` and `merge`), a story
once (`merge`).

```bash
bl new --feature --title "Invite codes" --theme residence   # scaffold F-<n>
bl new --feature --title "Invite codes" --epic E52 S-1 S-2    # …or make stories a feature
bl refine F-3        # agent: premise, design, acceptance, story cut
bl approve F-3       # the human gate (features only; a refined story may run)
bl implement F-3     # one branch, a worktree per repo; implements stories in order (interactive)
bl review F-3        # correctness + failure-paths passes, then the verifier writes a session
bl implement F-3     # again when review_status is pending (fix round)
bl review F-3        # re-review: verifies the named tests
bl run F-3           # or: all of the above, headless, until clean or escalated
bl merge F-3         # gates, merges every repo, marks stories done
bl status F-3        # where things stand
bl list --features [-a]
```

The same verbs take a story (`bl run S-34`, `bl review S-34`, `bl status S-34`,
`bl merge S-34`) or several targets (`bl run S-1 S-2 F-3`). A component is refused by `run` and
`implement`: make the stories you want into a feature with `bl new --feature`. A story that
belongs to a feature is refused by `run`, `implement`, `review` and `merge`: use the feature.

## Where things live

```
backlog/
  features/F3-invite-codes/index.md          # premise, design, acceptance, review log, deferred, escalation;
                                             # merged features stay here with `status: done`
  stories/S<n>-…/index.md                    # stories name their component; `feature: F-3` links back
  components/C<n>-…/index.md                 # a code boundary in one repo: `repo:`, `home:`
```

## Gates

- `approve` needs `status: refined`, a non-empty `stories:` list whose stories
  all carry `feature: F-<n>`, and warns on open dependencies outside the
  feature (`implement` refuses on those).
- `implement` and `run` need a feature `approved`, `running`, or `escalated`; a story
  `refined` or `in_progress`.
- `merge` refuses while `review_status` is `pending`/`fixed`, while the latest
  review session has unchecked Must/Should items (open nits do not block), or
  while `## Escalation` holds anything but `None.`. See `bl-merge.md`.

## The loop

`bl run F-3` replaces the manual implement/review cycle with one
unattended run: implement each story in dependency order, run the `test`
stage plugin, self-review, push and open one PR, then review → fix → re-review
until the verifier writes `review_status: addressed` or the round cap
(`review_rounds_max`) is hit, which escalates with the open items in
`## Escalation`. Agents can escalate too (a false premise, unmet criteria).

`bl run S-34` does the same for one story: its branch is the story's own, its PR is titled
`S-34: <title>`, and the story file takes the feature file's place (its Summary and Acceptance
Criteria for the Premise, `## To Do` for `## Deferred`). The first run adds `branch`, `pr`,
`review_round` and `review_rounds_max` to the story's frontmatter.

A story has one repo, its component's. A feature names no repo: its repos are its stories'
repos, in one order that every step uses: `bl` first when a story is in it, then every other repo
by its first story in dependency order. Before any agent starts, `bl run F-3` and
`bl implement F-3` make a worktree on the branch in every one of them, in that order (same guards,
bootstrap and `workon` plugins), start the session in the first (the lead repo, whose config the
review uses), and the prompt lists each one. A story added after approval gets its worktree on the
next run or `--resume`. A repo it cannot prepare (an unknown repo, a dirty main checkout, a failed
bootstrap or plugin) stops the run, naming the repo (and the story that puts it in the feature). A
feature with no stories is refused until they are cut. Neither verb takes `--repo`. The agent
works only in the listed worktrees and escalates when it needs a repo that no story names: that
is a missing story, which the refine adds.

Backlog output a run regenerates with its branch's `bl` (the component indexes, say, when the
story changes `bl sync` itself) is provisional until `bl` merges: any `bl sync` from the unmerged
main checkout rewrites it with the old code, and `bl merge` restores it with the sync it runs right
after `bl` merges, before any other repo (see `bl-merge.md`).

```bash
bl run F-3 --plan          # print the steps, run nothing
bl run F-3                 # headless (claude -p / codex exec)
bl run F-3 --interactive   # attach each session instead
bl run F-3 --resume        # continue after clearing ## Escalation to "None."
bl run F-3 --max-rounds 1  # override the round cap for this run
bl status F-3              # includes the run state
```

Fix rounds make the smallest change per review item and are followed by a
self-review of the fix diff before the gate. Findings in code the branch did not
change go to `## Deferred` instead of blocking the feature. Containers a step
leaves behind are removed unless they belong to a compose stack
(`BL_KEEP_TEST_CONTAINERS=1` keeps them).

The gate only runs on a clean worktree. Anything a reviewer leaves behind is
quarantined under `.bl/run/F-3.quarantine/`; `bl status` shows it.

Configure the test gate once per repo with a `test` stage plugin, e.g.
`"node-ws": { "bootstrap": "pnpm install", "test": "pnpm test" }` and
`"plugins-test": ["node-ws"]` in the repo's `backlog.json` `repos` entry, or
`plugins-test: [node-ws]` in the feature frontmatter (which applies in every repo
of the feature). The gate runs every prepared repo's `test` plugins, resolved
with that repo's config, in that repo's worktree, so every repo's tests run
before review. A repo without one is skipped by name; with none in any repo
the suite is skipped and the run says so. The clean-worktree check still runs in
every worktree.

## Several targets

Before anything starts, `bl run` lists the targets that wait: one that depends on another
target (or on a story outside them that is not done), naming the blocker, and one whose files
overlap a lower-numbered target's, naming the shared files. A target's files are its branch
diff once it has commits, else the backticked paths in its Implementation Plan; a path that is
not backticked is not seen. The rest run in parallel, each as a child `bl run <id>` with its
output in `.bl/run/<id>.out`, and one line per target is printed when all are done. Re-run the
same command after the first ones merge.

## Adding stories

```bash
bl new F-3 C01 --title "Mint codes" --points 3
bl new --from plan.json            # spec with "feature": "F-3"; per-story "component" overrides allowed
```

Feature stories use the shorter `story-feature` template. Keep plans under 40
lines and put design in the feature file.

## Sizing rules the refine prompt enforces

Stories 2–5 points (never 1); 8–20 points per feature; no verification-only
stories; dependencies outside the feature must be done or pulled in.
