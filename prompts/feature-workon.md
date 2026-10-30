You are implementing feature {{featureId}} — "{{title}}" on one branch.

Repos        : {{storyRepos}}
Unit dir     : {{unitDir}} (your working directory)
Lead worktree: {{worktreePath}} ({{targetRepo}})
Other repos  : {{otherWorktrees}}
Branch       : {{branchName}}
Feature file : {{featureAbsPath}}
Backlog repo : {{backlogDir}}

## Two-repo model (read this first)

- The **feature file** and the **story files** live in the backlog repo. Status
  updates, acceptance-criteria checkoffs, and **## Deferred** additions are
  written there and committed on the backlog's main branch with
  `bl sync --commit`, never a raw `git add` / `git commit` in the backlog
  repo, whose index other sessions share. They never go on your code branch.
- **Code changes** go in each repo's worktree, `{{unitDir}}/<repo>`, and are
  committed to `{{branchName}}` there. One branch and one pull request cover the
  whole feature; stories do not get their own.

## Before you start: the theme brief and the road map

{{readTool}} these with the feature file, before you change any code.

- **The feature's theme brief**, the documents its theme names for any work in it:

{{themeBrief}}

- **The road map**, `{{backlogDir}}/roadmap.md`: where the project is heading and the hazards on
  the way (gates such as go-live). Its statuses are set by hand and inform; bl never gates on
  them. When the work would go against an entry (a production deploy while a go-live hazard is
  not `done`), warn the operator with a task, `bl task {{featureId}} --title "<the warning>"
  --gate none` (see step 3), and carry on with the Design as written; do not stop on your own.

## The stories, in dependency order ({{storyCount}})

{{storiesPlan}}

## Steps

1. {{readTool}} the feature file: Premise, Design, Acceptance, Deferred. The
   Design section is the contract every story implements. Then read each story
   file listed above.

2. Work the stories in the order given. For each story:
   a. Set `status: in_progress` in its frontmatter.
   b. Implement its plan. Commit as you go with Conventional Commits, the
      subject ending in ` ({{featureId}} S-<n>)`, body wrapped at 100 columns.
   c. Run the tests that cover what you changed.
   d. Check off its acceptance criteria (`- [ ]` → `- [x]`).
   e. Make **one** backlog commit for the story:
      `bl sync --commit -m "chore: S-<n> implemented in {{featureId}}" --story S-<n> --path {{featureRelPath}}`.
   Do not open a pull request per story and do not mark stories done —
   `bl merge` marks all of them done at once.

3. Default to doing uncovered work yourself when it is under 8 points. A
   finding of about one point in code this branch already touches is fixed
   now too, not deferred; a nit is fixed or dropped, never deferred. What is
   left goes to one of three places:
   - Follow-up code work of 8 points or more: a bullet under the feature's
     **## Deferred**, starting with its estimate `[points: N]`, with enough
     context for someone else to act on it. Nothing else goes there:
     `bl validate` refuses an unsized bullet in an open feature's
     **## Deferred**.
   - A record of what you did or found, or a hand-off between stories: a
     dated bullet under the feature's **## Notes**,
     `- <YYYY-MM-DD> ({{featureId}} S-<n>): …`, with no marker.
   - Anything the operator must do, with a moment to do it: a task. Write its
     body (what to do, the exact commands as pasteable blocks with their
     expected output, and why it is not code) to a file under
     `{{backlogDir}}/.bl/run/`, then run
     `bl task {{featureId}} --title "<what to do>" --gate <merge|next|none> --body-file <file>`.
     `--gate merge` holds `bl merge {{featureId}}` until the task is done (a
     step between the run and the merge, such as a migration); `--gate next`
     holds every `bl run` and `bl implement` once {{featureId}} is done (a
     step right after the merge, such as a shared-service restart);
     `--gate none` holds nothing (a fact or warning the operator must see).
     `bl task` commits the backlog itself; only the operator runs
     `bl task done`.

   Never create new stories from a
   workon session, except the ad-hoc story for a bug you fixed (see **Blocked
   by a bug**); the operator decides at merge what becomes new work. Phrase a
   bullet or task that depends on a merge as "after review and merge, …", never "after
   <repo>#<pr> merges": the PR goes through `bl review` first.

4. If a story's plan turns out wrong, correct the plan briefly in the story
   file and continue. If the **Premise** turns out to be false — the feature is
   built on an assumption the code does not support — stop: write what you
   found under **## Escalation** in the feature file, as **Writing an
   escalation** below describes, commit that to the backlog
   (`bl sync --commit -m "chore: escalate {{featureId}}" --path {{featureRelPath}}`), and end the
   session without opening a pull request. That is the right outcome, not a
   failure.

5. When every story is implemented, run the full test suite for this repo
   (see **Tests** below), then format the changed files (see **Format and
   lint** below).

6. **Self-review before the pull request.** Read the whole branch diff
   (`git diff main...HEAD`) as if it were someone else's pull request, against
   the feature's Acceptance and every story's acceptance criteria. For each
   function you changed, enumerate its input classes and probe at least one
   malformed or second-shape input. Fix what you find and commit. The reviewer
   starts where this ends.

7. Push the branch. Do not open the pull request: `bl review {{featureId}}`
   opens it, titled from the feature and with the change document's
   `## Description` as its body, and records it in the change document
   (`{{changeAbsPath}}`). Check off any feature-level Acceptance items the
   branch already satisfies, and commit the backlog:
   `bl sync --commit -m "chore: {{featureId}} implemented" --path {{featureRelPath}}`.

8. A story works in one repo, its component's. The feature's repos are its
   stories' repos, listed above in the order bl prepares, reviews and merges
   them (`bl` first, then by first story); `bl` prepared a worktree on
   `{{branchName}}` in each before you started, and this session starts in the
   first. Make each repo's changes in its own worktree. A change in a repo no
   story of the feature names is one of two things. A drive-by change the
   work needs or found (a fix in a dependency, a doc the change makes stale, a
   blocking bug in another repo) is a side story: make it with `bl side`, as
   **Side changes** below says. Work the feature's design is missing is a
   missing story, and adding one is the refine's call, so write it under
   **## Escalation** in the feature file, naming the repo and the work. Never
   create a worktree yourself or edit a repo's main checkout.

{{sessionStack}}

{{blockedByBug}}

{{escalationGuide}}

{{sideChangeGuide}}

{{toolGuide}}

## IMPORTANT

- NEVER `git add` files that are in `.gitignore`.
- Do NOT edit backlog index files or run any `bl sync` other than the
  `bl sync --commit` lines above. Do NOT run `bl merge` —
  merging is the operator's job.
- Never ask or tell the operator to merge a PR, and never merge one yourself.
  Review is a required gate: `bl review` reviews the open PR, and
  merging first skips it. A side change is a `bl side` story (see **Side
  changes**), which merges with the feature; it needs no task.
- The tool guide's `--story {{featureId}}` convention is for stories; format
  backlog markdown for this feature with `bl format --no-story <paths>`.
- At the very end, print `next: bl review {{featureId}}` as the
  second-to-last line of your response and the PR URL as the final line. If
  you ended with an Escalation instead of a pull request, say so on the final
  line and leave out the `next:` line.
