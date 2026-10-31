# Backlog System — Agent Instructions

Each repo's backlog location is configured in `backlog.json` at the repo root:

```json
{
  "backlog": "backlog"
}
```

The `backlog` key is the relative path to the backlog directory. Stories, components and features are plain
Markdown files with YAML frontmatter. A sync script regenerates all index tables from
frontmatter on demand.

Run `bl agents` from any repo to print this file.

### Stream policy

`bl` follows the standard Unix split:

- **stdout** carries the answer to the user's question — paths, IDs,
  tables, JSON. Pipeable. One logical record per command.
- **stderr** carries progress, status, warnings, and explanatory output.
  Use `2>/dev/null` to suppress.
- **exit code** is non-zero on error; an error message goes to stderr via
  `console.error`.

Per-command stdout contracts:

| Command              | stdout                                                    |
| -------------------- | --------------------------------------------------------- |
| `bl new`             | one line: relative path of the new story `index.md`       |
| `bl new --json`      | one JSON object (schema `bl-new-json/v3`)                 |
| `bl new --from`      | one path per line (one per created story)                 |
| `bl side`            | one line: `S-<n><TAB><worktree path>`                     |
| `bl side --json`     | one JSON object (schema `bl-side-json/v1`)                |
| `bl attach`          | nothing (progress → stderr)                               |
| `bl attach --json`   | one JSON object (schema `bl-attach-json/v1`)              |
| `bl move`            | nothing (progress → stderr)                               |
| `bl move --json`     | one JSON object (schema `bl-move-json/v1`)                |
| `bl next-id`         | one ID per line                                           |
| `bl which`           | one line: absolute path                                   |
| `bl list` / `ls`     | the table                                                 |
| `bl status` (no ids) | the table, as `bl list`                                   |
| `bl tree`            | the rendered tree                                         |
| `bl history`         | the week table (`--json`: one object)                     |
| `bl report`          | one line: the path of `index.md` (`--json`: one object)   |
| `bl grep`            | match table                                               |
| `bl what-next`       | one line: the suggested story ID (empty if no suggestion) |
| `bl next`            | one line: the next ranked feature ID (empty if none)      |
| `bl deps`            | one story ID per line, leaf-first                         |
| `bl log`             | log lines                                                 |
| `bl agents`          | the AGENTS.md content                                     |
| `bl view`            | the file as it is when redirected; else nothing (editor)  |
| `bl edit`            | nothing (opens editor)                                    |
| `bl init`            | nothing (status → stderr)                                 |
| `bl sync`            | nothing                                                   |
| `bl validate`        | the human findings report (or empty if no findings)       |
| `bl validate --json` | one JSON object: `{ findings: [...], summary: {...} }`    |
| `bl fix`             | the fix report (or empty if no findings); holds the lock  |
| `bl fix --json`      | one JSON object `{ fixes, summary }`; holds the lock      |
| `bl fix --dry-run`   | the planned-edit report (no writes occur, no lock)        |
| `bl fix --story S-1` | fix report, S-1-anchored findings only; holds the lock    |
| `bl done`            | nothing                                                   |
| `bl implement`       | nothing                                                   |
| `bl merge`           | nothing                                                   |
| `bl refine`          | nothing (interactive)                                     |
| `bl review`          | nothing (progress → stderr)                               |
| `bl allow`           | nothing                                                   |
| `bl agent`           | passes through to the configured agent                    |
| `bl updates sync`    | one line per story: created, updated, closed or unchanged |
| `bl updates run`     | one line per story: merged, held, decision or skipped     |
| `bl updates status`  | the open update stories by repo and state (`--json`)      |
| `bl updates approve` | one line: requested                                       |
| `bl updates drop`    | one line: requested                                       |
| `bl inbox`           | the items by kind (`--json`: an array); `inbox: empty`    |
| `bl inbox done`      | nothing: refuses, naming the verb (stderr)                |
| `bl help`            | help text                                                 |
| `bl <cmd> --help`    | help text                                                 |

`bl done`, `bl new` (unless `--no-sync` or `--dry-run`), `bl side`, `bl attach`
and `bl move` (each unless `--no-sync`), and `bl merge`
commit their own backlog changes on the backlog's current branch: the story
they touched, a new component dir or appended feature file, and every path
the sync wrote. They commit through `syncAndCommit` (`src/sync.js`)
in the same backlog-lock hold as the sync, so other uncommitted or staged edits
in the backlog stay out. The commit notice goes to stderr. When the backlog is
not a git repo they skip the commit; when the commit fails they exit 1 and
list the paths to commit by hand. `bl task` and `bl task done` commit the
same way, with the task file and `blockers.json` among the paths.

When adding a new command, ask: "what is the one piece of information
the caller needs?" That goes on stdout. Everything else goes through
the `info(…)` / `warn(…)` helpers in `src/config.js`. Errors go through
`console.error`.

## Directory Layout

```
<backlog>/
  index.md                      ← master stack-ranked list (auto-generated tables)
  feature-order.md              ← the preferred feature order: `ranked:` by hand,
                                  tables by `bl sync` (F-53 D1)
  roadmap.md                    ← the road map: `entries:` and one section
                                  each, all by hand (F-53 D2)
  flow.json                     ← every story and feature status, what each
                                  implies, and the gates per type (F-66 D1)
  blockers.json                 ← every hold between units, one edge per line,
                                  sorted, written only by bl block (F-66 D2)
  tasks/
    T3-re-mint-the-key.md       ← task: an action for the operator, one flat
                                  file, no branch (F-65 D1; see bl task)
  stories/
    S33-importmap/
      index.md                  ← story file (hand-written + execution plan)
      change.md                 ← its change document, once it has a branch
  components/
    C00-infrastructure/
      index.md                  ← component: a code boundary in one repo
  features/
    F42-…/index.md              ← feature (+ change.md)
  themes/
    backlog/index.md            ← theme: a value area that never finishes
  epics/
    E62-backlog-taxonomy/
      index.md                  ← epic: an outcome under one theme that finishes
  backlog.json                  ← top-level config; `repos` is the repo
                                  registry and every per-repo setting (F-51 D4)
```

Taxonomy lives in frontmatter, never in paths (F-49 D3): a unit's directory
never moves, whatever its status, and bl reads only `stories/`, `components/`
and `features/`; nothing under a `.completed/` directory is read. A story's
component is its `component:`, and its repo that component's `repo`. Its theme is
its feature's `theme:`; a story with no feature is in every theme whose `repos`
list its component's repo (F-51 D1). No command takes a project: `--theme`
filters by value (F-51 D5). On a `backlog.json` that still has the pre-F-51
`projects` block, `loadConfig` throws, saying the settings now live in
`repos`, so every command refuses (F-51's `migrate-value-axis.js` moved them;
F-62 removed it once it had run).

### `backlog.json` `repos` (F-51 D4)

`repos`, keyed by repo name, is the only list of repos and the home of every
per-repo setting:

```json
"repos": {
  "app.acme.com": {
    "path": "../app.acme.com",
    "deployable": true,
    "update_tests": ["app-tests"],
    "plugins-bootstrap": ["node-ws", "acme-vendor"],
    "plugins-test": ["app-tests"],
    "overrides": { "plugins": { "session-stack": { "workon": "…", "cleanup": "…" } } }
  },
  "bl": { "path": "../bl", "deployable": false, "update_tests": ["bl-tests"] }
}
```

- `path` (relative to the backlog), `deployable` (a release manifest records
  the repo, `bl merge F-n`) and `update_tests` (the `plugins:` `bl updates
sync` writes on the repo's update stories; `[]` for none) are required.
  `loadConfig` fails naming the repo and the key, and has no defaults. Any
  other key but `plugins-<stage>` and `overrides` is an error.
- `plugins-<stage>` is the repo layer of the plugin cascade (see
  **Activation via Frontmatter**); there is no generic `plugins:` form here.
- `overrides` is merged over the top level by `mergeConfig` for work in that
  repo: `configForRepo(config, repoName)`. Repo attributes and overrides stay
  apart, because `mergeConfig` replaces every key but `plugins` and
  `language_dispatch` wholesale.
- A story's one repo is its component's `repo` (`unitRepo` from
  `placeStory`, F-52 D1); a story whose component has no `repo` has none,
  and the story verbs exit naming the component. A leftover `primary_repo`
  or `secondary_repos` on a story is never read; `bl validate` reports it as
  `repo-key`. A feature's repos are its
  stories' (`featureRepoOrder`, F-52 D3); a feature run takes each
  worktree's repo, the lead's config for the review. A plain
  `loadConfig()` is the top level only: the cwd finds the backlog and never
  picks a repo, so a unit resolves the same from any directory.

### `backlog.json` `title`: the backlog's display name (S-581)

`title` is the name `bl sync` gives the top-level `index.md`: its frontmatter
`title:` and its `# ` heading, rewritten on every sync, so changing the key
renames an index an older sync wrote. It is optional; unset, the name is
`Backlog` (`DEFAULT_BACKLOG_TITLE`), and a value that is not a one-line,
non-empty string makes `loadConfig` throw. `config.title` carries the resolved
value. `bl init` writes `"title": "Backlog"` into a new `backlog.json`.

### `backlog.json` `worktrees`: the worktree root (F-60 D1)

`worktrees` names the **worktree root**, a directory relative to the backlog
(`"../worktrees"`). A unit's directory is `<root>/<branch>` and each of its
repos' worktree is `<root>/<branch>/<repo>`: a feature's, a story's, a side
story's and an update story's alike. The layout is fixed in code, built only by
`config.js` `worktreeRoot(config)`, `unitDirFor(config, branch)` and
`worktreePathFor(config, repo, branch)`; no other code joins a worktree path. The
unit directory is not a git repository, so every git command in it names its
repo (`git -C <repo>`).

- `loadConfig` requires `worktrees`, a non-empty string, with no default; `bl
init` writes `"../worktrees"` into a new `backlog.json`. One that still holds
  `{repo}` (the old per-repo template, `../worktrees/{repo}`) throws, naming
  `scripts/migrate-worktree-layout.js`, which moves the worktrees; only the
  migration loads it, through `loadConfig({ legacyWorktrees: true })`. A
  repo's `overrides.worktrees` throws: a repo outside the unit directory
  would split the unit.
- A bl worktree is `<root>/<branch>/bl[/…]` (`isBlBranchPath(root, path)`):
  `foreignCheckout` and the Codex branch-bl approval read it, never a
  substring of the path.
- Removing a worktree (`bl merge`'s cleanup, a `bl side` undo, an update
  story's run) removes its unit directory too once nothing but its
  `.workon.lock` is left in it (`story.js` `removeUnitDirIfEmpty`); one that
  still holds another worktree stays.
- **F-60's migration**
  (`node scripts/migrate-worktree-layout.js [--dry-run] [--backlog <dir>]`,
  logic in `src/migrate-worktree-layout.js`, D4) moves, for every registered repo, each linked worktree under `<root>/<repo>/` to
  `<root>/<branch>/<repo>` with `git worktree move` (a detached update worktree
  uses its directory name as the branch). Right after each move it points every
  string in a `.bl/run/*.json` that is the old path or inside it (compared with
  its links resolved) at the new one. A path that reaches a worktree through
  a link, or leaves it through a link inside it, is first pinned to its real
  path, before the first move, so it still matches once the link dangles,
  in a rerun too. The moves are journaled first in
  `.bl/migrate-worktree-layout.json`, removed once the commit lands, so a rerun
  after a failure part-way also points the run states at the moves already
  done. It removes the
  `<root>/<repo>/` directories the moves emptied, leaves and lists anything
  else in them, sets `backlog.json` `worktrees` to the root (the template with
  `/{repo}` cut; unset meant `../worktrees/{repo}`) and commits once through
  `migration-txn.js`. It refuses before anything moves when a worktree to move
  holds a live `.workon.lock`, a target exists or two moves share one, a file
  or link stands where a target's parent would be made, a target lies inside a
  worktree to move or another target, another registered repo checkout or
  worktree lies inside a worktree to move (it would lose its git
  registration), the journal records a move that is neither done nor still
  planned, a run state or the journal cannot be
  read, or (the transaction's own refusals) a `bl` run is active or the backlog is not clean
  at `origin/main`. A dry run prints the plan, then any refusal. The moves are
  outside the backlog, so a failed run's git rollback does not undo them; a
  rerun moves the rest, and once done plans nothing. The operator runs it after
  `bl merge F-60` has merged `bl` (task T-14).

### Every agent session starts in its unit directory (F-60 D3)

Every agent session of a unit (implement, story, fix-tests, self-review, fix,
fix self-review, review passes and verifier, merge-resolve, and `bl implement`'s
interactive one) is spawned with `cwd` = the unit directory, `unitDir`.
`prepareFeatureWorktree` and `prepareStoryRun` return it beside the lead
`worktreePath` and put it in `baseVars`; `bl review`'s and `bl merge`'s preps
take it from the lead worktree (`unitDirOf`). `feature-run.js` `runSession`
passes `prepUnitDir(prep)` to every session as `unitDir` and as the
`{{unitDir}}` prompt variable (a prep with none, a test's, runs in its lead
worktree).

- `runHeadlessSession` / `launchSession` take `unitDir` and give the provider
  `spawn({ cwd: unitDir, worktreePath, … })`; each provider's `spawn` runs its
  CLI in `cwd` (default `worktreePath`). Codex runs `-C <cwd>` and adds the git
  metadata of every repo worktree under it (`codexRepoWorktrees`) as write
  roots, so it can commit in each. Its branch-bl approval is `./bl/bin/bl` in a
  unit directory that holds a bl worktree, `./bin/bl` in a bl worktree.
- Write roots are `resolvePermissionScopes(config, { unitDir })`:
  `[unitDir, backlogRoot, …permissions.write]`, so every repo worktree under
  the unit directory is writable; `{{worktree}}` in `permissions` is the unit
  directory. The `Bash(rm <dir>/*)` grant names it too.
- The session lock `.workon.lock` is in the unit directory, one per unit:
  `isSessionRunning(unitDir)`, `runFeature`'s refusal, a review round's
  `holdReviewLocks` (the unit directory, plus any reviewed worktree outside
  it), `bl merge`'s cleanup and the migration's live-session check.
- Resume (`findSession`) and transcript token totals read the unit directory's
  transcripts; `transcriptDirs` adds each worktree's for sessions that started
  there before.
- Plugins, the test gate, review commands, the activity log and git keep
  running in each repo's worktree.
- The tool guide's working-directory line (`{{workingDirectory}}`) is
  `_working-dir-unit.md` when `unitDir` is set: the unit directory is the
  working directory and each repo's worktree is `{{unitDir}}/<repo>`.
  Sessions with no unit (refine, triage) get `_working-dir.md`. The unit
  prompts head with `Unit dir :` and name the lead repo's worktree
  `Lead worktree:` (`Worktree :` for a story), never "this worktree".

## Frontmatter is YAML

Every frontmatter block in the backlog is YAML under the failsafe schema (F-62 D1), read
only by `parseFrontmatter` and written only by `serializeFrontmatter` (`config.js`), both
through the `yaml` package, bl's one runtime dependency (pinned, `package-lock.json`
committed; `bin/bl` stops with `npm ci --prefix <bl>` when `node_modules` is missing).
Every scalar is a string (`points: 5` reads `"5"`, an empty `key:` reads `""`); mappings and
sequences are objects and arrays at any depth. The writer keeps the keys in object order,
writes a sequence of scalars in flow style (`[S-1, S-2]`, `[]` when empty), mappings and
sequences of mappings in block style, an empty value as a bare `key:`, and quotes what the
library says needs quotes: bl never decides that. A block that is not YAML throws
`FrontmatterError` with the file's line and column (the opening `---` is line 1), and a
reader that knows the file names it (`parseFrontmatterOf`).

Every write goes through `serializeFrontmatter` (F-62 D3): bl never edits a frontmatter line
as text. A template's frontmatter (`templates/*.md`) holds its keys in order, the fixed values
set and the variable ones empty; `renderTemplate` (`template.js`) parses it, sets the values
(a key set to `undefined`, such as `feature:` on a story with none, is left out) and writes
it. `{{var}}` placeholders live only in template bodies.

The list keys (`LIST_KEYS`: `stories`, `depends_on`, `required_for`, `components`,
`features`, `epics`, `paths`, `repos`, plus `plugins` and `plugins-<stage>`) are
sequences, read as the parsed array (`parseIdList`, `parseNameList`, `parsePathList`,
`parsePluginList`). A list key with no value is an empty list. Any other scalar (even
`S-1` or `a, b`), a mapping, or a member that is not a string (not a mapping, for a change
document's `repos:`) is not read: the reader throws `FrontmatterListError` (`listMembers`)
rather than drop a blocker or a plugin as if it were never written. `bl validate` reports
both shapes it will not read: `frontmatter-yaml` and `frontmatter-list` (see **bl validate**).

The backlog was moved to this format by the one-off `scripts/migrate-frontmatter-yaml.js`
(logic in `src/migrate-frontmatter-yaml.js`, F-62 D5): every file `bl validate` reads is read
with `parseFrontmatter`, after `legacyRepaired` double-quotes, whole, the value of each
`key: value` or block sequence member line the retired line reader read differently (a value
YAML cannot parse, even one it reads past its line such as `[WIP` or `'unfinished`; an alias
with no anchor; a tag or an anchor no alias names; or a plain value YAML would cut at a ` #`
comment); every other line keeps its YAML structure, and a block that is still not YAML stops
the run before anything is written. Each list key's string becomes a sequence, split where
that key's retired reader split it (`listOfString`: at commas outside quotes and `{…}`/`[…]`
groups, and an id key at whitespace and `[`/`]` too), and the block is
written by
`serializeFrontmatter`. `--dry-run` prints the files and the counts; a run refuses unless the
backlog is clean at `origin/main` with no `bl` run active, and commits once through
`migration-txn.js`. A second run plans nothing, so rerunning it after a merge picks up a block
an older bl wrote in the meantime.

### Spec writes (F-67)

A read-modify-write of a story or feature spec goes through `updateSpecFile(backlogRoot,
indexPath, mutate)` (`spec-file.js`). Under the spec's lock it reads the file (a CRLF file is
read as LF), refuses one that does not start with a `---` block with a `FrontmatterError`
naming the file (a writer would otherwise prepend a second block), parses it with
`parseFrontmatterOf` and calls `mutate(fm, body)`, which changes `fm` in place and returns the
new body, `undefined` (body unchanged) or `false` (write nothing). It writes
`serializeFrontmatter(fm) + body` back with the file's line end through `atomicWriteFile`, so a
failed write leaves the previous file whole and its staging file only in `.bl/tmp/`; bytes equal
to the file's are not written. It returns whether it wrote. `backlogRoot` is passed, never
worked out from the path. A write of a whole new file, or a snapshot restore, calls
`atomicWriteFile` directly; epic, theme and component index files are written only under the
backlog lock and need `atomicWriteFile` only.

- **The lock.** `withSpecLock(indexPath, fn, { waitMs })` is a pid lock in the temp dir keyed
  by the spec's real path (`specLockPath`; the `bl-tokens-<hash>.lock` file the token writers
  took before F-67, so an older `bl` and a newer one exclude each other). It is re-entrant within
  a process: a nested call for a lock this process holds runs `fn` directly. It waits up to
  `waitMs` (10 s) for a live holder, reclaims a dead holder's lock, and otherwise throws
  `SpecLockError` naming the spec and the holder. `fn` is synchronous; a returned promise is an
  error.
- **Failure.** Token bookkeeping is best-effort: the token writers catch and return false. Every
  other writer lets the error propagate, so a write that could not happen fails the command
  instead of being lost.
- **Lock order.** The backlog lock (`lock.js`) is the outer lock, a spec lock the inner one:
  `bl sync`, `bl merge`, `bl fix` and `persistLandedCommits` take the spec lock per file inside the
  backlog lock. Nothing takes the backlog lock while holding a spec lock, and nothing holds two
  spec locks at once. A caller that adds a spec lock says so in a comment at the call.
- **Who is on it.** The token writers (`accumulateTokensOnFile`, `accumulateStepTokensOnFile`,
  `recordStoryTokens`) write through `updateSpecFile`, and `recordFeatureTokens` holds
  `withSpecLock` across its transcript read and nests `updateFeature` in that hold (the lock is
  re-entrant). `bl sync`'s spec rewrites (`syncFeature`, `syncStoryTasks`) write through it too,
  as do `feature-cmd.js` `updateFeature` (approve, the run's status, the totals re-read),
  `bl merge F-n`'s fold (`markFeatureMerged`: each story, then the feature, one spec lock at a
  time inside the backlog lock) and `bl done`'s one write (status, commit, completed and the
  transcript totals collected inside the hold; a collection failure is non-fatal, a write
  failure fails `bl done`). `persistLandedCommits` keeps its `read`/`write` seams and runs them
  inside `withSpecLock`, and `bl fix` (`fix.js`) its own read and atomic write of each story it
  fixes, inside the backlog lock; both use `readSpecText` and `specText` (`spec-file.js`) for the
  same CRLF and fence handling. A new feature's file is written
  with `atomicWriteFile`. The run loop's writers (`writeEscalation`, `recordStoryRunFields`) and
  `bl updates`' (`recordMerge`, `recordOutcome`, `dropStory`, the request write in
  `requestUpdate`, and `syncUpdates`' refresh and close, which apply their change to the spec
  read under the lock, inside the backlog lock) write through it too; a new update story, and
  `dropStory`'s restore after a failed PR close, are written with `atomicWriteFile`. `bl new`'s
  feature links (`appendStoriesToFeature`, each story's `feature:` in `bl new --feature`),
  `bl side`'s `markSideStory` and the repair record's relink (`settle` in `feature-links.js`)
  write through it too, each inside the backlog lock; `bl new`'s new story, component, theme and
  epic files, and the snapshot restores of `bl side`, `bl task` and `settle`, are written with
  `atomicWriteFile`. No spec in `src/` is written in place any more (`bl new --from` stages its
  stories in a temp directory and renames it into place; `bl migrate-*` is out of scope).
- **A restore keeps the session's tokens.** When a review-verify session fails, the loop puts
  back the unit file it snapshotted before the session with `restoreKeepingTokens`
  (`feature-run.js`): the snapshot's frontmatter and body, under the spec lock and through
  `atomicWriteFile`, with the current file's `tokens_*` keys (`tokens_headless_*`,
  `tokens_updated`, `tokens_by_step`) and line end kept, since the failed session already
  recorded its usage on that file. A current file the session deleted, emptied or left without a
  readable `---` block gets the snapshot back whole; a snapshot that is not a spec is refused and
  the current file left alone. The change document beside it is put back with `atomicWriteFile`,
  and the quarantine runs, whatever an earlier restore threw; the round aborts naming each failure.

## Story Frontmatter

Every `index.md` inside a story directory begins with a YAML frontmatter block:

```yaml
---
component: C01 # the component (code boundary) the story changes
story_id: S-01 # canonical ID, always S-<number> with dash
title: User Login # short title (used in index tables)
type: feature # feature | bug | chore
points: 3 # story-point estimate (Fibonacci: 1 2 3 5 8 13)
status: backlog # backlog | refined | in_progress | done | superseded
added: 2026-03-15 # date the story was added (YYYY-MM-DD)
parent: S-10 # optional — parent story ID
superseded_by: S-50 # optional — replacement story ID
# --- set when work is complete ---
commit: 986324d # short git hash (single-repo story) — see below for map form
completed: 2026-03-15 # date marked done (YYYY-MM-DD)
---
```

`commit:` records the merge SHA(s) that landed the story. Two shapes:

```yaml
# single-repo story (the common case) — bare string
commit: 986324d
```

```yaml
# multi-repo story — map of <repo-name>: <sha>, one per cleaned repo
commit:
  bl: 986324d
  containers: 7fa12e0
```

`bl merge` picks the shape automatically: one repo cleaned → string;
two or more → map. A story merges its one repo, so its `commit:` is a
string; a feature's is a map once it spans two repos. While a feature merge
is in progress (a secondary failed), `commit:` holds the map of repos landed so far;
each landing re-reads that map under the backlog lock, adds its SHA and
replaces the file atomically, inside its spec lock (`persistLandedCommits` in `cleanup.js`), so
concurrent merges keep each other's SHAs; mark-done collapses the union.
A repo whose story branch is gone locally (merged on the forge, or landed
by an earlier run) records the tip of its `main` after the push, unless an
earlier run already recorded its merge SHA.
`bl done`
defaults to the string form; pass
`--commit <repo>=<sha>` (repeatable) to write a map explicitly. The
positional `[commit-hash]` and `--commit` are mutually exclusive.

### Field Reference

| Field               | Required | Values                                                | Notes                                                                           |
| ------------------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `component`         | yes      | `C<nn>`                                               | The code boundary; the story's repo is its `repo` (F-49 D4, F-52 D1)            |
| `story_id`          | yes      | `S-<nn>` (dash required)                              | Unique across the entire backlog                                                |
| `title`             | yes      | short string                                          | Appears in all index tables                                                     |
| `type`              | yes      | `feature` `bug` `chore`                               | Story type                                                                      |
| `points`            | yes      | 1 2 3 5 8 13                                          | Fibonacci; feature and backlog totals roll up                                   |
| `status`            | yes      | `backlog` `refined` `in_progress` `done` `superseded` | Drives table placement and gates                                                |
| `added`             | yes      | `YYYY-MM-DD`                                          | Set once, never changed                                                         |
| `parent`            | no       | `S-<nn>`                                              | Parent story if this was split from one                                         |
| `superseded_by`     | no       | `S-<nn>`                                              | Replacement story ID                                                            |
| `commit`            | on done  | short hash _or_ map `<repo>: <sha>`                   | String for single-repo stories; map for multi-repo                              |
| `completed`         | on done  | `YYYY-MM-DD`                                          | Set with `status: done`                                                         |
| `feature`           | no       | `F-<n>`                                               | The feature this story is part of (see **Features**); set by `bl new --feature` |
| `found_by`          | no       | `F-<n>` or `S-<n>`                                    | The unit whose work found a side story; set by `bl side --from` (F-48 D2)       |
| `review_rounds_max` | no       | integer                                               | Written by a story run; caps review rounds                                      |
| `update_repo`       | no       | forge slug, e.g. `acme/tools`                         | Written by `bl updates sync`; with `update_branch` the key of an update story   |
| `update_branch`     | no       | branch name, e.g. `renovate/koa-3.x`                  | Written by `bl updates sync`                                                    |
| `update_pr`         | no       | PR number                                             | Written by `bl updates sync`                                                    |
| `update_head`       | no       | commit sha                                            | The branch head the last sync saw; `bl updates run` skips a known-red head      |
| `update_security`   | no       | `true`, else absent                                   | A vulnerability-alert update; `bl updates run` takes it first                   |

## Component Frontmatter

Every `components/C<nn>-*/index.md` begins with:

```yaml
---
component_id: C32
title: bl Tool Enhancements
repo: bl # a repo registered in backlog.json
home: true # this repo's home component; work with no better component lands here
paths: ['src/**', 'test/**'] # optional: globs relative to the repo root (F-61 D2)
---
```

A component is a label, never a container: it has no `status`, `points` or
`completed`, and `bl done` refuses it. `bl new --component --repo <r> --title <t>
[--paths <glob,…>] [--home]` creates one with the next number (`bl next-id component`); every
registered repo has exactly one home component, and `bl new --repo <r>` with no
component, like `bl updates sync`, files a story there.

A component is an organizational map (F-61): a name for a real code boundary that
people and agents read, not something `bl` enforces. `paths:` is optional: absent
means "not mapped", never an implied `**`, and `bl new --component` without `--paths`
writes no `paths:` key. When present it lists the globs, relative to the component's
repo root, that the component covers, matched with Node's `path.matchesGlob` (a leading-dot segment
included, so `**` covers `.github/`). It is a YAML sequence like every list key; a glob
that starts with `*` or holds `[`, `{` or `,` must be quoted in it (`bl new --component`
writes the list with `serializeFrontmatter`, which quotes what YAML needs). `parsePathList` (`story.js`) takes the parsed
value and keeps an empty member (a bare `-` is `""`), a member that is not a string (a
nested list or mapping) and a `paths:` that is not a list, for `bl validate` to report and
no glob to match. Two components may overlap: ownership is not exclusive. `bl
validate` reports `component-paths` for an entry that is empty, not a string,
absolute or has a `..` or `.` segment (`git diff` names no path `./src/…`, so such an entry
would never match); a missing or empty list is no finding. `--paths <glob,…>` on the
command line splits at each comma outside a `{…}` group (`splitGlobs`), and every entry
is checked the same way. A story filed under the wrong component moves with
`bl move <S-n>… <C-n>` (see `bl move` below), never a hand edit of `component:`.

## Themes and Epics

Components are the code axis; themes and epics are the value axis above features (F-51 D1).
A **theme** is a value area that never finishes. An **epic** is an outcome under one theme
that finishes once every feature under it is done. A **feature** names its `theme:` and,
optionally, its `epic:`, both set by hand. A **story** has neither: it reaches them through
its feature. A story with no feature (a chore, a bug or an update) belongs to every theme whose
`repos` lists its component's repo.

```yaml
# themes/backlog/index.md
---
theme_id: backlog # the directory name: a slug, [a-z][a-z0-9-]*
title: Backlog
repos: [bl] # required; [] for a product theme
brief: # required, non-empty: what an agent reads before working in the theme
  - app.acme.com/docs/public/tenets.md # relative to the backlog's parent directory
  - MVP-Prototype/AI-SUMMARY.md#inspections # an optional #anchor
---
```

```yaml
# epics/E62-backlog-taxonomy/index.md
---
epic_id: E62 # E50 upward; E00–E49 were components (F-49 D2)
title: Backlog taxonomy
theme: backlog
status: open # derived by bl sync: done once every feature is done or superseded
features: [F-49, F-51] # derived by bl sync; nobody edits it
---
```

A theme's body is an `## Overview` paragraph, the tables `bl sync` writes, and a `## State`
(F-53 D4): a hand-readable log, newest last, that `bl merge F-<n>` appends
`- <date>: F-<n> done (<title>).` to and `bl sync` never rewrites. An epic's body is an
`## Outcome` paragraph. The theme's `brief:` is listed in the feature refine and run prompts
(`{{themeBrief}}`, `themeBriefList` in `theme.js`: one absolute path per entry, with its
anchor) beside `backlog/roadmap.md`; a story with no feature has no single theme and gets none.
`bl new --theme <slug> --title <t> --brief <path,…>` creates a theme (`repos: []`; without
`--brief` it exits 1, and an entry not on disk warns); `bl new --epic --theme <slug>
--title <t>` creates an epic with the next number (`bl next-id epic`); `bl new --feature --title
<t> --theme <slug> [--epic E<nn>]` creates a feature with both set (`--epic` alone gives its
theme). The CLI takes `E-50` and `E50` alike. An unknown theme or epic, or an epic of another
theme, fails before anything is written. `bl validate` enforces the value axis:

- `feature-theme`: a feature has no `theme:`, or its theme has no directory;
- `feature-epic`: a feature's `epic:` has no directory, or the epic's theme is not the
  feature's theme;
- `epic-theme`: an epic has no `theme:`, or its theme has no directory;
- `theme-repo`: a theme has no `repos:`, or one of its repos is not registered in
  backlog.json;
- `theme-brief` (F-53 D4, `findThemeBriefFindings`): a theme has no `brief:` or an empty
  one, or an entry's file (the part before `#`) is not a file on disk under the backlog's
  parent directory (an absolute path or one with `..` out of it is not). A `brief:` that is not a
  list is `frontmatter-list`.

### The roadmap (F-53 D2)

`roadmap.md`, at the backlog root, is the project's road map: its destinations (future states), the
directions to them, the hazards on the way (gates such as go-live) and the options along it
(decisions put off). It is one page. The frontmatter indexes the entries and the body holds a
preamble and one `## <title>` section per entry:

```yaml
---
entries:
  - title: Invite process engine
    added: 2026-09-28
    status: planned # planned | in_progress | ready | done, set by hand
---
```

The fields are informational: nothing derives a status, and nothing in bl gates, fails or
refuses on one. An agent whose work goes against an entry warns the operator, who decides.
Entries link no features; related work stays in each entry's prose. `bl next` never reads the
file. `bl validate` checks its shape only (`roadmap.js` `findRoadmapFindings`), both errors at
`roadmap.md`:

- `roadmap-file`: the file is missing, its frontmatter is not YAML, `entries:` is not a list
  of mappings, or an entry lacks a non-empty `title`, `added` or `status`, or has a status
  outside the four;
- `roadmap-section`: an entry has no `## <title>` section (`extractSection`), or a `## `
  section names no entry.

A backlog with no `roadmap.md` reports `roadmap-file`, and a theme with no `brief:`
`theme-brief`. `bl init` writes `templates/roadmap.md` and `templates/feature-order.md`
(empty `entries:` and `ranked:`) into a backlog that has neither, and leaves an existing one
alone (S-581). (F-53's one-off migration that wrote them for the first backlog has run; S-581
removed it, and it is in git history.)

`bl sync` derives each epic's `features:` (the features naming it) and `status:` (`done` once
it has features and every one is done or superseded, else `open`), so nobody edits them, and
writes the theme and epic tables (see `bl sync`). `bl list`, `bl tree` and `bl what-next`
filter by the value axis and the code axis with one filter (`src/filter.js`):

- `--theme <slug>`: stories in the theme by the membership rule above;
- `--epic <E-id>`: stories of the epic's features (`bl list --epic` lists the features);
- `--feature <F-id>`: the feature's stories;
- `--component <C-id>`: the component's stories.

Filters combine, and every one given must match. An unknown theme, epic, feature or component
exits 1. `bl list --epic E-50` and `bl list --features --theme <slug>` (or any filter with
`--features`) list features grouped by epic, those with no epic last, each with stories and
points done/total. `bl list` shows a Theme column: a story in several themes shows them
joined, one in none shows `-`.

## Lifecycle of a Story

```
backlog → refined → in_progress → done
```

1. **backlog** — story exists, not yet planned. Lives in `stories/S<nn>-*/`.
2. **refined** — story has been analyzed and planned. Set by `bl refine` (runs on main).
   This is the gate for `bl implement` — stories must be refined before implementation.
3. **in_progress** — implementation has begun in a worktree. Set by the implementing agent.
4. **done** — work committed. `commit` and `completed` set. The directory stays where it is.
5. **superseded** — replaced by another story. Set via `bl done --superseded`.

After any status change, `bl sync` regenerates the index files.

## Statuses and gates (`flow.json`, F-66 D1)

`flow.json`, at the backlog root, names every status of a story and a feature, what each
status implies, and the gates a unit of each type can be held at. It is plain JSON, read by
`src/flow.js`:

```json
{
  "schema": "bl-flow/v1",
  "types": {
    "story": {
      "statuses": {
        "backlog": { "implies": [] },
        "refined": { "implies": ["backlog"] },
        "in_progress": { "implies": ["refined", "backlog"] },
        "done": { "implies": ["in_progress", "refined", "backlog"] },
        "superseded": { "implies": ["done", "in_progress", "refined", "backlog"] }
      },
      "gates": { "run": { "verbs": ["run", "implement"] }, "merge": { "verbs": ["merge"] } }
    },
    "feature": { "statuses": { "draft": …, "superseded": … }, "gates": { … } }
  }
}
```

- **Meets.** A status meets `X` when it is `X` or lists `X` in `implies`. `implies` is
  written in full, never derived, because the flows are not a line: a feature loops
  `running → escalated → running`, and `superseded` is reached from any status. So
  `superseded` meets `done` (F-66 A4) and `escalated` meets `running` but not `done`.
- **Gates** name what a unit of the type can be held at and the verbs that check each. bl
  checks gates only at `run`, `implement` and `merge`.
- **`src/flow.js`.** `loadFlow(backlogRoot)` returns the parsed flow (cached while the file's
  mtime and size are unchanged) with `statusesOf(type)`, `openStatusesOf(type)` (those that do
  not meet `done`, most `implies` first, ties in file order), `listRankOf(type, status)` (the
  sort rank of `bl list` and `bl grep`: open statuses that meet `in_progress`, then the other open
  statuses with any unknown one, then closed statuses in file order), `meets(type, status, wanted)`,
  `isRunnable(type, status)` (meets `refined` and not `done`), `isUnstarted(type, status)` (a status
  of the type that does not meet `in_progress`; an unknown one is neither), `closedStatusesOf(type)`,
  `runnableStatusesOf(type)`, `unstartedStatusesOf(type)` (those sets in file order, which messages
  name through `statusWords(names)`) and `gatesOf(type)`. It
  throws a `FlowError` whose message starts with the file's path when the
  file is missing, not JSON, has a `schema` other than `bl-flow/v1`, lacks the `story`,
  `feature` or `task` type (`FLOW_TYPES`), or has a `statuses` or `gates` of the wrong shape;
  a command that reads it
  stops there. A backlog's flow is its own: code reads the running backlog's file through
  `loadFlow`, never the template, and a pure function takes `flow` as a parameter. `bl init`
  writes `templates/flow.json` into a backlog that has none and leaves an
  existing one alone; test fixtures (`mkTempBacklog`, `mk_temp_backlog`) copy the same file. Only
  `--help` falls back to the template (`flowForHelp`), since help works outside a backlog. `bl report`
  and `bl history` read the flow once in `main` and pass it down, so a run's parts agree.
- **The `task` type** (F-65 D1): `open` (implies nothing) and `done` (implies `open`), with
  `gates: {}`. A task can block a unit; nothing holds a task.
- **Who reads it.** `bl validate` takes story, feature and task statuses from it (`bad-status`,
  `task-field`), and reports `flow-json` for the file's own faults (see **`bl validate`**). Story
  status sets, closed checks and status tables all derive from it (S-1166), so a command that
  reads a status stops on a `flow.json` it cannot read. What still lives in code: the feature-only
  tables (`FEATURE_WORKABLE_STATUSES`, `BRANCHED` in `src/move.js`, `ESCALATION_GATED_STATUSES`,
  the check for an active feature with no stories in `src/validate.js`), comparisons that name the one
  status a line acts on (`s.status === 'superseded'` in `progress()`), and the writes that choose a
  closing status (`src/done.js`, `src/updates.js`), which S-1130 moves.
  `test/unit/status-literals.test.js` counts every set of story statuses in `src/`. Status names in
  this document are the shipped flow's; messages and help name the running backlog's.

## Holds between units (`blockers.json`, F-66 D2)

`blockers.json`, at the backlog root, holds every edge: a unit held at a gate until another
unit's status meets a status. Unit files hold none; `bl block list` derives each unit's view.

```json
{
  "schema": "bl-blockers/v1",
  "edges": [
    { "blocker": "S-1", "gate": "merge", "unit": "F-1", "until": "done" },
    {
      "blocker": "S-2",
      "gate": "run",
      "unit": "*",
      "until": "done",
      "active_when": { "unit": "F-54", "status": "done" }
    }
  ]
}
```

- **An edge** holds `unit` at `gate` until `blocker`'s status meets `until` (`Flow.meets`, so
  `superseded` meets `done`). Its identity is (`blocker`, `gate`, `unit`): no id, no
  duplicates. `unit: "*"` holds every unit of every type that has the gate; `blocker` is never
  `*`. `active_when` (optional) keeps the edge from holding anything until that unit's status
  meets that status.
- **The layout.** Written only by bl (`writeBlockers`, through `atomicWriteFile`): sorted by
  `unit`, then `blocker`, then `gate` in code point order (`F-10` before `F-2`), one edge per
  line in `JSON.stringify` form, keys in that order. Reading and writing it back is
  byte-identical. Not formatted by prettier. A missing file is an empty graph.
- **Merging.** Git merges by line, and two adds in one gap of the sorted list (or both at its
  end, where the last line gains a comma) touch the same lines. So git merges the file with a
  driver, `src/blockers-merge.js`: `.gitattributes` maps `/blockers.json` to `bl-blockers`
  (`GITATTRIBUTES_LINE`), and the clone's git config names the script with bl's node
  (`configureMergeDriver`). `bl block add`, `remove` and `list --fix` set both before they
  write the file, committing `.gitattributes` with it while HEAD's copy lacks the line, and
  `pullBacklog` sets the config before it rebases. The driver writes
  `mergeEdges(base, ours, theirs)` sorted: an edge either side added is kept, one either side
  removed is dropped, one side's change wins over the other leaving it. Two different versions
  of one edge, or a change on one side and a remove on the other, leave git's conflict markers,
  as does a side that lists one edge twice or is blank (only a zero-byte base, a file both
  sides added, is an empty graph). A merge can close a deadlock neither side had; `bl validate`
  reports it (`blockers-cycle`).
- **Met edges stay** as history; nothing prunes them.
- **A feature's gate** also checks the edges on each of its stories, since it runs and merges as
  one unit (`gateIds`: the feature, and every story whose feature it is).
- **The gate checks** (F-66 D3). `heldBy(config, id, verb)` is the one check: every active,
  unmet edge on a member of `gateIds(units, id)` or on `*`, at a gate of that member's own type
  whose `verbs` in `flow.json` name `verb` (`gatesAt`), so a feature honours its stories' gates
  with the story type's verbs, each edge once with its line,
  `<unit> is held at <gate> by <blocker> (<status>, needs <until>)` (`heldLine`; a wildcard edge
  is named on the unit asked about). A file with no edges holds nothing and reads neither
  `flow.json` nor the units; with edges, a missing `flow.json` stops the verb with its
  `FlowError`.
  - `bl run` and `bl implement`: `dispatch` (`verbs.js`) checks every target after they resolve
    and before `dispatchSeveral` / `runTarget` (`GATED_VERBS`, `heldTargets`). One held target
    is refused, one line per edge, then `next: bl status <blocker>` per blocker. With several,
    a held target is listed under `Deferred:` beside the scheduler's deferrals and the others
    start; when every one waits, nothing starts. `--plan` is held too.
  - `bl merge`: `mergeGates` adds the finding `blocker` first, one per unmet edge on the unit or
    its stories, before any repo is touched, for a story and a feature alike.
  - No other verb is held: `bl refine`, `bl new`, `bl review`, `bl side`, `bl status`, `bl done`.
  - No override flag: the blocker moving on (its status meets `until`) or `bl block remove`
    lifts the hold.
  - `bl status <id>` prints a `held: <line>` for each active, unmet edge on the unit (and a
    feature's stories) at any gate of its type (`heldLines`), before its deferred count.
- **`src/blockers.js`.** `readBlockers(backlogRoot)` (a `BlockersError` naming the file for one
  that is there but cannot be read, such as a directory or a dangling symlink, or that is not
  JSON, a wrong `schema`, or an edge of the wrong shape; only a missing file is an empty graph),
  `formatBlockers`,
  `writeBlockers`, `edgeKey`, `unitIndex` / `readUnits` (every story, feature and task by id, a
  story with the feature it runs with), `isActive`, `isMet`, `unmetEdges`, `gateIds`, `gatesAt`,
  `heldBy`, `heldLines`, `edgeProblems` (the per-edge checks `bl block add` and `bl validate`
  share), `holdGraph`, `findHoldCycles`, `wouldCycle` and `findBlockersFindings`.
- **The deadlock graph** (`holdGraph`, D5). Nodes are features (each standing for its stories)
  and standalone stories; an arc says one node cannot pass a gate until another moves on.
  Arcs come from every active, unmet edge, a wildcard expanded to every open unit (status not
  meeting `done`) whose type has the gate, and from every `depends_on` on an open story that
  crosses a feature boundary. A cycle is a deadlock: two features whose stories depend on each
  other across them (with no story cycle), an edge and a `depends_on`, or a wildcard edge whose
  blocker has the gate itself (it holds its own blocker). A task has no gates, so a wildcard
  edge from a task never holds the task, and is no cycle.

## Features

A **feature** is the execution unit: one branch, one pull request, one review
cycle, and one merge over an ordered set of stories. Components classify work by
code boundary; features sequence what lands together. The two are orthogonal, and
a feature may span components and repos:

```
<backlog>/
  features/
    F3-invite-codes/index.md        ← the feature, open or merged (status is frontmatter)
  stories/S53-…/index.md            ← its stories, each naming its component
```

Stories point at their feature with `feature: F-<n>`; the feature lists them
in order under `stories:`. `bl validate` flags drift in either direction
(`feature-story-missing`, `feature-story-mismatch`, `dangling-feature`,
`feature-story-unlisted`, `feature-no-stories`). The `feature-story-unlisted`
message ends with the command that fixes it, `(bl attach S-<n> F-<n> lists it)`:
membership is the feature's `stories:` list, so a story that only names the
feature is not run, counted or marked done with it. It also warns
`escalation-not-none` for a `refined`, `approved` or `running` feature whose
`## Escalation` is not `None.`, since approve and run both refuse it. A story
with no `feature:` goes through the same loop on its own branch (`bl run S-n`,
see **`bl run` for a story** below), or through the manual steps
(`bl implement` / `bl review` / `bl merge`).

### Feature frontmatter

```yaml
---
feature_id: F-3
title: Invite codes & redemption engine
status: draft # draft | refined | approved | running | escalated | done | superseded
theme: residence # required: the theme it serves (see **Themes and Epics**)
epic: E52 # optional: the epic it belongs to, in the same theme
stories: [S-53, S-596, S-597] # ordered; bl new --feature / --from append here
points: 13 # rolled up by bl sync
components: [C01, C35] # rolled up by bl sync
review_rounds_max: 2
added: 2026-09-24
approved:
completed:
commit: # merge SHA (string) or <repo>: <sha> map
---
```

A feature names no repo: no `primary_repo` (F-52 D3) and no `secondary_repos`
(S-1010). Its repos are its stories' repos, each story's its component's
(`unitRepo`, F-52 D1), in one order that every step uses,
`featureRepoOrder(stories)` (`feature.js`):

1. `bl` first, when a story is in it (S-864: a later repo's push gate reads
   backlog output that the new `bl` generates);
2. then every other repo by its first story in `orderStoriesByDeps`.

Each repo appears once. The first is the **lead repo**: the session starts in
its worktree, the review runs on `configForRepo(config, lead)`, the change
document's first `repos:` entry is its (`unitChange` reads that entry for a
feature; `ensureChange` puts a resumed document's entries in this order), and a closed feature's `commit:` map flattens to its `bl` entry,
else its first (`flattenCommit`). `reposForFeature` is that order with each
repo's worktree; it reads nothing from the feature's frontmatter or change
document, and drops a repo the config does not know (prep and merge refuse
one, naming the story). A repo enters a feature only by a story in one of its
components (F-52 D2): work in a repo no story of the feature is in is a
missing story, which the agent escalates. A leftover `primary_repo` or
`secondary_repos` on a feature is ignored, and `bl validate` reports it as
`repo-key` (remove it; F-52's migration stripped every one). `bl list
--features`, `bl status F-n` and the root index's Features table show the
ordered repos in their Repo column.

Body sections, in order: `## Premise` (the assumption the feature rests on and
a `Challenged:` paragraph from refinement), `## Goal`, `## Design` (decisions
written once; stories link here instead of restating), `## Out of Scope`,
`## Acceptance` (feature-level, observable on the merged result), `## Stories`
(generated table), `## Tasks` (generated, only when the feature has a task), `## Deferred`
(follow-up code work discovered while implementing or reviewing, `[points: N]`-prefixed,
decided once at merge), `## Notes` (dated records and hand-offs; see **`## Deferred`, `## Notes`
and tasks**), `## Escalation`
(written by an agent when the feature cannot converge; anything but `None.`
blocks approve, run and merge). Operator decisions never live in
`## Escalation`: refine records them as dated `**Decision …**` bullets in the
Design (or the Premise), and a decided escalation is set back to `None.` with
the outcome in the Review Log or the Design. The branch, PR, review state
and Review Log are not in `index.md`: they are the change document's (below).

Stories inside a feature use the shorter `story-feature` template (Summary,
Acceptance Criteria, Implementation Plan of at most 40 lines, Dependencies):
no Design Notes, To Do or Notes — those live on the feature, and a story's hand-offs go
to the feature's `## Notes`.

### The change document (`change.md`, F-42)

`index.md` is the plan; a unit's change is recorded in `change.md` beside it
(`src/change-doc.js`, template `templates/change.md`, printed by
`bl new --print-template change`). `bl run` and `bl implement` create it when
they create the branch (`openUnitChange` / `ensureChange`); a unit that never
ran has none.

```yaml
---
change_of: F-3 # or S-<n>; must match the directory
status: open # open | merged | closed
review_round: 0
review_status: # pending | fixed | addressed
repos: # one entry per repo the unit spans
  - repo: app.acme.com
    branch: f3-invite-codes
    pr: 262 # empty without a forge
    url: https://github.com/…/pull/262
    merged: # merge commit on main, written by bl merge
---
```

The body has four sections, in this order: `## Description` (written once by
`bl run`; the PR body), `## Gate` (one line per gate run: date, repo, command,
pass or fail), `## Review Log` (session blocks, newest first, written by the
review prompts) and `## Merge` (one line per repo's merge commit, then the
feature's tag and release manifest, written by `bl merge`). `bl run` records
the PR it opens on its repo's entry; `bl review` records every repo's PR.

A unit that needs a second change (its last one `merged` or `closed`) gets
`change-2.md`; bl reads the highest-numbered open one, and `bl status` prints
every repo's branch, PR, URL and merge state for each document.

`approved`, `review_rounds_max` and the `tokens_*` fields stay on the spec:
they are the plan's gate and budget, written before any branch exists.
`bl validate` fails `run-state-in-spec` (a `branch:`, `pr:`,
`review_round:` or `review_status:` key, or a `## Review Log`, in any
`index.md`), `change-of-mismatch` (`change_of` not naming the directory's
unit), `change-repo-incomplete` (a `repos:` entry without `repo` or
`branch`) and `bad-change-status`; each message names the key, and the
location the file.

Specs from before F-42 were moved by the one-off `scripts/migrate-f42.js`,
which has run on the live backlog; F-49 removed it, since it read only the
pre-F-49 layout (it is in git history before F-49).

### Lifecycle

```
draft → refined → approved → running → done
                                  ↘ escalated ↗
```

| Command                      | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bl new --feature --title …` | Scaffolds `features/F<n>-<slug>/index.md` from `templates/feature.md`; `--rounds <n>` sets `review_rounds_max`; `--body-file` supplies the body. `--repo` is refused: a feature's repos are its stories'.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `bl refine F-3`              | Agent session in the backlog repo (`prompts/feature-refine.md`): writes Premise (with the `Challenged:` check), Design, Acceptance, and cuts the stories via `bl new --from` with `"feature": "F-3"`. Sets `refined`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `bl approve F-3`             | **The human gate.** Requires `refined` and a consistent, non-empty story list; warns on dependencies outside the feature and on totals outside 8–20 points. Sets `approved`. Refuses while `## Escalation` is not `None.` (`--force` skips only the draft gate).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bl implement F-3`           | One worktree per repo at `worktrees/f3-<slug>/<repo>` on branch `f3-<slug>`; runs bootstrap/workon plugins; sets `running`; launches `prompts/feature-workon.md` (stories in dependency order, one PR at the end) or `feature-workon-review.md` when `review_status: pending`. Refuses on outside blockers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bl review F-3`              | Takes each repo's PR from the change document, else `change.find` by branch (a branch with commits and no PR gets one through `change.open`), syncs each branch with main (refuses on a conflict), then takes one review round over all of them — one verifier, one Review Log session, `review_round` up by one; the PRs are taken in the feature's repo order, and the lead repo's PR is the one run state keeps. The round is the same review step as `run`: the `review-correctness.md` and `review-failure-paths.md` passes and `review-verify.md`, on the review agent, headless unless `--interactive` (or the agent has no headless mode). Shares `run`'s state in `.bl/run/`, refuses while a run holds the feature and at the round cap. The verifier bumps `review_round` and writes `## Escalation` when the cap is hit with Must-fix items left.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bl run F-3`                 | **The autonomous loop.** Same gates as `implement`, then: implement each story in dependency order (`feature-story.md`, headless) → test gate (`test` stage plugin; one `feature-fix-tests.md` attempt) → self-review (`feature-self-review.md`) → push + a PR per repo (the lead always, another repo when its branch has commits) → review (two dimension passes `review-correctness.md` / `review-failure-paths.md` writing findings files, then `review-verify.md` writing the session) → fix (`feature-workon-review.md`, minimal changes) → fix self-review (`feature-fix-self-review.md`, scoped to the fix diff) → re-review … until `addressed`. Items still open after the last full round (`review_rounds_max`) get one closing round: fix → fix self-review → test gate → `review-verify.md` alone, checking only those items (`closingRound`); anything still open → `escalated`. Every headless prompt ends with the headless rules (`withHeadlessRules`: no background commands, commit before ending). State in `.bl/run/F-3.json`; `--resume`, `--plan`, `--interactive`, `--max-rounds <n>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `bl status F-3`              | Stories in dependency order, review state, blockers, deferred count, escalation, and the last run's state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bl merge F-3`               | Gates: the one set `bl merge S-n` applies too (`mergeGates`, `src/merge-gates.js`, F-36 D1; see `### bl merge`): `review_status` not `pending`/`fixed`, no unchecked Must/Should items in the latest session (open nits do not block; `bl run` ends `clean` only when this gate passes), a Review Log session on record unless `--no-review`, `## Escalation` empty, no worktree on the branch in a repo no story names, every main checkout on `main`. Then every worktree is brought up to date with main, gated and pushed (`integrateUnit`, F-36 D4; see `### bl merge`): conflicted generated files are regenerated (D5), other conflicts and a red gate go to a resolution agent whose resolution is gated and re-reviewed (D6, D7). A failed merge into `main` is aborted (D9). Then per repo in the feature's repo order (`bl` first, then by first story, F-52 D3): `git merge --no-ff`, push, close the open PR (`change.find`, `change.close`), remove worktree — the same routine as `bl merge`; right after `bl` merges, the backlog is synced from its merged checkout (`runBacklogSync`, as a story merge does, S-864). The repos a release records are those whose `backlog.json` `repos` entry sets `deployable: true` (every entry must set it; `loadConfig` refuses one that does not). After the last push, each touched repo's merge commit gets an annotated tag `F-3` (`F-3.2` for a second change; title and change-document path in the message), the tags are pushed last, and `releases/F-3.json` records the `main` commit of every deployable repo as its `origin` has it (an unreadable `origin` main, read before tagging, or a failed tag push, which takes back the tags it made, exits 1 before the manifest or anything `done` is written; a re-run resumes); the change document gets `merged:` per repo, the `## Merge` lines (tag, manifest link) and `status: merged`. Marks every listed story and the feature `done`, rolls up tokens, syncs, commits only the backlog paths it changed (your own uncommitted edits stay out), prints `## Deferred`. |
| `bl list --features [-a]`    | Table of features (default verb). With `--theme`, `--epic`, `--feature` or `--component`, grouped by epic with stories and points done/total; `bl list --epic <E-id>` implies `--features`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`bl edit`, `bl view`, and `bl which` accept `F-<n>` ids. `bl list` grows a
`Feature` column once any listed story has one.

### Headless sessions

`bl run` never attaches a terminal. `runHeadlessSession()` in
`session.js` resolves the same allowlist, deny list, and directory scopes as an
interactive launch and calls `provider.spawn({ headless: true })`: `claude -p
--output-format json` for Claude (a tool outside the allowlist is denied, not
prompted) and `codex exec --json --output-last-message <file>` for Codex. The
result carries the agent's final message, an error flag, token usage (which
accumulates on the feature's `tokens_*` frontmatter and on `tokens_headless_*`;
headless sessions leave no titled transcript, so the transcript re-read at
`merge` adds the headless totals back instead of dropping them), and the tools the
permission layer denied. A denial does not fail the session; the loop records
it as a failed event on its step, and `bl status` lists failed events
with their step. Gemini has no headless mode; `run --interactive` attaches
every step instead.

#### The adapter interface (F-64 D1)

`src/agents/provider.js` (`AgentProvider`) is the interface; `claude.js`,
`codex.js` and `gemini.js` are its adapters, handed out by name by
`getProvider()` in `src/agents/index.js`. Besides `spawn`,
`translatePermissions`, `getToolHints`, `findSession`, `parseLogs`,
`getTokens` and `supportsHeadless`, the contract has:

- `capacity({ model })` → `{ state, scope, until, windows, message }`: whether a
  configuration can take work now. `state` is `available`, `unavailable` or
  `unknown`; `scope` is `account` (every model of the agent) or `model`;
  `until` is when an `unavailable` one may be tried again, or null; `windows`
  is `[{ name, remainingPercent, resetsAt }]`. It never throws: a failed read
  is `unknown` with the reason in `message`. Codex reads its quota over
  `codex app-server` (see `bl capacity`); Claude and Gemini answer the base
  `unknown` ("<agent> cannot report capacity").
- The headless result's `refusal`: `{ kind, scope, message, resetsAt }` or
  null (see the usage-limit paragraph under `bl run`). `kind` is a usage
  limit's (`session`, `weekly`, `spend`, `other`) or `capacity`.
- `supportsModel()`: whether `spawn({ model })` selects the model (Claude's
  `--model`, Codex's `-m`; Gemini no). The config loader refuses a
  configuration that names a model for an adapter that does not, and `bl run`
  moves a step to the second implementing configuration's model only on one
  that does.
- `supportsDeny()`: whether `spawn({ denied })` has a per-session refusal
  mechanism (Claude's `--disallowedTools`, Gemini's policy deny rules); `bl
review` prints the prompt-guidance note for one that does not (Codex).
- `syncNativeApprovals(patterns, config, opts)`: `bl allow` hands every
  agent the granted patterns; Codex installs them as prefix rules (see
  **Codex native approvals**), the others do nothing.

Nothing under `src/` outside `src/agents/` imports an adapter file or compares
a value to an agent name (`===`, `!==`, `case`); it asks the adapter.
`test/unit/agent-boundary.test.js` fails on either and names its one
exception, `bl.js`'s `case "claude":` (a verb alias for `bl agent`). Passing
a name as a literal (a default argument, a prompt variant) is allowed.

#### Tokens per step (S-904)

Each session's usage also goes into `tokens_by_step` on the unit's spec: a
mapping of `<step>[.<round>]` to the four kinds (`input`, `output`,
`cache_creation`, `cache_read`), written as strings like `tokens_*`.
`tokensStepKey(step, round)` (`tokens.js`, re-exported by `feature-run.js`)
gives the key: `implement`, `fix-tests`, `self-review`, `merge-resolve` as
they are; every review session of round _n_ (each dimension and the
verifier, whether `review`, `re-review` or `closing-review`) `review.<n>`;
`fix.<n>` and `fix-self-review.<n>` with the run state's `round`. Repeated
sessions of one key add up.

- **Headless** (`runSession` → `runner.session({ tokensStep })` →
  `runHeadlessSession({ usageStep })`): `accumulateTokensOnFile` adds the
  usage to `tokens_*`, `tokens_headless_*` and the map in one write, refusals
  for a usage limit and failed sessions included.
- **Interactive** (`bl implement S-n` / `F-n`, `bl run --interactive`):
  `launchSession({ tokensStep, tokensIndexPath })` reads the provider's
  transcript totals for the unit in that one worktree before and after the
  session and adds the difference (each kind clamped at 0) to the map and to
  `tokens_*` in one write with `accumulateStepTokensOnFile`, however the
  spawn ended (nonzero status, error result, throw), before the totals
  re-read. `bl implement`
  records under `implement`, or `fix.<review_round>` while a review is
  pending.
- A session with no usage writes no entry; a `bl` killed mid-session records
  nothing for it, so the map may sum to less than the totals, never more.
  The writers read CRLF files and leave a file with no `---` block alone.
  Every token writer of a spec (headless, interactive, the story and feature
  totals re-reads, which read the transcripts in the same hold) reads and
  writes it through `updateSpecFile` under `withSpecLock` (see **Spec
  writes**), so overlapping sessions never drop each other's entries and a
  failed write leaves the previous spec whole. Token bookkeeping stays
  best-effort: a writer that cannot take the lock or write returns false.
  `applyFeatureTokens` sums the transcript and `tokens_headless_*` totals as
  BigInt counts (`tokenCount`), so a total past 2^53 is never rounded.
  A transcript re-read with a kind that is not an exact count (an unsafe
  number) writes no totals (`addUsageTotals` returns false), so it never
  replaces stored usage with 0.
- `applyTokensToFrontmatter` (the overwrite `bl done` and the re-read use)
  never touches the map. `bl merge F-n` folds each story's map into the
  feature's key by key (`mergeStepTokens`), as it folds `tokens_*`, both
  only when the feature it re-reads under the backlog lock is not closed yet,
  so a second merge that loaded the feature earlier folds nothing again. The
  fold reads each story under its spec lock (`markFeatureMerged`, through
  `updateSpecFile`) and sums `tokens_*` as BigInt counts (`addTokenTotals`),
  so a total past 2^53 or 1e21 is written as its exact decimal string. The
  feature totals re-read (`recordFeatureTokens`) leaves a closed feature's
  totals alone, so it never replaces what the fold added.
- `bl status <id>` prints a `tokens:` line with the totals and one indented
  line per key (`feature-cmd.js` `tokensLines`); `bl report` and `bl retro`
  read the map through `report.js` `stepTokens`. `bl validate` checks it
  (`bad-tokens-by-step`).

The loop reads outcomes from files, never from the agent's prose: a story is
done when its `## Acceptance Criteria` section exists and every checkbox in it
is checked, whatever the list marker (`-`, `*`, `+`, `1.`); a story without
that section is never skipped as complete and never passes the
post-implement check; a review round ends with
whatever `review_status` the verifier wrote; an agent stops the run by writing
`## Escalation`. Machine-local run state lives under `<backlog>/.bl/run/`
(self-ignored by a `.gitignore` inside it). `run` refuses while `## Escalation`
has content. `--resume` skips completed stories; once the run has reached the
PR it also skips self-review, fixes a `pending` review session before
reviewing again, and ends at once when the review is already `addressed`.
One run per feature: `run` holds `.bl/run/<id>.lock` (created exclusively; a
dead holder's lock is reclaimed) and does not start while another live
process holds the unit directory's `.workon.lock` (F-60 D3). A headless step
never overwrites or removes a live session's `.workon.lock`.
The loop pushes the branch and checks that `origin/<branch>` contains HEAD
before every review pass and before it ends `clean`; a failed push, or a
forge that cannot open or find the PR, escalates. Having no forge configured
at all is the one way to finish without a PR.
Every verifier session must raise `review_round` by exactly one; anything
else (unchanged, lowered, not a number) escalates. A run that starts at the
round cap escalates at once instead of spending a round past it, whatever the
`review_status` (only a resumed run already signed off `addressed` ends clean
without a review) — raise the cap with `--max-rounds <n>`.

A session the agent refuses for a usage limit ("You've hit your session limit
· resets 3:45pm", "… weekly limit · resets Mon 12:00am", "… monthly spend
limit · … resets 6:10pm (America/Los_Angeles)") is not an attempt. Claude
Code's headless JSON has no field for it, so `parseLimit()` in
`src/agents/claude.js` reads the kind (`session`, `weekly`, `spend`, `other`)
and the reset time out of the `result` text. Codex's refusal ("You've hit
your usage limit. … or try again at Oct 15th, 2026 1:40 AM.") is the message
of its `turn.failed` (or `error`) event, which `parseCodexLimit()` in
`src/agents/codex.js` reads the same way: the kind is `other`, and the reset
is either a full date and time, taken as is, or a time alone, meaning its
next occurrence, both in this process's zone; "try again later" names no
reset time. Codex's capacity refusal ("Selected model is at capacity. Please
try a different model.", in the same events) is `parseCodexCapacity()`'s:
kind `capacity`, scope `model`, no reset time. The field reaches `runSession()`, the one place every headless
step goes through — the review dimension passes and the verifier included —
as the result's `refusal`, whose `scope` says how far it reaches: `model` for
Claude (its caps are per model), `account` for Codex (one quota for every
model). Only a session that ended in error counts as refused: one that
succeeded and merely quoted the message in its last line ran, and its result
stands.

Every headless step walks its role's list (F-64 D3, **Agent configurations**):
the review dimension passes and the verifier (`runSession({ role: "review" })`)
walk `review_agent`, every other step (implement, fix-tests, self-review, the
fix steps, the merge resolution) walks `agent`, each from the top:

1. A configuration on the run's out-list whose `until` has not passed is
   skipped, as is one whose adapter has no headless mode and, for the review
   role, one that implemented this run (**Review Cycle**, F-64 D4), each with a
   log line `<step>: skipping <agent> <model>: <why>`. An entry whose `until` has
   passed is dropped with a log line, so the run returns to the operator's
   first choice at the next step.
2. The runner's `capacity(agent, model)` (the adapter's `capacity({ model })`)
   is asked; an `account`-scoped answer is kept for the rest of the walk, so
   each agent is asked once. `unavailable` puts the configuration on the
   out-list (kind `quota`) until the reading's `until` plus the margin below.
   `available` and `unknown`, and a read that throws, spawn.
3. The spawn passes the configuration's `agent` and `model` (null: no model
   flag; `runHeadlessSession` adds no default of its own). A refusal puts it
   on the out-list until `resetsAt` plus a 60-second margin, or for the rest
   of the run with no reset time, and the walk moves on. Either way the move
   is an `unavailable` history event (`{ session, agent, model, kind, scope,
until, message }`) and one log line. Any other result is the step's: its
   history entry records `agent` and `model`.

An out-list entry with `scope: account` covers every configuration of its
agent, one with `scope: model` that configuration only. The out-list is the
run state's `unavailable` (`[{ agent, model, scope, kind, until, message }]`,
checked by `loadRunState`), so `--resume` and `bl review` do not spawn a
configuration refused an hour ago. An entry with no `until` holds only for the
bl process that wrote it: `--resume`, `bl review` and `bl merge`'s integration
drop it with a log line (`clearUntimedOut`), since its escalation asked the
operator to raise the limit and resume, and a resume that kept it out would
escalate again without spawning. A run state from before the walk may still
carry S-880's `model`; it loads and is ignored.

With the list exhausted and the earliest `until` inside
`run.limit_wait_max_hours` (`backlog.json`, hours, default 8), the loop records
a `waiting` event in the run history (`{ step: "waiting", until, note }`, saved
before the first sleep so a Ctrl-C leaves the run resumable at that step),
sleeps in slices of at most a second until it, and walks the list again from
the top, asking capacity afresh — so a refusal never spends a nudge retry, a
fix-tests rerun or a review round, and a refused spawn gets no step record of
its own. A step waits at most once: exhausted again, with no reset time on any
configuration (a spend cap, a capacity refusal), or with the earliest reset
past the cap, it escalates as `agent unavailable: <message>` (one
configuration) or `agent unavailable: every <role> configuration is out (<list>)`,
the details listing every configuration with its kind, message, scope and
reset time in local time, and the command to resume with (`bl run <id>
--resume`, or `bl review <id>` for a review pass). `bl status <id>` shows a
run that is waiting as `waiting until <local time> — <message>`, and each
out-list entry still in force as `out: <configuration> until <local time> —
<kind>: <message>`. An interactive run (`--interactive`, or a role with no
headless entry under `bl review` and `bl merge`) does not walk: each step
attaches to its role's first configuration (the review role's first one that
did not implement). `bl run` refuses at start when a role has no headless
entry.

### The repo guard

Each time the loop reaches the test gate (after the stories, after a self-review
that changed the tree, after each fix round), `repoGuard` (`feature-run.js`, F-52
D4, F-61 D1) first diffs every prepared worktree against main (`git diff --name-only -z
main...HEAD`, names exactly as git gives them), and also any worktree on the unit's branch in a registered repo the
run did not prepare (`git worktree list --porcelain -z` in each main checkout, `strayWorktrees`).
A repo with changes but no story of the unit gets one warning naming the repo and
its count of changed paths. A changed path outside the stories' components gets
none: `paths:` is a map, not a rule (F-61 Decision P1). Each warning is recorded once
per run in the history (`step: "repo-guard"`, `warning: true`). The guard only warns:
the run goes on to the gate, and `bl merge` refusing a stray repo is the hard stop.

### The test gate

The gate covers every repo the run prepared (S-1010): the run's own repo
(a feature's lead) first, then `prep.otherWorktrees` in the feature's repo
order (F-52 D3). Each repo's `test` stage
plugins are resolved with that repo's config (`configForRepo`, so its
`plugins-test` in `backlog.json` applies) and run in that repo's worktree, with
`{{worktreePath}}` set to it, one after another, stopping at the first that
fails. Before anything runs, every repo's plugins are checked (an unknown
name or an unresolved placeholder in any repo is `test gate misconfigured`),
then every worktree must be clean. A repo with no plugin is skipped by name;
the gate is `skipped` overall only when no repo has one. So every repo's
tests run before review, not first at its own push gate during `bl merge`.
Every attempt (pass, fail, or a dirty-worktree refusal) writes
its complete output to one file,
`<backlog>/.bl/run/<F-id>.test-<n>.log`, where `n` is the run state's
`testAttempts` counter, bumped and saved as each attempt starts, so `--resume`
never overwrites an earlier attempt's log. Each command's output follows a
`── <repo> · <plugin>: <command>` header line (`── <repo>: skipped (no test
plugin)` for a repo without one); a dirty-worktree refusal writes its
`git status` list under each dirty repo's name and path. The change
document's `## Gate` gets one line per repo the attempt reached:
`<date> · <repo> · <command> · <verdict>`. A failed result names the repo and
its worktree; the fix-tests session gets them as `{{testRepo}}` and
`{{testWorktree}}` and fixes and commits there (it still starts in the run's
own worktree). A plugin runs with stdout and stderr on one file
descriptor (`shellMerged()`), so its errors stay in the order it printed them.
The logs stay with the rest of `.bl/run/`; nothing prunes them.

A failed attempt reaches the fix-tests session and the escalation as three
views: the log path, a failure excerpt, and the last 30 lines. The excerpt
(`failureExcerpt()` in `test-excerpt.js`) is drawn from anywhere in the failing
plugin's output: every line matching one of `FAILURE_MARKERS` (Playwright's
`  1) [` failure headers, `Error:` / `<Name>Error:` lines, `CERT_HAS_EXPIRED`,
node:test `not ok` / `✖` / a non-zero `ℹ fail`, and the app runner's
`N passed, M failed` (M > 0) and `Failed:` summaries) with 2 lines of context,
overlapping ranges merged, `…` between the rest, capped at 80 lines keeping the
earliest. With no match it reads `(no failure markers matched — see the full
log)`. The tail alone is not enough: an app run ends with `stack.teardown.js`
noise, and on F-4 the error that mattered sat far above it. The fix-tests
prompt gets `{{testLogPath}}`, `{{testExcerpt}}` and `{{testTail}}`, and is told
to read the log rather than rerun the suite. A second failed attempt escalates
as `test gate failed twice` with the command, the log path, the excerpt and
the tail, in that order.

The fix-tests session ends with one of three lines. The last non-blank line is
the one that counts. Markdown emphasis around the keyword is ignored, a reason
is required, and a keyword on an earlier line does not count
(`unrelatedReason()` / `rerunReason()`).

- `FIXED`: the agent committed a fix, and the loop reruns the gate. A second
  failure escalates as `test gate failed twice`. Any ending the loop does not
  recognise is treated the same way.
- `RERUN: <what it tried>`: the failure would not reproduce after a real
  attempt. The loop reruns the gate. If that gate fails too, the failure is
  real, and one more fix-tests session gets it (`fixNote` says it reproduced)
  instead of escalating. `RERUN` is honoured once per gate. After that it
  counts as `FIXED`.
- `UNRELATED: <reason>`: nothing in the repos can make the gate pass. That
  means the stack runs other code than this worktree's, stray files the
  session cannot move, or infrastructure outside the repos is down. The loop
  does not rerun the gate. It escalates at once as `test gate failure is
environmental (fix-tests: UNRELATED)`, with the agent's reason followed by
  the first attempt's details. The line stays one line; the session writes
  its full explanation for the operator to `escalation.md` in its scratch
  directory (`ESCALATION_FILE`), and when that file has content it replaces
  the bare reason in `## Escalation`, followed by
  ``fix-tests ended `UNRELATED: <reason>` `` and the gate's details
  (`unrelatedDetails()`). The loop clears the file before every fix-tests
  session, so a sent-back session never inherits the previous one's. On F-4 an expired dev certificate was diagnosed
  correctly, and a rerun would have cost five minutes and replaced the reason
  with a second identical failure. After the operator fixes the environment,
  `--resume` starts at the gate, because the implemented stories are already
  complete.

A flaky failure is a bug to fix, not an environment problem. F-22 escalated a
page-load timeout with `UNRELATED` after it had failed 2 of its 4 gate runs.
So the first `UNRELATED` whose reason reads as flaky (`looksFlaky()`: flaky,
intermittent, timeout / timed out, "not caused by") does not escalate. The
loop sends the session back to fix-tests once, without rerunning the gate, and
`fixNote` (`flakyPushbackNote()`) tells the agent to fix the failure. The
refusal is recorded in the run history. A second `UNRELATED` escalates. With
both detours, one `testGateWithFix()` call runs at most three fix-tests
sessions and three gates.

### Blocked by a bug: ad-hoc stories

Every code-writing feature prompt carries the rule in
`prompts/_blocked-by-bug.md`: `feature-story`, `feature-self-review`,
`feature-fix-self-review`, `feature-workon-review`, `feature-fix-tests` and
`feature-workon`. `loadPrompt()` renders it into the `{{blockedByBug}}` slot
(`PROMPT_PARTIALS` in `session.js`) with the template's own variables; a story
run (`unitKind: "story"`) gets `_blocked-by-bug-story.md` instead
(`STORY_PARTIALS`), which records the fix as a dated line in the story's `## Notes`. The
rule says that an agent blocked by a real bug fixes it, even outside the
feature's scope, and keeps going:

1. Find the cause.
2. Record an ad-hoc story with
   `bl new {{featureId}} {{adhocComponent}} --type bug --points <n> --no-sync --title … --body-file <backlog>/.bl/run/<F-id>.adhoc-<slug>.md`,
   and set it `in_progress` with its criteria checked, so the loop's
   `storyComplete()` skips it and `bl merge` marks it done.
3. Fix the bug in a commit that touches only that bug.
4. Commit the story file and the feature file to the backlog.

`adhocComponent` comes from the feature's first story
(`prepareFeatureWorktree()`). `bl new` is covered by the `bl:*` baseline in
`allowed-tools.json`, and `--no-sync` keeps the session off the index files. If
`bl new` fails, the fallback is a task with the same body file,
`bl task <F-n> --title "Ad-hoc fix (done, <sha>): …" --gate none`, so the operator makes it
a story at merge. The rule allows escalation only for an
architectural problem, an unclear business rule, or a conflict with the
tenets. "Flaky" and "not caused by this branch" are not reasons to stop.

### Escalations for the operator

An escalation stops the loop until the operator decides, so it is written for
someone who has not read the code. Every prompt that can escalate carries
`prompts/_escalation.md` in its `{{escalationGuide}}` slot (`PROMPT_PARTIALS`):
`feature-story`, `feature-workon`, `feature-self-review`,
`feature-workon-review`, `feature-fix-self-review`, `feature-fix-tests` and
`review-verify`. The guide sets the shape, with these bold headings:

1. **The rule at stake:** one plain sentence.
2. **How it works:** a few numbered steps in plain words.
3. **The problem:** a concrete scenario, as a short timeline table with named
   people (Alice, Bob, Chad) when order or timing matters, and the bad result
   in one sentence.
4. **Why the agents can't fix it.**
5. **The decision:** lettered options, each with its cost and consequence, a
   recommendation, and the exact question for the operator.
6. **Details:** repros, test names, file paths, SHAs and review items, kept
   out of the explanation.

No unexplained jargon; a code identifier only when needed, explained in
passing; about one screen; one block per separate decision. Once the operator
decides, the outcome goes in the Review Log or the Design and `## Escalation`
goes back to exactly `None.`, never a "resolved" note. The guide ends with a
worked example. `feature-refine` does not carry the guide; it has its own rule
that a refine records operator decisions in the Design and leaves
`## Escalation` at `None.`.

Where the text comes from:

- Implement, self-review, review-fix, fix self-review and interactive workon
  sessions write `## Escalation` in the feature file themselves. The loop sees
  it (`escalationOpen()`) and `writeEscalation()` leaves it as written; its own
  reason (`agent escalated while …`) goes only into the commit message and the
  run state.
- The closing-round verifier (`review-verify`) writes `## Escalation` itself
  in the same shape: one block per decision, its code / design /
  test-infrastructure diagnosis under **Why the agents can't fix it**, and the
  open items under **Details**.
- fix-tests ends with a one-line `UNRELATED: <reason>`, so its explanation
  goes to `<scratch>/escalation.md`, which the loop copies in (see **The test
  gate**).
- Escalations the loop raises on its own (a gate that failed twice, a push or
  forge failure, a round-cap or verdict mismatch) are mechanical: a one-line
  reason and the raw details. When the latest Review Log session has open
  items, the details list each one whole as `- [ ] <claim>`: the item's lines
  joined, cut before its ` — Repro:` or `Class:` tail, rewrapped at 100
  columns (`openItemsSummary()`). The repro, test and class stay in the
  Review Log.

### Scratch directories

Headless agents cannot delete files, and the gate refuses a dirty worktree, so
every loop session that may need to diagnose something gets a
`{{scratchDir}}` outside the worktree, created before it starts:
`<backlog>/.bl/run/<F-id>.<slot>.scratch`.

| Session                                 | Slot                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| implement (`feature-story.md`)          | `<S-id>`, shared with that story's retry                               |
| fix-tests (`feature-fix-tests.md`)      | `fix-tests-<n>`, `n` the failed gate attempt (shared with a send-back) |
| review fix (`feature-workon-review.md`) | `r<round>.fix` (also for `bl implement` with a review pending)         |
| review passes                           | `r<round>.<dimension>`, `r<round>.verify`                              |

The prompts tell the agent to write probe scripts, redirected test output and
scratch configs there, never in the worktree, and none tells it to delete
files. A stray file fix-tests cannot move out ends the session with
`UNRELATED: stray files in the worktree: <paths>` for the operator.

### Worktree hygiene in the loop

Review passes are read-only by contract. Each one gets a `{{scratchDir}}` under
`.bl/run/` for probe scripts. Before every review-mode session the loop
snapshots each worktree the round covers (HEAD, `git status -z`, the bytes and
index entry of every changed path); afterwards it puts back only the paths
whose state differs from that snapshot, so an operator's uncommitted work under
`bl review` stays as it was. New files the session left move to
`.bl/run/F-<n>.quarantine/<timestamp>-<pass>/untracked/`, its tracked edits are
saved as `tracked.patch` and reverted, and commits it made are saved with
`git format-patch` and reset away. Each quarantine is a `hygiene:<pass>` entry
in the run history. If git cannot report a worktree's state, or the restore
does not bring it back to the snapshot, the round stops there (a run
escalates) rather than let the next pass inherit the debris. The test gate
itself refuses a dirty tree, and reads a failed `git status` as dirty: it lists
the stray paths and hands them to the fix-tests session to commit or delete, so
the gate only ever certifies committed code. bl's own `.workon.lock` and `.bl/`
are excluded from the check whether or not a repo ignores them.

### Defect classes

Every Must and Should item carries `Class: <defect class> — instances: <list>;
also check: <where>`. The review passes name the class and hunt its other
instances in the branch's diff; the verifier merges same-class findings into
one item; the fix round sweeps the whole class (the reviewer's list is where it
starts, not where it stops), usually as one shared check with a table-driven
test; the fix self-review confirms no instance remains; and a re-review that
finds another instance of the same class reports the resolution as not
holding. Instances in code the branch did not change go to `## Deferred`.

### Finding origin and test-container cleanup

Both review passes tag every finding `Origin: introduced` (in lines the branch
changed against main, or a pre-existing defect the branch newly makes
reachable) or `Origin: pre-existing`. The verifier checks the tags, puts only
`introduced` findings into the session, and writes `pre-existing` ones to the
feature's `## Deferred` list, so a round-cap escalation can only concern code
the feature introduced.

Around every headless session and every test-gate run, the loop lists
containers before and after and removes the new ones that carry no
`com.docker.compose.project` label: integration-test helpers such as
`minio-in-memory` that would otherwise hold the stack's ports. Compose stacks
(the dev stack, session stacks) and containers that already existed are never
touched. Each removal is a `hygiene:containers` history entry;
`BL_KEEP_TEST_CONTAINERS=1` turns the cleanup off. The snapshot is host-wide,
so a non-compose container started by anything else during the step (another
feature run's test gate, a manual `docker run`) is removed too; set the opt-out
when running loops side by side.

Processes get the same hygiene (F-70 D4, `src/process-scope.js`). Every
headless session `runSession` starts and every test-gate command runs in a user
systemd scope (`systemd-run --user --scope --collect`), named
`bl-<unit id, lowercased>-<bl pid>-<n>`. A scope's cgroup keeps every process
the step started, whatever it did with `setsid` or reparenting. After the step,
whether it succeeded, failed or threw, and before its containers are listed (a
hung test can hold a container), each of its scopes still running is stopped
with `systemctl --user stop`. What was in it (pid and command) goes into one
`hygiene:processes` history entry and one log line. A scope that is already
gone adds no entry; one whose processes cannot be listed is stopped anyway. If
a stop fails, or a scope is still active after it or systemctl cannot say, the
run escalates with the processes and the `systemctl --user stop <unit>.scope`
to run. At `bl run` start and `--resume`, `bl review` and `bl merge`'s
integration, the unit's scopes whose `bl` pid is dead (a crashed or killed
`bl`'s leftovers) are stopped and recorded the same way; when systemctl cannot
list them, the run escalates before the first step with the
`systemctl --user list-units` to run. Interactive sessions
are not scoped: the operator owns them. Without user systemd (macOS, a host or
guest whose probe `systemd-run --user --scope --quiet --collect true` fails,
`bl` inside a sandbox), steps run unscoped, the run records one
`hygiene:processes` entry (`ok: true`) saying process hygiene is unavailable and
why, and nothing is killed (decision D4-a: no fallback by working directory,
which could kill the operator's editor or dev server). A runner without the
scope methods (the unit tests' fake) skips the hygiene.

The fix self-review's diff starts at the commit the last review saw
(`reviewBaseSha` in the run state), or, when none is recorded (a session
written by hand or by a run whose state is gone), at the commit the fix
session started from.

### Adding stories to a feature

```bash
bl new F-3 C01 --title "Mint codes" --points 3                    # one story
bl new --from spec.json                                            # many at once
```

In a spec, `"feature": "F-3"` at the top level tags every story and appends
them to the feature in spec order; the top-level `"component": "C<nn>"` names
the stories' component, and `"component": "C<nn>"` on a story places it in
another component, in any repo: a story's repo is its component's.

### Review rules the feature prompts enforce

The feature review prompts carry four rules derived from this backlog's own
review history (see `docs/process-review-2026-09-24.md` in the backlog repo):
enumerate every input class of a flagged function and report all failing
siblings at once; execute with a second-shape or malformed input and give
every Must-fix a `Repro:` line; phrase items as invariants and name the test
that proves them; quarantine nits (`[safe]` only when no logic changes). On a
re-review the reviewer runs the named tests and checks only the files the
fixes touched — it does not re-sample the untouched diff. The implementing
prompt self-reviews the whole branch before opening the pull request.

Both the correctness pass (rule 8) and the self-review (item 5) also check
**placement**: when a change alters what something is or who uses it (a
domain-specific module made generic, a helper now shared across services),
code left in a package of its old role is a finding even when the diff never
touches the file. They read the repo's AGENTS.md package map, where it has
one, and its tenets.

## Review Cycle

PR review feedback is persisted in the unit's **change document**
(`change.md` beside its `index.md`), not in any worktree-side artifact
(S-458 retired `.pr-review.md`).

### `review_status` frontmatter field

The optional `review_status:` field of the change document tracks where the
implementation stands relative to the most recent PR review:

| Value       | Meaning                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| _omitted_   | Story has never been reviewed.                                                                                       |
| `pending`   | The reviewer wrote a session block; the implementing agent has items to address.                                     |
| `fixed`     | The implementing agent checked every item off — claimed resolved, awaiting re-review. Set by the implementing agent. |
| `addressed` | The reviewer verified the fixes (or the session was an audit-only "no issues" entry). Set **only** by `bl review`.   |

Lifecycle: `unset → pending → fixed → (addressed | pending → fixed → …)`.
The implementing agent may set `pending → fixed`; only a `bl review`
session promotes `fixed → addressed` (after verifying each resolution)
or knocks it back to `pending` with a new session.

**Review agent.** `bl review`, and the review step of `bl run`, run on
`backlog.json`'s `review_agent` list (see **Agent configurations**),
walked down when a configuration is out (F-64 D3, **Headless sessions**). `-A <agent>` on
`bl review` replaces that list with a one-entry list with no model; on
every other verb `-A` replaces the implementing list only.

**The reviewer is never the implementer** (F-64 D4). A `review_agent`
configuration equal to one that ran an implementing step of the run
(`implement`, `fix-tests`, `self-review`, `fix`, `fix-self-review`,
`merge-resolve`, read from the run history, which keeps `{ agent, model }`
on every agent step and survives `--resume` and `bl review`) is skipped
with the log line `<step>: skipping <configuration>: it ran <steps> in this
run, and the reviewer is never the implementer`. Equal means the same agent
and the same model; an absent model equals only an absent model, so
`claude` and `claude opus` differ. A review list exhausted this way
escalates as `agent unavailable` like any other, the details marking each
excluded entry `excluded — it ran <steps> in this run` and asking for a
`review_agent` configuration that did not implement; an implementer never
comes back, so the loop does not wait for one. `bl run` refuses at start
when every `review_agent` entry is also an `agent` entry, naming them.
`bl init` therefore scaffolds the review list with another headless agent
(`claude` implements, `codex` reviews). A different model of the same
vendor is a weaker second opinion than a different vendor, and a far better
one than none.

Each round records who reviewed it: every pass's and the verifier's history
entry carries its `agent` and `model`, and the round ends with a
`review:round` entry (`{ round, reviewers: [{ session, agent, model }],
note: "round <n> reviewed by <configurations>" }`) that `bl status <id>`
prints for the latest round. The verifier gets the distinct configurations
of the round, its own last, as `{{reviewers}}` and writes them into the
Review Log session header (`### `## Review Log` section`), so the
independence of every sign-off is on record in the change document.

Caveat: an agent whose
adapter has no per-session deny mechanism (`supportsDeny()` false: codex)
enforces the review-mode hard denials (`gh pr merge`, `git push`) by
prompt guidance only; `bl review` prints a note to that effect.

**Agent configurations.** A configuration is `{ agent, model }`: a
registered agent and, optionally, the model it runs. `backlog.json`'s
`agent` (the implementing role: implement, fix-tests, self-review, and the
interactive `bl implement`, `bl refine`, `bl init`, `bl allow`, `bl agent`)
and `review_agent` (the review role) are each a required, non-empty list
of them in priority order (F-64 D2):

```json
{
  "agent": [
    { "agent": "claude", "model": "opus" },
    { "agent": "claude", "model": "sonnet" }
  ],
  "review_agent": [
    { "agent": "codex", "model": "gpt-6-sol" },
    { "agent": "claude", "model": "sonnet" }
  ]
}
```

Neither key has a default. An entry's `agent` must be a registered
provider, `model` a non-empty string, named only for an adapter that
selects models (`supportsModel()`), and no entry may appear twice in one
list; anything else is a config error naming the entry. A model is passed
as Claude's `--model` (interactive, headless and `--resume` alike; it
outranks an `ANTHROPIC_MODEL` in the environment) or Codex's `-m`
(`codex exec`, the interactive launch and `resume`). With no `model`, no
model flag is passed and the agent CLI uses the account's model; bl
supplies none of its own, and one configuration's model never reaches
another agent. Use aliases (`opus`, `sonnet`) so the config follows new
releases. A repo's `overrides` may replace either list whole. The config
record carries both lists (`agents`, `reviewAgents`) and their first
entries (`agent`, `agentModel`, `reviewAgent`, `reviewAgentModel`) for
the callers that do not walk a list.

The pre-F-64 shape, a string `agent` or `review_agent`, or an
`agent_model` or `fallback_model` key (top level or a repo's `overrides`),
is a config error naming the list shape and
`scripts/migrate-agent-configurations.js <backlog.json>`, which rewrites
it (`agent` + `agent_model` the first entry, `fallback_model` the second, a
string `review_agent` a one-entry list); nothing migrates silently.
`bl validate` loads the file leniently and reports the same error as an
`agent-config` finding. `bl init` gives a new backlog (one with no
`repos`) both lists: `agent` `[{ "agent": "<-A, else claude>" }]` and
`review_agent` the first other registered agent with a headless mode
(**Review agent**: the reviewer is never the implementer). A role the file
already has is kept, and the missing one is picked against it
(`initConfigurationLists`): a headless agent the kept list (and -A) does
not use, so a kept `[codex]` implementer gets a `claude` reviewer.

Gates and effects:

- `bl implement` reads `review_status`. When it's `pending`, the
  implementing agent is launched with the `workon-review` prompt and an
  info line `Review pending in story — using review-feedback prompt.`;
  otherwise the standard `workon` prompt is used.
- `bl done` refuses while `review_status` is `pending` or `fixed`, and
  also while the latest `## Review Log` session has unchecked items
  regardless of the frontmatter value. It prints the story ID, latest
  session date, and unchecked-item count, then exits non-zero. `bl merge`
  applies the feature's rule to both kinds (F-36 D1): `pending`/`fixed`
  or an unchecked Must or Should box blocks, an open nit does not, and a
  unit with no session is refused unless `--no-review` (see `### bl merge`).
  `--force` is intentionally absent; if you need to bypass, edit the
  change document manually.
- `bl implement` (story or feature) ends with
  `Next: bl review <id>, then bl merge <id>.` when its session exits 0.
- `bl merge` runs one more round when its resolution agent resolved a
  merge with main (F-36 D7): the same dimension passes and verifier, with
  `{{reviewScope}}` narrowed to the resolution (`git show --remerge-diff` of
  each merge plus the commits after it) and `{{changedFiles}}` to the files
  it resolved or changed after. It writes a Review Log session and advances
  `review_round` like any round, but is not counted against
  `review_rounds_max`: the cap bounds the fix loop, and integration has none.
  `pending` leaves the resolution on the branch for `bl run --resume`.
- `bl review` resets `review_status` back to `pending` whenever it
  appends a new session that contains items; on a re-review of a
  `fixed` story it verifies each claimed resolution and either promotes
  to `addressed` or writes a new `pending` session.
- `bl validate` enforces two integrity rules:
  `review-log-missing` (`pending`/`fixed` but no `## Review Log`
  session) and `review-log-unaddressed` (`fixed`/`addressed` but the
  latest session still has unchecked items).

### `## Review Log` section

The change document holds the `## Review Log` section. The reviewing
agent **prepends** a new session block on each `bl review` cycle, so the
latest session is always the first `### Session` under the heading.
Earlier sessions are preserved untouched as the audit trail.

A session block looks like this. Its header names the PR and, after
`reviewed by`, each distinct configuration that reviewed the round (the
dimension passes and the verifier, F-64 D4):

```markdown
### Session 2026-05-11 (PR #142; reviewed by codex gpt-6-sol, claude sonnet)

**Must fix**

- [x] `parseConfig` swallows errors on malformed YAML
      → fixed in 3a1f9bc — now throws `ConfigError`
- [ ] Race in retry loop on 503 — second request fires before backoff

**Should fix**

- [x] Extract retry helper from inline code
      → done in 7d2e4aa

**Nits**
None.
```

Rules:

- Newest session at the top. Never collapse or delete earlier sessions.
- Three category subheadings — **Must fix**, **Should fix**, **Nits** —
  always present. Empty categories render as the literal word `None.` on
  the line below the bold subheading, not as an empty bullet list.
- Items are checkbox bullets. The implementing agent flips `- [ ]` →
  `- [x]` in place and appends a short `→ <resolution>` note (typically
  a commit SHA and a few words; for deferred items, a deferral reason).
- The implementing agent makes **one commit** to the backlog repo per
  review session, after the final item is checked and `review_status` is
  set to `fixed`. Commit message:
  `chore: address review feedback ({{storyId}}, session <YYYY-MM-DD>)`.

### `## Deferred`, `## Notes` and tasks

A session leaves behind three different things, and each has its own place (F-65 D4):

- **Follow-up code work** goes in a feature's `## Deferred` or a story's `## To Do`, one
  top-level bullet each, starting with its estimate `[points: N]` (Fibonacci). Nothing else
  goes there. `## To Do` is the **cleanup agent's intake** (`prompts/cleanup-triage.md` turns
  each item into a story at the story's merge, orders dependent items with
  `bl new --depends-on` and groups overlapping ones as a feature, and `todoForTriage` hands it
  the whole section); a feature's `## Deferred` is reviewed once, at merge. It is **not** a catch-all
  for anything out of scope: the working agent does uncovered work itself, and only work that
  is a loose estimate of **8 points or more** belongs here. A finding of about one point in
  code the branch already touches is fixed in the session, and a nit is fixed or dropped,
  never deferred (the implementing and fixing prompts say so, folded in from S-638).
- **Records and hand-offs** (what a session did or found, a note from one story to the next)
  go under `## Notes`: in a feature between `## Deferred` and `## Escalation`
  (`templates/feature.md`), in a standalone story after `## To Do` (`templates/story.md`). A
  story in a feature has no section of its own: its hand-offs go to the feature's. A note is
  a dated, attributed bullet, `- 2026-10-26 (S-1066): …`, with no marker; bl never reads the
  section.
- **Anything the operator must do** is a task, filed with `bl task <unit> --title <t> --gate
<merge|next|none> [--body-file <path>]` (see **`bl task`**): `merge` holds the unit's merge,
  `next` holds every run once the unit is done (a shared-service restart after the merge),
  `none` holds nothing (a fact or warning to see once).

`bl validate` checks the section on a unit that is not `done` or `superseded`
(`findDeferredErrors` in `src/validate.js`, reading the section as mdast through
`scanDeferred` in `src/deferred.js`), one error per line:

- `deferred-unsized`: a top-level bullet without a numeric `[points: N]` (a `[points: -]`
  note, a bare bullet, `[points: ?]`).
- `operator-tasks-retired`: a `### Operator tasks` sub-heading (the items under it are not
  reported again) or an `operator:` / `operator (from S-<n>):` bullet.

A closed unit's section is history: its notes and done operator items stay as written, and
neither rule runs on it.

### `## Review Log` vs `## To Do`

`## Review Log` is the **review cycle's** state — items in the latest
session must be checked off with a resolution note and then verified by
a re-review (`review_status: addressed`) before `bl done` or
`bl merge` will accept the story.

Do not mix the two. A review item that should become its own story is
written into `## To Do`, not into a session block.

## Tooling

All backlog operations use the `bl` CLI (or equivalent agent skills).
Run `bl --help` for the full command list, or `bl <command> --help` for details.

To target a different repo, use `--repo` as the first argument:

```bash
bl --repo ../other-repo <command> [args...]
```

Subcommands share one argument parser (`parseArgs` in `src/config.js`). A value given as the
next token may not begin with `-` (a lone `-` is fine), for long and short flags alike:
`--title -m msg` leaves `--title` without a value (the subcommand reports `requires a value`)
and parses `-m msg` as its own option. A value that starts with `-` goes inline:
`--title=-draft`, `--points=-1`. `bl sync` has its own parser with the same rule; `bl fix` has
its own too and refuses any following `-` token, a lone `-` included.

### `bl new`

Creates a new story in `stories/S<n>-<slug>/` (or, with `--component` and no C-id, a component
in `components/C<n>-<slug>/`; with `--theme <slug>` on its own, a theme in `themes/<slug>/`;
with `--epic --theme <slug>`, an epic in `epics/E<n>-<slug>/`) with the correct next ID,
today's `added` date, and a scaffolded `index.md`. Always use this instead of creating story,
component, theme or epic files manually.

Parallel `bl new` calls are safe — a lockfile serializes ID assignment.

```bash
bl new C00 --title "My Story" --points 3
bl new --repo bl --title "Small fix" --points 1          # bl's home component
bl new C00 --title "Follow-up" --points 2 --plugins-from S-866
bl new --component --repo bl --title "bl sync" --paths "src/sync.js,test/**/sync*"  # a new component
bl new --theme backlog --title Backlog                   # a new theme
bl new --epic --theme backlog --title "Backlog taxonomy" # a new epic, E50 upward
bl new --feature --title "Taxonomy" --theme backlog --epic E62   # a feature in both
```

A story names its component (`C<nn>`, positionally or with `--component`); its repo is the
component's `repo` (F-49 D4), and `bl new` writes no `primary_repo` on it (F-52 D1).
With no component, `bl new` takes the `--plugins-from` story's, else the home component of
`--repo`, else prompts on a terminal. A `--repo` that is not the component's repo is an error.
An old component's id (E00–E49) is refused with the hint that components are C-ids; an
`E50`-upward id where a component is meant is a plain invalid component id. `--epic-title` is
gone; `--epic` names an epic (see **Themes and Epics**).

`--plugins-from S-<n>` copies the `plugins` / `plugins-<stage>` frontmatter keys (for example
`plugins-test: [bl-tests]`) of story S-<n> into the new story when both have the same repo
(their components'). With no component named, the new story takes S-<n>'s component, so the keys are
copied; a component in another repo copies nothing and warns on stderr. An unknown id fails
before anything is written. Nothing is inherited unless the caller names a source: one repo's
components may use different test plugins, so there is no default. `bl merge` triage passes
`--plugins-from <merged story>` on every `bl new` so follow-ups keep the parent's component and
test gate, and names another component only for an item that belongs elsewhere.

The body of a story can be supplied from a file:

```bash
bl new --print-template story > /tmp/s.md
$EDITOR /tmp/s.md          # fill in the sections, leave {{storyId}} etc.
bl new C00 --title "My Story" --points 3 --body-file /tmp/s.md
```

`--print-template story` (or `story-feature`, `component`, `feature`, `change`, `theme`, `epic`) writes the raw template to stdout — fill
it in, leave `{{storyId}}`/`{{title}}` etc. as placeholders, and `bl`
substitutes them on ingest. HTML comments outside fenced code blocks are
stripped automatically. Use `--body-file -` to read from stdin (in stdin
mode `--title`, `--points`, and a component or `--repo` must be passed on the command line).

#### `--json` output

Pass `--json` to get a machine-readable description of the created story.
A single JSON object is written to stdout (schema string `bl-new-json/v3`)
and all other output (sync output, plugin output, "Created story" lines)
is routed to stderr.

```bash
bl new --json C10 --title "My Story" --points 1
# → {"schema":"bl-new-json/v3","id":"S-99","path":"stories/S99-my-story/index.md",
#    "component":"C10","primary_repo":"app.acme.com","feature":null}
```

Schema (v3; v2 also had `project`, and v1 an `epic` object in place of `component`):

| Field          | Type           | Notes                                                 |
| -------------- | -------------- | ----------------------------------------------------- |
| `schema`       | string         | Always `bl-new-json/v3`. Bumped on a breaking change  |
| `id`           | string         | Story ID, e.g. `S-99`                                 |
| `path`         | string         | Story `index.md` path relative to backlog root        |
| `component`    | string         | Component ID, e.g. `C10`                              |
| `primary_repo` | string         | The story's repo, its component's (not written on it) |
| `feature`      | string or null | The feature the story was added to                    |

`bl new --component --json` writes `{"schema":"bl-new-component-json/v1","id","path","repo","home","paths"}`.
`bl new --theme --json` writes `{"schema":"bl-new-theme-json/v1","id","path"}`, and
`bl new --epic --json` `{"schema":"bl-new-epic-json/v1","theme","id","path"}`.

On error (e.g. missing `--title`), `bl new --json` exits non-zero with a
human-readable error on stderr; stdout is empty (no partial JSON).

#### `--from <spec.json>` (batch mode)

Create N stories (and optionally a new component) in one call from a JSON spec. Use this when a
planning session has produced a coherent set of stories that should land
together — the spec becomes a reviewable artifact and IDs are assigned
atomically.

```bash
bl new --from plan.json
bl new --from plan.json --dry-run          # validate + print plan, no writes
bl new --from plan.json --dry-run --json   # machine-readable plan
```

Schema: see `bl/templates/spec.schema.md`. Two sample specs to crib from:
`bl/templates/spec.example.json` (new component) and
`bl/templates/spec.example.existing-component.json` (existing component, with
both `required_for` and a mixed `depends_on` list, and a per-story component).

Highlights:

- `"component": "C<nn>"` names an existing component; an object
  `{ "repo", "title", "paths", "body_file" }` creates one (`paths` an optional array of globs; left out, the component has no `paths:` key). A story's own `"component"`
  overrides it, and every story's repo is its component's repo.
  An `"epic"` block is refused.
- `stories[].id` is a **placeholder** name (e.g. `bootstrap`), not a real ID.
- Cross-refs in `depends_on` / `required_for` use `@<placeholder>` for
  siblings in the spec, or bare `S-<n>` for already-existing stories.
- `body_file` paths resolve against the spec file's directory. Body files
  must not contain frontmatter.
- Validation errors exit **2** with messages keyed by spec path
  (`stories[2].depends_on[0]: unknown placeholder '@foo'`); IO/system
  errors exit 1.
- `--from` rejects single-story flags (`--title`, `--component`, `--body-file`,
  etc.) — the spec is the source of truth.
- Atomic: every file is staged in `<backlogRoot>/.bl-new-<pid>/` and
  `renameSync`'d into place at the end. On any error mid-write nothing
  partial remains.
- JSON output schema is `bl-new-batch-json/v2` (a `component` object in
  place of v1's `epic`, and each story's `component`).

### `bl side`

A change to another repo, as a story with its worktree (F-48 D1):

```bash
bl side <repo|C-id> --from <F-n|S-n> --title <t> --points <n> [--type chore|bug|feature] [--body-file <p>] [--json]
```

- **Component.** A C-id is used as given; a repo name takes that repo's home
  component (`homeComponent`), as `bl new --repo` does. An unknown repo or
  component, or a component with no `repo`, exits 1 naming it.
- **`--from` is required**: the unit the session is working on. There is no
  "current unit". The story records it as `found_by:` (F-48 D2).
- **Attach rule.** The story joins a feature when `--from` is a feature in
  `FEATURE_WORKABLE_STATUSES` (`approved`, `running`, `escalated`) or a story
  of one: `feature:` is set, it is appended to the feature's `stories:`, its
  worktree is on the feature's branch (`prepareFeatureRepo`, prepared before
  the story is written) and the feature's change document gets the repo, in
  `featureRepoOrder`. Otherwise (a draft or refined feature, a standalone
  story) it is a standalone story on its own branch (`prepareStoryRepo`) with
  its own `change.md`. Neither switches a main checkout.
- **Creation.** The story is written by `bl new [<F-n>] <C-id> … --no-sync
--json`, run as a child, so story creation keeps one implementation; `bl
side` then sets `status: in_progress` and `found_by:` through
  `serializeFrontmatter`. `--type` defaults to `chore`; the `--body-file`
  text (stdin for `-`) is read and checked by `bl side` first, then given to
  `bl new` on its stdin.
- **Commit.** One hold of the backlog lock covers `bl new`, the marks, the
  change document and one `syncAndCommit` of the story directory, the
  feature file (attached) and the change document, plus the indexes the sync
  regenerated: `chore: add S-<n> (bl side, found by <id>)`. The `bl new`
  child works under the parent's lock (`BL_LOCK_HOLDER`, `lock.js`), so no
  other bl commits a half-made story.
- **No dependency edge** to the `--from` story: `outsideBlockers` would then
  refuse `bl run <from> --resume` until the side story merged. If the source
  cannot merge without the side change, that is an escalation.
- Every refusal (no target, unknown repo or component, missing or unknown
  `--from`, missing `--title` or `--points`, a bad `--points` or `--type`, a
  `--body-file` that cannot be read or carries frontmatter, and a new
  worktree's guards: uncommitted changes or an unpushed local `main` in the
  repo's main checkout, `newWorktreeGuards`) exits 1 before anything is
  written.
- **Failures** leave the whole unit or none of it. Before the commit, a
  failing step (the bootstrap of an attached worktree, `bl new`, the marks,
  the change document, the sync) undoes only what this run made: a worktree
  or branch it created, and backlog files no commit holds, every index the
  sync rewrote put back as it was when the lock was taken (earlier uncommitted
  edits included); a story some commit already holds is left as it is, and an
  undo that fails says what it left. A worktree it created stays when a
  committed story of the feature is in its repo (a concurrent `bl side` took
  it up), when it has changes in it, or when its branch has commits `main`
  lacks; a `bl side` whose prepared worktree went while it waited for the lock
  stops before writing anything. A failed
  commit leaves the written files for a commit by hand. A standalone story's
  branch is named after it, so its worktree comes after the commit; when that
  fails (the bootstrap), the committed story stays and the message says
  `bl implement S-<n>` prepares the worktree, not another `bl side`.
- A change across N repos is N `bl side` calls with the same `--from`, then
  `bl run S-a S-b …` and `bl merge S-a S-b …`.

### `bl attach`

List an existing story in a feature (S-1095, `src/attach.js`):

```bash
bl attach <S-n> <F-n> [--no-sync] [--json]
```

- **Membership.** The feature's `stories:` list is where membership is
  decided (`bl run` orders from it, `bl sync` sums its points, `bl merge`
  marks exactly its stories done); the story's `feature:` points back.
  `bl attach` sets `feature:` (an empty key filled in place, a missing one
  last) and appends the id to `stories:` through `appendStoriesToFeature`
  (`src/feature.js`), the writes `bl new F-<n>` makes for a story it creates.
  It does not change `status:`, `found_by:` or the story's sections.
- **Ids** in either order, in any form `normalizeId` / `normalizeFeatureId`
  accept; anything other than one of each exits 1.
- **Half-attached** stories get the missing half only: one that names the
  feature but is not listed, or is listed with no `feature:`. A story with
  both is a no-op: exit 0, nothing written or committed, stderr says so,
  `--json` says `changed: false`.
- **Refusals** (exit 1, nothing written), checked under the backlog lock on
  the files as they are then: a missing story or feature; a feature file
  whose `feature_id:` is not its directory's feature; a story whose
  component names no repo, or is absent or unknown (`storyRepoOrExit`, in
  every feature status); a `done` or
  `superseded` feature (`closedFeatureRefusal`, as `bl new F-<n>`); a story
  whose `feature:` names another feature, or that is not `backlog` or
  `refined` (`storyMoveRefusal`, as `bl new --feature … S-<n>`: an
  `in_progress` story is someone's work in flight, and this feature's merge
  would mark it done; a half-attached story is the feature's already and
  skips the status rule); and, for a `running` or `escalated` feature, a
  story whose component's repo is not in `reposForFeature`. Only those have
  branches and worktrees, so before the feature runs a story in a new repo
  simply joins it. The message names `bl side <repo> --from F-<n>` as the way
  to bring a repo in; attach prepares no worktree and stays a backlog edit.
- **Commit.** `syncAndCommit` of the story directory and the feature's
  `index.md`, plus the regenerated indexes: `chore: attach S-<n> to F-<n>`.
  `--no-sync` writes the two files under the lock and commits nothing, as
  `bl new --no-sync` does.
- **Failure.** Attach creates nothing, so there is no repair record
  (`feature-links.js`): when the feature write fails after the story was
  written, the story's bytes from before are written back and the command
  exits 1 naming the failure. `BL_INTERNAL_TEST_FAIL_ON_LINK=list` reaches it.
  Every write, the restore too, goes through `atomicWriteFile`, so a write
  that fails part way leaves its file whole.
- **In the blocked-by-bug prompt** (`prompts/_blocked-by-bug.md`), an agent
  whose bug already has a story runs `bl attach S-<id> <F-n> --no-sync` in
  place of `bl new`. A repo outside the feature goes through `bl side`
  (naming the existing story); any other refusal or failure leaves the bug
  fixed and recorded as an operator task (`bl task … --gate none`), never a
  second story. None of attach's refusals is an escalation.

### `bl move`

Move backlog stories to another component (F-61 D5, `src/move.js`):

```bash
bl move <S-n>… <C-n> [--no-sync] [--json]
```

- **What moves.** A story's component is its `component:` key, and its one
  repo is that component's (F-52 D1), so re-homing a mis-filed story is that
  key and nothing else. `bl move` rewrites it through `updateSpecFile` for
  every story named; the story's status, feature and sections stay. A move to
  a component in another repo moves the story to that repo, which is allowed
  for any story nothing has branched.
- **Ids** in any order, in any form `normalizeId` / `normalizeComponentId`
  accept: exactly one component and at least one story (a repeat counts
  once); anything else exits 1.
- **Unchanged.** A story already in the component is left alone, whatever
  its status, and stderr says so. With every story unchanged nothing is
  written or committed.
- **Refusals** (exit 1, nothing written, every offending story listed),
  checked under the backlog lock on the files as they are then, before any
  write: an unknown component, or one that names no repo; an unknown story;
  a story that is not `backlog` or `refined` (an `in_progress` story has a
  worktree in its current repo); and a story whose repo would change while
  a feature it is in is `running` or `escalated` (that feature's branches
  span a fixed set of repos, as `bl attach` refuses a story in another
  repo). A story is in the feature its `feature:` names and in every feature
  whose `stories:` lists it, so a missing or broken backlink does not let it
  leave its repo. A move within the repo is fine there. A story whose
  component is unknown is moved, not refused: `bl move` is how it is fixed.
- **Commit.** `syncAndCommit` of the moved stories' directories, plus the
  regenerated indexes (the old and the new component's tables):
  `chore: move S-<a>, S-<b> to C<n>`. `--no-sync` writes the stories under
  the lock and commits nothing.
- **Failure.** When a write fails, the stories written before it get their
  `component:` from before the move back through `updateSpecFile`, read
  under the spec lock, so what another writer saved since (a token total, a
  status, the body) stays, and the command exits 1 naming the failed story
  and what was restored (or, when a restore fails too, which stories to set
  back by hand).
  `BL_INTERNAL_TEST_FAIL_ON_LINK=<S-n>` fails that story's write.
- **`--json`** prints `{ schema: "bl-move-json/v1", component, moved,
unchanged }`: the canonical component id and the story ids of each kind.

### `bl task`

A task is an action with an owner and no branch (F-65 D1, `src/task.js`): run a migration
between the run and the merge, re-mint a key, reinstall something on every machine. It is not
a story: no repo, branch, change document, points or review.

```bash
bl task F-53 --gate merge --title "Run the tasks migration" --body-file b.md  # → T-7
bl task F-54 --gate next --title "Re-mint the key" --body-file - --json      # body on stdin
bl task F-50 --gate none --title "Check the runner after 2026-10-28"         # a reminder
bl task list [--open] [F-53]     # T-7  F-53  open  Run the tasks migration
bl task done T-7 "ran it, 13 tasks filed"                                     # operator only
```

- **The file.** `tasks/T<n>-<slug>.md`, one flat file per task, never moved. YAML frontmatter
  (`parseFrontmatter` / `serializeFrontmatter`), keys in this order: `task_id` (`T-<n>`),
  `title`, `unit` (the `F-<n>` or `S-<n>` it belongs to), `owner` (`operator`, the only one so
  far), `status` (`open` or `done`, `flow.json`'s `task` type), `added`, and at done `done`
  (the date) and `note` (what was done, or why it is moot). No `points`, no `gate`. The body
  starts `# T-<n> · <title>` and holds the task: what to do, the exact commands as pasteable
  blocks with their expected output, and why it is a task and not code.
- **Ids** come from a global counter like stories': one past the highest `T<n>` file or
  `task_id` (`bl next-id task`). `bl task` takes the next one under the backlog lock, so two
  calls in a row get consecutive ids.
- **`bl task <F-n|S-n> --title <t> --gate <merge|next|none> [--body-file <path>|-] [--json]`**
  checks the unit exists, takes the backlog lock, writes the file (`status: open`,
  `owner: operator`, `added: <today>`), then the task's edge in `blockers.json` (below), runs
  `bl sync` and commits the task file, `blockers.json` (with `.gitattributes` while HEAD lacks
  the merge driver's line) and what the sync rewrote (the unit's file, for its `## Tasks`
  table) in one commit: `chore: task T-<n> (<unit>)`. stdout is `T-<n>`; `--json` prints
  `{ schema: "bl-task-json/v1", id, path, unit, edges }`. An unknown unit, a missing `--title`,
  a missing `--gate` or one outside the three, an unreadable body file or one with frontmatter
  is one `bl task: <reason>` line on stderr and exit 1, with nothing written. A failure before
  the commit puts the files back.
- **`--gate`** is a shorthand for the task's edge (F-65 D2), the one `bl block add` would file
  and checked the same way (`writeEdge` in `src/block.js`, which `bl block add` shares:
  `edgeProblems`, a duplicate, `wouldCycle`, the merge driver readied first). The holds are
  F-66's checks (`mergeGates`, `dispatch`); `bl task` adds none.

  - `merge`: `{ blocker: T-<n>, gate: merge, unit: <unit>, until: done }`. `bl merge <unit>`
    refuses until `bl task done`: a step between the run and the merge (F-53's migration).
  - `next`: `{ blocker: T-<n>, gate: run, unit: "*", until: done, active_when: … }` with
    `active_when: { unit: <unit>, status: done }`. Nothing while the unit is open; once it is done, `bl run` and
    `bl implement` of every unit refuse until `bl task done`. The `task` type has no gates, so
    the wildcard never holds a task and is no `blockers-cycle`.
  - `none`: no edge. Listed in the inbox, holds nothing: a dated reminder, or a fact the
    operator must see once; `bl task done` is the acknowledgement.

  An edge `writeEdge` refuses is `bl block add`'s reason on a `bl task: <reason>` line, exit 1,
  with the task file removed and nothing committed. Any other hold (on another unit, at another
  gate) is `bl block add T-<n> …`. There is no override flag: `bl task done` with a note saying
  what was done, or why the hold is moot, is the record.

- **`bl task done <T-n> [note]`** sets `status: done`, `done: <today>` and `note:`, syncs and
  commits `chore: task T-<n> done[: <note>]`; a task already done refuses. Its edges stay in
  `blockers.json`, met. It is the operator's: `MODE_DENY` in `src/allowed-tools.js` denies
  `bl task done:*` in every mode (generator v15), beside `bl block remove:*`, since closing a
  task lifts the holds its edges make. `bl task` and `bl task list` stay allowed through `bl:*`.
- **`bl task list [--open] [<F-n|S-n>]`** prints one line per task,
  `T-<n>  <unit>  <status>[ <done date>]  <title>`, in id order.
- **A unit lists no tasks.** `bl sync` writes a `## Tasks` table (ID, Title, Holds, Status,
  Done) into a unit's file from the task files' `unit:`, after `## Stories` in a feature and
  after `## Dependencies` in a story, only when the unit has a task; a unit with none is left
  byte for byte. Holds names each edge the task is the blocker of in `blockers.json` by its
  gate's verbs (`holdsText`): `bl merge F-3`, `bl run, bl implement (every unit) once F-54 is
done`; `none` when it has none. A `bl block add T-<n> …` shows there at the next sync.
- **A task is a unit in the graph** (`unitIndex`): it can be the `blocker` of an edge or its
  `active_when` unit (`bl block add T-7 --gate merge --unit F-53 --until done`). Its type has
  no gates, so an edge whose `unit` is a task is `blockers-gate`.
- `bl task` and `bl task done` pull the backlog first (`commandPullsBacklog`); `bl task list`
  does not.
- `bl validate` checks the files: `task-unit` and `task-field` (see **`bl validate`**).

### `bl next-id`

Print the next available story, component, epic or task ID(s) to stdout. Pure
query — no reservation, no lockfile. Concurrent callers may receive the same
answer; the reservation points are `bl new` and `bl task`, which hold the
backlog lock during ID assignment.

Story, component, epic and task IDs are globally unique across the backlog repo.
Epics are numbered from E50 (E00–E49 were components).

```bash
bl next-id story                 # → S-391
bl next-id component             # → C52
bl next-id story --count 3       # → S-391\nS-392\nS-393
bl next-id component --count 3   # → C52\nC53\nC54
bl next-id epic                  # → E69
bl next-id task                  # → T-14
```

`--count` defaults to 1 and must be a positive integer ≤ 1000. The first
positional argument must be exactly `story`, `component`, `epic` or `task`. `bl next-id` does
not append to the activity log.

### `bl refine`

Launches an agent session **on main** to refine and plan a story:

- Explores the codebase to understand scope
- Refines acceptance criteria and resolves ambiguities
- Creates a detailed execution plan with concrete steps
- Can create child stories via `bl new` if the story should be split
- Sets `status: refined` — does NOT commit (user reviews first)

```bash
bl refine S34
bl refine -t S34              # detach into a new tmux window
```

### `bl implement`

Requires `status: refined` or `status: in_progress`. Creates a git worktree and launches
an agent session to implement the story. Refused while an unmet `blockers.json` edge holds the
story at its `run` gate (F-66 D3; see "The gate checks" above), naming each blocker.

```bash
bl implement S34
```

### `bl run` for a story

`bl run S34` takes a `refined` or `in_progress` story with no `feature:`
through the feature loop (`runFeature` in `feature-run.js`), nothing copied:
`storyUnit` (`unit.js`) gives the story the field names the loop reads from
a feature, with `kind: "story"` and `deferredHeading: "To Do"`, and
`prepareStoryRun` (`workon.js`) makes the story's own worktree and branch (its
directory name, lower case) and returns `prepareFeatureWorktree`'s shape with
`ordered: [story]` and the PR title `S34: <title>`. The implement step uses
`prompts/story-run.md`; the gate, self-review, review passes, verifier and
fix rounds use the feature prompts, which read `{{unitKind}}`,
`{{deferredHeading}}` and `{{premise}}`. The test gate layers the story's
component under the story file's `plugins-test`.

The first run writes `review_rounds_max` (2, or `--max-rounds`) to the story
frontmatter and the branch, PR and `review_round: 0` to the story's change
document; run state is `.bl/run/S-34.json`. An escalation goes to the story's
`## Escalation` and the story keeps its `status` (stories have no
`escalated`): the open section is what blocks `bl run` and `bl merge`.
`bl status S34` prints the status, branch, PR, review state and round, the
escalation and the run state. `--plan`, `--resume`, `--interactive` and
`--max-rounds` behave as for a feature. A story with `feature:` set is
refused: run its feature. Like `bl run F-n` (whose gate also checks each of
its stories), it is refused while an unmet `blockers.json` edge holds it at
its `run` gate (F-66 D3; see "The gate checks" above), one line per edge
naming the blocker, its status and `until`.

**One repo per story (F-52 D1, D2).** A story's repo is its component's
(`unitRepo`), and `reposForStory` returns that one repo; `primary_repo` and
`secondary_repos` on a story are never read, and a story whose component has
no `repo` makes `bl implement` / `bl run` / `bl merge` exit 1 naming the
component (`storyRepoOrExit`, `story.js`). `bl implement`, `bl review`,
`bl merge` and `bl run` refuse `--repo` (`-r`) on a story as an unknown option
(`refuseStoryRepo`). Work in another repo is another story in a component of
that repo, linked by `depends_on` (`prompts/workon.md`, `story-run.md`,
`workon-review.md`); in a feature, a repo no story of the feature is in is a
missing story, which the agent escalates (`feature-story.md`,
`feature-workon.md`).

**Worktree preparation (S-862).** Every story worktree comes through one
function, `prepareStoryRepo` (`workon.js`): the worktree on the story branch
at `<root>/<branch>/<repo>` (`worktreePathFor`) with `ensureWorktree`'s guards, that repo's
bootstrap (`installDeps` limited to the repo), and the `workon` stage plugins
on a new worktree. It builds no prompt variables and launches no session;
`bl implement` calls it and then launches its interactive session.
`prepareStoryRun` (`bl run S-n`) calls it with `strict`: a guard refusal,
unknown repo, failed bootstrap or failed `workon` plugin exits naming the
repo, before any agent starts; its `otherWorktrees` is always empty. A
headless session cannot make a worktree the `bl` way, so `bl run F-n` and
`bl implement F-n` prepare every repo of the feature, strictly and in the
feature's repo order (`featureRepoOrder`, F-52 D3), before the agent starts
(`prepareFeatureWorktree`, through `prepareFeatureRepo`), and start the
session in the lead repo's worktree (`targetRepoName`; the others are
`otherWorktrees`). A story added after approval gets its worktree on the next
run or `--resume` with no edit to the feature (or at once from `bl side`). A feature with no stories exits
1 asking for them to be cut, and a story whose component has no repo, or a
repo the config does not know, stops the prep naming the story.
`bl implement F-n` and `bl run F-n` refuse `--repo` as an unknown option
(`verbs.js`); `bl review F-n --repo <r>` still narrows a review to one PR.

**Repos added during a run (F-48 D3).** After every agent session (each
story and its retry, fix-tests, the self-review, each review round, the fix
and its self-review) `bl run F-n` calls `refreshRepos` (`feature-run.js`):
it re-reads the feature's `stories:`, adds any new story to `prep.ordered`
after the stories the run has taken and puts those not taken yet in
dependency order again (`orderStoriesByDeps` on their current `depends_on`,
as at the start), so the implement loop reaches each after its prerequisites
and skips it when its criteria are checked; and for each repo of
`featureRepoOrder` the run has not
prepared, takes that repo's worktree on the branch (`git worktree list` in its
main checkout, where `bl side` put it), appends it to `prep.otherWorktrees`,
adds its `repos:` entry to the change document, refreshes
`{{otherWorktrees}}`, and records one `step: "repos"` history entry naming the
repos and stories. From then on the gate, the repo guard, the push, the PR
step and the review cover the repo: every push covers each prepared repo
with commits ahead of main, and each such repo without a PR in the run gets
one through `change.open` (or `change.find`), recorded on its `repos:` entry
and passed to every later review round as `otherRepos`. Each review round
covers and snapshots every prepared repo, PR or not (`reviewOtherRepos`).
The lead repo and its worktree never change. A new repo with no worktree on
the branch escalates, naming the story and the repo, before the gate;
`--resume` prepares it. A story list the refresh cannot resolve (it does not
parse, a story is missing, or a new story fails the checks
`prepareFeatureWorktree` makes at start) escalates too, as does a change
document that cannot name a new repo. After a session that is not an
implementation, `rescope` implements any story it added; the self-review
gates again when any repo moved or the scope grew; a round that ends
`addressed` after adding scope is gated and reviewed again (in the closing
round it escalates); and a resumed `addressed` run finishes without a round
only when nothing was implemented and the last round's `reviewedScope`
covers every current story and repo. `bl run S-n` has one repo and skips the
refresh.

`feature-story.md` prints the repos in order as `{{storyRepos}}` and the
other paths as `{{otherWorktrees}}` under `Lead worktree:`, below
`Unit dir :` (`{{unitDir}}`, the working directory) (`(none)` with one
repo) and tells the agent to work
only in the listed worktrees, commit each repo's changes there without
pushing, and, for a repo that is not listed, use `bl side` for a drive-by
change and escalate missing design scope (never a hand-made worktree). `story-run.md` names the one worktree. `{{storyRepos}}` is the
story's repo, or a feature's derived set.

`bl merge S34` merges the story's one repo; a worktree on the story's branch
in another repo is refused, naming the repo, before anything merges.
`bl merge F-n` passes `isSecondary` to `cleanupOneRepo`
for every repo but the lead. Such a worktree with uncommitted changes (tracked or
untracked, the session lock aside) is refused before anything is touched. Its
branch with no commits ahead of `origin/main` (local `main` when
there is no origin) is not merged, pushed or recorded in `commit:`: the merge
reports "no changes in <repo>" and removes the worktree and branch.

### `bl review`

One review round on the review agent, the step `bl run` takes: two dimension
passes (`review-correctness.md`, `review-failure-paths.md`) and the verifier
(`review-verify.md`), one session in the Review Log and `review_round` up by
one. For a story, the open PRs are found by title (`S34 in:title`) in every
repo, each worktree is synced with main first (a conflict exits, pointing at
`bl implement S34`), and every repo's PR is recorded on its `repos:` entry in
the change document. With no
open PR it says why, including a PR that merged before review.

```bash
bl review S34                 # alias: bl pr S34
```

### Several targets

Every id-dispatched verb takes several ids (`schedule.js`, `verbs.js`).
`bl run` and `bl implement` first decide what starts: a target that
`depends_on` another target (a feature through any of its stories), or a story
outside the targets that is not done, waits; so does a target whose files
overlap a lower-numbered started target's. A target's files are its branch diff
against main (`git diff --name-only main...HEAD` in each worktree) once the
branch has commits, else the backticked paths in its stories' Implementation
Plans, keyed by repo; a path that is not backticked is not seen, nor is one under
`### Sources of truth`, which is read, not changed. When a repo's worktree is missing or its diff fails, the plan paths count too. The waiting
targets are listed first, each naming its blocker or the shared files.

- `run`, `review`: each started target runs as a child `bl run <id>` /
  `bl review <id>` with its output in `.bl/run/<id>.out`; when all exit, one
  line each (outcome, PR, next step). Exit 1 if any failed or escalated.
  `--interactive` takes one target. Sibling children on one repo serialise
  the `main` sync (fetch, ahead-of-origin check, `merge --ff-only origin/main`)
  through `<git-common-dir>/bl-main-sync.lock` (`main-sync.js`), so none of
  them races the other's `FETCH_HEAD`; a failed fetch is a warning naming the
  local `main` commit the worktree is cut from, a failed fast-forward stops the
  child.
- `implement`: one tmux window per started target; outside tmux it exits 1.
- `merge`: one at a time in dependency order, stopping at the first failure.
- `refine`: stories and components go to the refine batch; with a feature among the
  targets, each opens its own tmux window.
- `status`, `approve`, `done`: each target on its own; a component's status lists
  its open stories.

```bash
bl run S-1 S-2 S-3            # S-2 depends on S-1: S-1 and S-3 start
```

### Pre-task discussion (`-P, --prompt`)

`bl refine` and `bl implement` accept a `-P, --prompt "<text>"` flag that
prepends a short discussion preamble to the launched session. The agent
reads the text, converses with you about it first, and only proceeds
with the underlying task (refine / workon) after you explicitly say yes.
If you say no, the agent exits without touching the story file or
worktree. `bl review -P "<text>"` instead adds the text to every review
session's prompt as instructions from the operator.

```bash
bl implement -P "the AC may no longer match the auth refactor" S34
bl refine -t -P "it's risky — let's scope it down" S34
bl review -P "focus on the retry logic, the rest looks fine" S34
```

The preamble lives in `prompts/_pre-task-discussion.md` and is
prepended by `session.js` so both launchers stay in lockstep.
Empty string (`--prompt ""`) behaves identically to omitting the flag.

### `bl capacity`

Shows whether each agent configuration can take work now (F-64 D6): one row
per configuration of `agent`, then `review_agent`, in list order, with its
role, agent, model (`-` for the account's own), state (`available`,
`unavailable`, `unknown`), each quota window's remaining percent and reset in
local time, and the adapter's message. It calls each adapter's `capacity()`,
the call the run loop makes, so it shows what the loop will see. An
`account`-scoped answer (Codex) is asked once per agent, a `model`-scoped one
once per model. It reports and does not gate: it exits 0 whatever the
states, and 1 only when the backlog or its `backlog.json` cannot be loaded.

```bash
bl capacity
# ROLE    AGENT   MODEL      STATE      DETAIL
# agent   claude  opus       unknown    claude cannot report capacity
# review  codex   gpt-6-sol  available  codex 5h 80% left (resets 2026-10-29 00:52 America/Los_Angeles); codex 7d 87% left (…)
bl capacity --json   # {"schema":"bl-capacity-json/v1","configurations":[{role, agent, model,
                     #   state, scope, until, windows:[{name, remainingPercent, resetsAt}], message}]}
```

Codex's reading comes from `codex app-server` (marked experimental), over
the JSON-RPC requests `initialize`, `initialized` and
`account/rateLimits/read`, the ones `~/codex-usage.py` sends.
`src/agents/codex-capacity.js` holds the conversation in a child process
with a 20-second deadline and stops app-server on every path;
`codexCapacity()` in `codex.js` maps the answer. Every bucket of
`rateLimitsByLimitId` (else `rateLimits`) gives its `primary` and
`secondary` windows ("codex 5h", "codex 7d"). A window with nothing left, or
`spendControlReached`, makes every Codex model `unavailable` until the latest
such reset (none for a spend cap). A timeout, an exit, a JSON-RPC error or an
answer with no windows is `unknown`, with the reason.

### `bl list`

List backlog stories. Active worktrees show their worktree status with a trailing `*`.

```bash
bl list                       # alias: bl ls
bl list -a                    # include completed/superseded
bl list auth                  # filter by regex pattern
bl list --theme backlog       # stories in a theme (Themes and Epics)
bl list --component C32 --feature F-51   # filters combine
bl list --epic E-62           # an epic's features, grouped, with progress
bl list --features --theme backlog       # a theme's features, grouped by epic
bl tree --epic E62            # trees containing the epic's pending stories
bl what-next --theme backlog  # next startable story in the theme
```

A Theme column leads once the backlog has a theme. `bl tree` and `bl what-next` take the same
filters; a component argument (`bl tree C32`) is the `--component` filter, and a story id with
a filter is refused.

`bl status` with no arguments prints the same table for the open stories, in a different order:
strictly by status, furthest along first as `flow.json` has it (`Flow.openStatusesOf('story')`:
`in_progress`, then `refined`, then `backlog` in the shipped flow), stack rank then numeric id
within each. A story is open when its status does not meet `done`; a status `flow.json` does not
name meets nothing, so it stays listed, last. A `flow.json` bl cannot read stops the command with
its `FlowError`, even with no stories. `bl list` and `bl grep` read `flow.json` the same way, and
stop the same way, but sort differently: worktree stories first, then `Flow.listRankOf('story', …)`
(`in_progress`; then `backlog`, `refined` and any status `flow.json` does not name, equally; then
`done`, then `superseded`). Here a story with a worktree keeps its status group and shows the `*`.
Any flag with no id is a usage error, not a filter.

### `bl history`

The backlog's state over time (F-40 D1, D2; `src/history.js`, the command in
`src/history-cmd.js`): one snapshot per calendar day with a commit, the series `bl report`
builds on.

```bash
bl history                    # ISO weeks × points per status, and the scope
bl history --json             # { days, groups, unreadable }
bl history --since 2026-09-01 # only days from that date
bl history --scope F-40       # a theme (slug), an epic (E<n>), a feature or a component (C<n>)
```

- **Days.** The last commit of each committer date (a UTC day, whatever time zone the commit
  was stamped in, so the last day holds HEAD) reachable from HEAD. A day is read from git
  objects only: one `git ls-tree -r`, then one `git cat-file --batch` for the `index.md` blobs
  not already parsed in the run. A blob is a story when its frontmatter has `story_id`, a
  feature when it has `feature_id`; the path is ignored, so the pre-F-49
  `projects/<p>/E<nn>-…/[.completed/]S<n>-…/` layout reads like `stories/`. A day records each
  story's `status` and `points` and each feature's `status` and `stories:`, nothing else.
- **Parsing.** `parseFrontmatter`; a block it rejects goes through `legacyRepaired` and `yaml`
  (failsafe), for the pre-F-62 blobs only (Decision A1, argued at the call in `parseBlob`). A
  blob that still fails is skipped; `unreadable` counts the distinct ones over the days shown,
  and a count above zero warns on stderr.
- **Grouping** is the current tree's (`groups`): each story's `feature`, `component`, `added`
  and `completed`, each feature's `epic` and `theme`.
- **Backfill.** Each calendar day from the earliest `added` to the day before the first commit
  is projected from the current stories: in scope from `added`, `done` (or `superseded`) from
  `completed`, current points, any other status `backlog`, no features. Such a day has
  `backfilled: true` and `commit: null`; the table marks it `(backfilled)`.
- **Scope.** A feature's stories are the `stories:` it listed that day; an epic's, its current
  features'; a theme's, its current features' (its epics' and those with no epic); a
  component's, the current stories in it. A scope holds only stories in the current tree; a
  story with no feature is in no theme. An unknown scope exits 1 naming it.
- **Cache.** `.bl/report-cache.json` maps each commit to its parsed day under a `version`
  (`CACHE_VERSION`); a run reads only the commits it lacks and writes it back through
  `atomicWriteFile`. Another version discards the file; a day of another shape
  (`validCachedDay`) is read from git again; deleting it is safe.
- **Since.** `--since` drops the days before it from `days` (and `--json`); `buildHistory` keeps
  them as `earlier`, which only `bl report`'s first transitions read.
- No lock and no activity log: it only reads git objects and the working tree. Exit 1 on a
  git error.

### `bl report`

The backlog progress report (F-40 D1, D3, D5; the numbers in `src/report.js`, the command in
`src/report-cmd.js`), built on `bl history`'s snapshots.

```bash
bl report                    # write <backlog>/reports/ and print the path of index.md
bl report --json             # print data.json, write nothing
bl report --since 2026-09-01 # only history from that date
bl report --out <dir>        # write there instead (links assume <backlog>/reports/)
bl report --charts vega-lite # pick the chart adapter (vega-lite is the default and only one)
```

- **Output.** `reports/index.md`, `reports/data.json` (every figure and series, version
  `REPORT_VERSION`) and `reports/.gitignore` holding `*`, so the output ignores itself and the
  backlog's `git status` stays clean. A run writes the whole report in `.reports.new`
  beside it, then swaps it for the last run's by two renames, so a failed run leaves the last
  report whole (if moving it back fails too, it stays in `.reports.old`, and the next run
  restores it before staging); a directory that holds files but no such `.gitignore` is refused (exit 1),
  never replaced. The page goes through the backlog's `.md` format plugin, as `bl sync` formats
  the indexes.
- **Counts** are the last snapshot's (HEAD's day): stories and points by status, features by
  status, epics open or done (done once every feature is done or superseded), themes, the open
  total (what the top-level `index.md` calls the total backlog). Titles, links and grouping are
  the current tree's. Scope is the points of stories not `superseded`; done, of `done` ones.
- **Tables.** Themes, Epics, Features and Components: scope, done, remaining and percent done
  over each one's stories (`scopeStories`). Feature rows add stories done / in scope, the
  feature's status and the `review_round` of its highest-numbered `change*.md`. Rows link to
  `../<dir>/<entry>/index.md`.
- **Throughput.** Points and stories per ISO week reaching `done` (a story's first snapshot
  showing it; on backfilled days that is its `completed` date), for the 26 weeks ending with the
  last snapshot's, each with the trailing four-week average. With `--since`, first transitions
  and averages still read the days before it; the weeks, the lead and cycle window start there.
- **Lead and cycle time.** Over stories first done in the 90 days up to the last snapshot:
  lead from `added`, cycle from the first snapshot showing `refined` or `in_progress`, each as
  count, median and 85th percentile (linear interpolation, `percentile`), in days. **Work item
  age**: each `refined` or `in_progress` story, from that same first day to the last snapshot.
- **Charts.** `src/report.js` builds them as plain `Chart` models in `data.charts` and imports
  no adapter: `burnup-backlog`, `flow` (points by status per week, stacked), `throughput`
  (weekly bars and the trailing average), then `burnup-theme-<slug>` for each theme,
  `burnup-epic-E<n>` for each epic with open stories and `burnup-feature-F-<n>` for each
  feature not `done` or `superseded`, each under a `### <id> · <title>` heading after its
  section's table. A burn-up has scope and remaining lines and a done area from the first week
  with points; the weeks before the first commit draw scope as a dashed `scope (backfilled)`
  series. Last comes `cost`: output tokens of the 20 units with the most, as bars stacked by
  unit type on a category axis.
- **Cost** (`data.cost`, D3). A unit is what `bl run` runs: a feature, or a story with no
  feature (or whose `feature:` names none in the tree). Per unit, from its current frontmatter:
  the four `tokens_*` kinds, the `tokens_headless_*` share of all four, points (a feature's:
  its listed stories not `superseded`), output tokens per point and `tokens_updated`; sorted by
  output tokens. The total covers units with tokens; the average per point covers done units
  with tokens and points (each kind's sum over their points' sum). A unit with no `tokens_*`
  shows `—` and is in neither; a zero-point unit has no per-point figure.
- **Token efficiency** (`data.efficiency`, D7), over done units with tokens and points: output
  tokens per point by unit type (`feature` for a feature, else the story's `type`) as median,
  90th percentile and count; the median for 0 to 2 review rounds and for 3 or more (the
  highest-numbered `change*.md`'s `review_round`, none counting as 0); `tokens_by_step`
  (see Tokens per step) summed per step name, `—` for a unit without it; and the outliers, units
  above their type's 90th percentile. `units`, `cost` and `efficiency` are exported for
  `bl retro` (S-905).
- No activity log, no commit, and no lock but the output's own (`.reports.lock` beside it): a
  second run while one is writing exits 1 naming the holder. Exit 1 also on a git or IO error,
  a bad `--since`, an empty `--out` or an unknown `--charts` adapter (the message names the
  registered ones).

**Chart adapters** (F-40 D4, `src/chart.js`). An adapter is `{ name, render(chart) }`, where
`render` returns `{ markdown, files }`: `markdown` takes the chart's place in `index.md`, and
`files` (paths relative to the output directory, never `..`, absolute, or one of the report's
own `index.md`, `data.json`, `.gitignore`) are written there, under their normalized path
(`outputPath`); two that name one file, or a file and a directory holding it, throw.
`registerAdapter` adds one by name, `adapter(name)` looks one up and
`renderCharts(charts, name)` renders them all to
`{ markdownById, files }`; `renderMarkdown(data, markdownById, flow)` leaves a
`<!-- chart: <id> -->` line for a chart it was not given. The one adapter, `vega-lite`
(`src/chart-adapters/vega-lite.js`), writes a ` ```vega-lite ` fence holding a Vega-Lite v5 spec
(data inline, `width: "container"`, UTC time axis by month, weekly bars from their ISO Monday
`x` to the next Monday `x2`, a layer per mark kind, the fixed
Okabe-Ito colours, no background or text colours) and no files; up-doc draws it. To add an
adapter, write `src/chart-adapters/<name>.js` that calls `registerAdapter` on import, and import
it from `src/report-cmd.js`; nothing in `src/report.js` changes. Its specs are pinned by
`test/fixtures/charts/` (rewrite them with `UPDATE_CHART_FIXTURES=1` and review the diff).

**Where to read it.** Two places, both regenerated by running `bl report`, never committed:

- a documentation site that builds the backlog's `reports/` directory (one that runs
  `bl report` as part of its build);
- any local server of the backlog repo, at `reports/index.md` (and `reports/data.json`) after a
  local `bl report`. It shows the tables; charts appear only where a renderer draws the chart
  blocks.

### `bl next`

The next feature by the operator's feature order (F-53 D3, `src/next.js`). `bl what-next`
picks a story by the dependency graph; `next` is no longer its alias.

```bash
bl next                       # the first ranked open feature
bl next --theme accounts      # what's next for accounts
bl next --epic E62            # the first ranked feature of an epic
```

stdout is the first feature in `feature-order.md`'s `ranked:` that is not done or superseded
and matches every filter given (`--theme`, `--epic`, read by `src/filter.js`); stderr lists the
matching ranked features with their position in `ranked:`, title, theme, epic and why. When
nothing ranked matches, stdout is empty and stderr names the matching features not yet ranked.
An unknown or malformed theme or epic exits 1, as do `--feature`, `--component` or a
positional argument, and a `ranked:` that is not a list of `{feature, why}`. With no
`feature-order.md` it says so and lists the unranked features. The order is a preference
(F-53 B2): `depends_on` overrides it, and `bl next` never reads the roadmap.

The order lives in `<backlog>/feature-order.md`, standard YAML frontmatter read by
`parseFrontmatter` (`src/feature-order.js`):

```yaml
---
ranked:
  - feature: F-48
    why: Split from F-42; needs F-42, F-49's components and F-52's one repo per story.
---
```

Its body is a hand-written intro, then `## Next up` and `## Not yet ranked`, both written by
`bl sync`, then `## History`, hand-written and appended to by `bl merge F-<n>`. Reorder by
editing `ranked:` and running `bl sync`.

### `bl edit` / `bl view`

Open a story, component, feature or task file in your editor (`bl which` prints its
path, `-d` its directory; a task's directory is `tasks/`):

```bash
bl edit S34                   # opens in $VISUAL / $EDITOR / vi
bl view T5                    # read-only copy in $VISUAL / $EDITOR / vi
bl view T5 > t5.md            # stdout not a terminal: the file, byte for byte
bl which -d C10               # prints the component's directory
```

Both exit with the editor's status: 127 when it cannot be launched, 128 + n when
signal n kills it. When `bl view` cannot make its copy it shows the file instead
(printed when it fits the terminal, else `$PAGER` → `less` → `more`) and exits
with the pager's status the same way.

### `bl done`

Marks a story complete (`status:`, `commit:`, `completed:`; the directory
does not move) and syncs:

```bash
bl done S34                   # uses HEAD commit hash
bl done S34 abc1234           # explicit commit hash
bl done --superseded S34      # mark as superseded
```

### `bl sync`

Regenerates all index tables from story frontmatter, and optionally commits:

```bash
bl sync                       # alias: bl s
bl sync --commit -m "chore: refine S-42" --story S-42 --story S-43
bl sync --commit -m "chore: refine S-42" -m "Why: the plan missed the lock hold." --story S-42
bl sync --commit -m "chore: rename C02" --story S-42 --path components/C02-x --path components/C02-y
bl sync --commit -m "chore: append review session for F-9 (2026-10-15)" --path features/F9-x/index.md
```

`--commit` needs at least one `--story` or `--path`: a feature file has no story to name, so
the loop's prompts commit it with `--path` alone.

`-m` repeats the way it does for `git commit`: the values are joined in order with a blank
line between them, so the first is the subject and each later one is a body paragraph.
Empty or whitespace-only values are dropped. A value given as the next token may not begin
with `-` (a lone `-` is fine): `-m --story S-42` fails with `-m needs a value` instead of
taking `--story` as the message, and the same holds for `--story` and `--path`. Give such a
value inline, `--message=- note` (likewise `--story=<v>` and `--path=<v>`).

`bl sync` holds the backlog lockfile (`.bl-new.lock`, `src/lock.js`) while it regenerates,
so concurrent syncs and `bl new` runs take turns. A command that finds the lock held by a
live process says so once on stderr (`Waiting for lock (.bl-new.lock) held by pid <n>…`) and
polls until the holder releases it or 30 s pass. The lock is re-entrant within a process
(`bl new` and `bl new --feature` already hold it when they call `runSync`). `runSync` returns
every backlog path it wrote; it moves nothing.

`--commit` regenerates and commits in the same lock hold. It stages exactly the paths the
sync reported plus each `--story` directory and each `--path` (a backlog-relative path you
wrote or moved yourself, such as both ends of a `git mv`; repeatable), and commits them with
`git commit --only` (`backlog-commit.js` `commitPaths`), so another person's dirty story file
stays out. A `--path` must name one exact file or directory: the root, the whole
`stories/`, `components/`, `features/`, `themes/` or `epics/`, a glob, a git magic pathspec, an
absolute path or one with `..` is refused before the sync starts, since it would widen
the commit to unrelated work.
Nothing to commit exits 0; `--commit` without `-m` or `--story`, `--path` without
`--commit`, or a `--path` that is neither on disk nor tracked by git, is a usage error.

**Pull before, push after (F-50 D4).** The backlog is shared through its `origin` remote, so
every clone (the operator's, the update runner's) sees the others' work. Every commit
`commitPaths` makes, and each step commit of `bl run`'s loop (`feature-run.js`
`commitBacklog`), is followed by `git push origin main`; a failed push (offline, or `origin`
moved on) is one warning naming the command to retry, and the command exits as it would have,
since the next committing command's push carries the commit. With an `origin` remote the
commit and its push hold the main sync lock the pull holds, so a commit from a process without
the backlog lock (`openUnitChange`, the loop) never lands mid-rebase or loses its file to a
pull's autostash. Every command that commits the
backlog (`new`, `side`, `run`, `implement`, `merge`, `done`, `updates`, `sync --commit`,
`block add`, `block remove`, `block list --fix`, `task`, `task done`), plus `bl inbox` and `bl updates status`, first rebases onto `origin/main` with
`--autostash` (`backlog-commit.js` `pullBacklog`, under the backlog lock and the main sync
lock; `bl.js` decides which commands through `commandPullsBacklog`). When `origin/main` brings
nothing new the work tree is not touched. A conflict on a story or feature aborts the rebase,
which puts back the work tree and the stashed edits, warns, and the command goes on from local
state; uncommitted edits that conflict with what was pulled put `main` back where it was and
the edits back from the stash, the same way. A pull that does not go through is checked
against the state it started from (branch, HEAD, no rebase in progress, nothing unmerged, the
stash and the uncommitted edits); when they differ (a failed `git rebase --abort`, a stash that
would not re-apply) the pull is `unsafe` and the command does not run. A conflict confined to
generated files (the top-level and component `index.md` files and `allowed-tools.json`)
keeps the local side, and the regeneration that follows every pull that brought anything
(`sync.js` `pullBeforeCommand`) rebuilds them and commits and pushes what changed. A
regeneration that cannot be built or committed stops the command and stays pending in
`.bl/run/pull-regenerate.json`; the next command that pulls finishes it first. A backlog with no `origin` remote neither
pulls nor pushes.

What the sync writes (F-49 D7, F-51 D3), every link pointing into `stories/`, `components/`,
`features/`, `epics/` or `themes/`:

- the top-level `index.md`: `## Themes` (theme, title, epic count, open features),
  `## Components` (id, title, repo, home, open and
  done story counts; a component has no points), `## Features` (active ones) and the
  hand-ordered `## Backlog` of open stories (id, type, component, title, points). A
  `## Projects` table an older sync wrote is removed, and no project page is written
  (F-51 D3). The Backlog order is the global priority
  (`story.js` `readBacklogOrder`); stories not in it follow in id order.
- each `epics/E<nn>-*/index.md`: the derived `features:` and `status:` frontmatter and
  `## Features` (id, title, status, stories done/total, points done/total) after
  `## Outcome`.
- each `themes/<slug>/index.md`: `## Epics` (id, title, status, features done/total), then
  `## Features`, its features with no epic.
- each `components/C<nn>-*/index.md`: `## Stories` (its open stories in priority order, with
  their status) and `## Features` (active features touching it). Its frontmatter is left as it
  is: no points.
- each feature: its `## Stories` table (with a `Component` column), `points:` and the derived
  `components:` roll-up, which replaces the old `epics:`.
- `feature-order.md` (F-53 D1, `syncFeatureOrder`): `## Next up` (#, Feature, Title, Theme,
  Epic, Why: each open ranked feature, numbered by its place in `ranked:`, title, theme and
  epic from the feature's frontmatter) and `## Not yet ranked` (every feature that is not
  done, not superseded and not ranked, by id, with title and theme). The frontmatter, the
  intro and `## History` are written back byte for byte. With no `feature-order.md` nothing is
  written.

A story whose `component:` has no directory is listed with the bare id, not a link. Nothing
moves: status is frontmatter, so a sync never renames a directory.

Every file a sync writes is replaced atomically (`atomicWriteFile`), and only when its bytes
change, so a sync that dies or runs out of disk leaves each file as it was or as regenerated,
never truncated (F-67). A feature's tables and roll-ups (`syncFeature`) and a story's Tasks
table (`syncStoryTasks`) are written through `updateSpecFile`: they take the spec lock inside
the backlog lock and start from the spec as it is then, not as it was collected, so a token
step entry a session wrote meanwhile stays. The epic, theme, component and top-level indexes,
`feature-order.md` and `.bl/run/pull-regenerate.json` go through `atomicWriteFile` alone.

### `bl validate`

Run backlog-wide integrity checks (frontmatter, duplicate IDs, acyclic dep graph) and report every finding.

```bash
# Interactive — both streams hit the terminal, exit code drives the prompt.
bl validate

# Capture the report only, drop progress.
report=$(bl validate 2>/dev/null)

# Just count errors in JSON mode.
bl validate --json 2>/dev/null | jq '.summary.errors'

# Filter to specific finding codes.
bl validate --json 2>/dev/null | jq '.findings[] | select(.code=="cycle")'

# Pre-commit / CI gate — exit code is the contract; stdout/stderr to log.
bl validate || exit 1

# Strict gate that fails on warnings too.
bl validate --strict
```

Exit codes:
0 No errors (warnings allowed unless --strict).
1 At least one error finding.
2 --strict and at least one warning (no errors).

Findings codes:
missing-required-key, unknown-fm-key, bad-status, bad-points,
id-dir-mismatch, bad-id-format, duplicate-id, cycle,
dangling-dep, asymmetric-dep, plugin-binary, bad-update-request,
component-unknown, home-component, component-has-status, component-paths,
repo-key, frontmatter-yaml, frontmatter-list, feature-order-file,
feature-order-feature, roadmap-file, roadmap-section, theme-brief, found-by,
flow-json, blockers-json, blockers-unit, blockers-gate, blockers-status,
blockers-duplicate, blockers-cycle, blockers-unmeetable, blockers-order,
task-unit, task-field, deferred-unsized, operator-tasks-retired,
bad-tokens-by-step, agent-config

`agent-config` (F-64 D2, `findAgentConfigFindings`, error at `backlog.json`) is the error
`loadConfig` would throw for `agent` or `review_agent`, at the top level or under a repo's
`overrides`, the retired shape (a string, `agent_model`, `fallback_model`) included; `bl
validate` loads with `lenientAgents` so it reports the error instead of stopping on it.

`bad-status` on a story or a feature is a status `flow.json` does not name for its type, so
removing a status from the file makes every unit at it a finding, and adding one makes it
valid. A missing or unreadable `flow.json` is not a finding: `bl validate` stops with the
`FlowError` naming the file. `flow-json` (F-66 D1, `findFlowFindings`, error at `flow.json`) is
an `implies` that names a status its type lacks, one that is not closed (A implies B, B implies
C, A does not list C), or a gate verb other than `run`, `implement` and `merge`.

The `blockers-*` findings (F-66 D5, `findBlockersFindings`) are at `blockers.json`; a missing
file has none. All are errors except `blockers-order`:

- `blockers-json`: not JSON, a wrong `schema`, or an edge of the wrong shape; nothing else in the
  file is checked.
- `blockers-unit`: a `blocker`, `unit` or `active_when.unit` that is not a unit (a story,
  feature or task) in the backlog, or a `*` blocker.
- `blockers-gate`: a gate the unit's type does not have in `flow.json` (for `*`, no type has it).
- `blockers-status`: an `until` that is not a status of the blocker's type, or an
  `active_when.status` that is not one of its unit's type.
- `blockers-duplicate`: two edges with one (`blocker`, `gate`, `unit`).
- `blockers-unmeetable`: a closed blocker (its status meets `done`) that does not meet `until`.
- `blockers-cycle`: a deadlock in the hold graph (see **Holds between units**). A cycle of
  standalone stories' `depends_on` alone is `cycle`'s and not reported again.
- `blockers-order` (warning): the text is not what bl writes (unsorted, or reformatted by
  hand); `bl block list --fix` rewrites it.

`task-unit` and `task-field` (F-65 D1, `findTaskFindings`) are at the task file. `task-unit`
(error): `unit:` names no feature or story in the backlog. `task-field`: a missing `task_id`,
`title`, `unit`, `owner`, `status` or `added`, a `task_id` that is not `T-<n>` or not the
file's number, one id on two files, an `owner` outside `operator`, a `status` outside
`flow.json`'s task statuses, or a `done` task with no `done:` date (errors); a key bl does not
know (warning).

`deferred-unsized` and `operator-tasks-retired` (F-65 D4, `findDeferredErrors`, errors at the
unit's file with its line) check an open unit's `## Deferred` or `## To Do`: an item without a
numeric `[points: N]`, and a `### Operator tasks` sub-heading or `operator:` bullet. A `done`
or `superseded` unit has neither (see **`## Deferred`, `## Notes` and tasks**). The S-970
`operator-tasks` rule is gone with `src/operator-tasks.js`.

`found-by` (F-48 D2, `findFoundByFindings`) is an error on a story whose
`found_by:` is set but names no existing feature (`F-<n>`) or story (`S-<n>`).
`found_by` is a record: nothing that decides reads it. `bl status S-n` prints it
on its head line as `found by: <id>`.

`roadmap-file` and `roadmap-section` check `roadmap.md`'s shape and `theme-brief` a theme's
`brief:` (see **The roadmap** and **Themes and Epics**).

`feature-order-file` and `feature-order-feature` (F-53 D1, `feature-order.js`
`findFeatureOrderFindings`), both errors at `feature-order.md`: the first when the file is
missing, its frontmatter is not YAML, or `ranked:` is not a list of mappings each with a
non-empty `feature` and `why`; the second when a ranked id names no feature, a done or
superseded one, or one already ranked. A backlog with no `feature-order.md` reports
`feature-order-file`; `bl merge`, `bl sync` and `bl next` still work.

`frontmatter-yaml` and `frontmatter-list` (F-62 D4, `findFrontmatterFindings`) run first,
over the root `index.md`, every unit's `index.md` and change documents, and every task file
under `tasks/` (`frontmatterFiles`). A block that is
not YAML is `frontmatter-yaml` (error) at the parser's line and column, and the file is not
read any further: the readers skip it (`config.invalidFrontmatter`), and a change document
takes its unit's `index.md` with it, so nothing else is reported from a half-read file. A
list key that holds a non-empty scalar or a mapping, or a member that is not a string (not a
mapping, for a change document's `repos:`), is `frontmatter-list` (error) at the key's line,
and that file is skipped the same way. Every other command reads such a file and stops at its
`FrontmatterError` or `FrontmatterListError`.

`repo-key` (F-52 D5, `validateFrontmatter`) is an error on a story or a
feature that still sets `primary_repo` or `secondary_repos`, once per key
(never also `unknown-fm-key`). bl reads neither: the message names the
story's component and that component's repo, or says a feature's repos come
from its stories' components, and says to remove it.
It replaces `component-repo-mismatch`, `feature-primary-repo-unlisted` and
`feature-secondary-repos`, which compared the copies.

The component rules (F-49 D4, `validate.js` `findComponentFindings`), all
errors: `component-unknown` is a story with no `component:` or one naming a
component with no directory under `components/`;
`home-component` is a registered repo with no `home: true` component or
several (anchored at `components/` when there is none), or a component
whose `repo` backlog.json does not register; `component-has-status` is `points:` or
`status:` on a component; `component-paths` (F-52 D4, F-61 D2) is a `paths:` entry
that is empty, not a string, absolute or has a `..` or `.` segment (`paths:` itself is
optional). Two component directories with one id are
`duplicate-id`; every reader (`bl sync`, `bl validate`, a story's
placement) takes the first by directory name.

`bad-tokens-by-step` is an error on a story or feature whose `tokens_by_step`
(see Tokens per step) is not a mapping, has a key that does not match
`^[a-z][a-z-]*(\.[1-9]\d*)?$`, or has an entry that is not a mapping of the
four token kinds to non-negative integers (`validate.js`
`tokensByStepProblems`).

`bad-update-request` is an error on an update story whose request state is
malformed (`validate.js` `updateRequestProblem`): an `update_request` other
than `approve` or `drop`, a drop without a non-empty `update_request_reason`,
or a reason on anything but a drop. `bl updates run` skips such a story and
`bl updates status` shows it as `decision needed`.

`plugin-binary` is a warning that fires for every plugin entry whose
resolved first-token is not on PATH. The finding carries extra
sub-fields on top of the standard shape: `plugin` (key from
`backlog.json` plugins map), `stages` (array of stage / op names
within that plugin sharing the same first-token), and `command` (the
resolved first-token). Suppress the category on tool-incomplete
machines with `bl validate --skip plugin-binary`.

`bl validate` always checks the whole backlog; it takes no scope option
(`--project` is an unknown option, F-51 D5).

### `bl fix`

Apply auto-fixable remediations for findings that `bl validate` reports.
`bl new` (single and `--from`) writes `depends_on` / `required_for` exactly as
given and never adds the reverse edge. After creating linked stories, run
`bl fix --story <id>` rather than hand-editing frontmatter. The shared
`_validate-before-sync.md` fragment (every story-editing prompt) and the
feature-refine prompt tell agents to do this.
The mutation rule for each supported code is deterministic and append-only;
re-running on an already-clean backlog applies zero fixes.

```bash
# Apply every supported code (currently just asymmetric-dep) to the
# whole backlog. Agents: use --story instead.
bl fix

# Only findings anchored at S-858 (its own depends_on / required_for);
# the reverse edge is still written on the other story's index.md.
# Repeatable; the ids are a union.
bl fix --story S-858 --story S-859

# Preview the planned edits without writing.
bl fix --dry-run --story S-858

# Restrict to one code (repeatable; no-op when only one is supported).
bl fix --code asymmetric-dep

# Scope to one theme's stories (F-51 D1). Combined with --story it intersects.
bl fix --theme backlog

# Pipe machine-readable output.
bl fix --json | jq '.summary'

# Two-step flow when index drift matters: fix the frontmatter, then
# regenerate the auto-built index tables.
bl fix --story S-858 && bl sync
```

`bl fix` parses its arguments strictly (`parseFixArgs` in `src/fix.js`, not
the shared `parseArgs`): an option it does not accept, or a stray positional,
is an error, not a silent unscoped run. The human report lists each written
file by its story path; with `--story` that list tells an agent which other
story directories to name in `bl sync --commit --story …`, because the write
lands on the target story, not the one the agent edited.

Supported codes:
asymmetric-dep — appends the missing inverse edge to the target story's
`required_for` (or `depends_on`) frontmatter list: the parsed list gains the id (a missing
key goes after its partner) and the block is written back by `serializeFrontmatter`.

Output:
stdout — the fix report (or one JSON object with `--json`); empty when
no fixes were applied.
stderr — progress lines, e.g. `scanning N stories…`. Empty in `--json`
mode when stdout is not a TTY.

Exit codes:
0 Completed cleanly (zero or more fixes applied; dry-run also exits 0).
1 At least one finding could not be fixed (e.g., write failure,
frontmatter that is not YAML, a list key that is not a list), or the backlog lock was not
free within 30 s (`Timed out waiting for lock`; see below).
2 Invalid arguments: an option `bl fix` does not accept
(`bl fix: unknown option "--bogus"`), a stray positional
(`bl fix: unexpected argument "S-1"`), or an unknown `--code`, `--theme`
or `--story` (`bl fix: unknown --story "S-999"`). Nothing is written: an
unknown option or positional is refused before the backlog is read, and an
unknown `--theme` or `--story` right after the read-only scan.

`bl fix` (without `--dry-run`) holds the backlog lock from its story scan
through its last write, the same lock `bl new`, `bl sync` and `bl merge`
hold. An asymmetric-dep fix writes the _other_ story's `index.md`, so two
agents whose stories both depend on a third target the same file from
separate processes; the lock serialises them so both edges land, and a
`bl sync --commit` cannot run while a fix rewrites a story file. Each file is
written with `atomicWriteFile` (`src/atomic-write.js`, shared with
`allowed-tools.json` and `bl merge`): it is staged at a per-process
`<backlogRoot>/.bl/tmp/<name>.<pid>.<random>.tmp` and renamed into place.
`.bl/` is in every backlog's `.gitignore`, so a crash between the two
leaves its staging file only in ignored space, never in a story directory
that `bl sync --commit --story` commits; old files there are never swept,
since a sweep could delete a live caller's staging file. The rename is
atomic because `.bl/` is on the backlog's filesystem; if it is not (a
symlink elsewhere) the rename fails with an EXDEV error naming the staging
directory and the target, with no fallback to staging beside the target.
The staging file is created exclusively (`wx`): a name that already exists
belongs to another caller in this process, so it is dropped and a fresh
name drawn, up to `STAGING_ATTEMPTS` (10); after that the EEXIST
propagates and the other caller's file is left alone. A failed write or
rename removes only the staging file this caller created, and a removal
that fails for any reason other than the file already being gone is
reported on stderr with the staging path (`warning: could not remove
staging file …`). A fix that waits on the lock exits 1
after 30 s with the usual `Timed out waiting for lock` message. `--dry-run`
reads without the lock.

`bl fix` does **not** run `bl sync` automatically. When index drift
matters, run `bl fix --story <id> && bl sync` as a two-step flow.

### `bl merge`

Merges the story branch into main, marks done, syncs, pushes, and removes the worktree:

```bash
bl merge S34
bl merge S34 --keep         # keep the branch after cleanup
bl merge S34 --switch-main  # switch a stale main checkout back to main first
bl merge S34 --no-review    # merge a story that was never reviewed
```

`bl merge S-<n>` and `bl merge F-<n>` apply **one set of gates** from one
function, `mergeGates(unit, { config, args, repos })` in `src/merge-gates.js`
(F-36 D1), on a `storyUnit` or `featureUnit` before any repo is touched. It
returns findings and never exits; `main` (`cleanup.js`) and `cmdMerge`
(`feature-cmd.js`) print every finding and exit 1. The messages name the id
only, so a story and a feature refused for the same reason read the same.
Kind-specific preconditions stay with the caller (a feature must be `running`
or `escalated`; a story's repo must be its component's, registered). There is
no CI gate (D2): no repo has hosted CI since S-565, and the repo-local
pre-push gate runs on `git push origin main`. In order:

- **Blocker gate** (F-66 D3) — one `blocker` finding per unmet, active
  `blockers.json` edge at the unit's `merge` gate, on the unit or, for a
  feature, on one of its stories (`heldBy(config, id, "merge")`, injectable as
  `held`): `<unit> is held at merge by <blocker> (<status>, needs <until>): <id>
merges once <blocker> meets "<until>" (bl status <blocker>).` No flag
  bypasses it; the blocker moving on or `bl block remove` lifts it.
- **Review gate** — `featureReviewGate` for both kinds: refused while
  `review_status` is `pending`/`fixed` or the latest review session has an
  unchecked **Must** or **Should** box, both read from the change document.
  Open nits do not block, so a unit `bl run` ended `clean` always passes. No
  flag bypasses it; edit the change document to override. After the merge,
  each repo's commit goes to its `merged:` entry and a `## Merge` line, and
  the change is `merged`; a story merged alone gets no tag and no release
  manifest.
- **Never reviewed** (D3, S-755 folded in) — a unit whose change document has
  no Review Log session (or no change document) is refused:
  `<id> has never been reviewed — run \`bl review <id>\` (or \`bl run <id>\`), or pass --no-review to merge without one.`Each repo's branch is looked up with`change.find`; a PR in state `MERGED`adds`<repo>: PR #<n> (<url>) merged on the forge at <headRefOid> before any review`.
A forge without `change.find`, or a failing op, skips the lookup, not the
check. `--no-review`merges anyway and appends`- Merged without review (operator, <date>)`to the change document's`## Merge`, plus `- <repo>: PR #<n> merged on the forge at <sha> before any review`
  for each forge-merged PR. There is no retrospective review (S-789).
- **Escalation gate** — an open `## Escalation` in the story or feature file.
- **Stray worktree** — a worktree on the unit's branch in a registered repo
  the unit does not own (a story's one repo, a feature's stories' repos) is
  refused, naming the repo: work in another repo is another story.
- **Main-checkout gate** — runs only when nothing above refused, so
  `--switch-main` never acts on a merge that stops anyway. Every target
  repo's main checkout must be on `main` (`preflightMainCheckouts`, which
  prints its own detail). A checkout on another branch is classified:
  - **stale** — no tracked changes and the branch is merged, either an
    ancestor of `origin/main` (after `git fetch --prune origin`, then an
    explicit `git fetch origin +refs/heads/main:refs/remotes/origin/main` so
    a narrowed `remote.origin.fetch` cannot leave `origin/main` stale) or the
    forge's `change.find` lists the branch's PR as `MERGED` with a
    `headRefOid` that is the branch's `HEAD` (GitHub squash-merges, so ancestry
    alone can't tell). The command prints
    `git -C <repo> switch main && git -C <repo> pull --ff-only && git -C <repo> branch -D -- <branch>`
    and exits non-zero; `--switch-main` runs those steps and continues.
    `--switch-main` acts only when no other target is refused.
  - **dirty** — tracked changes (untracked files don't count; `git switch`
    carries them): refused, listing the paths.
  - **unmerged** — clean but the merge is unconfirmed (no forge op, no
    merged PR, or `headRefOid` differs): refused, with up to 10 commits
    ahead of `origin/main` and the reason.
  - **detached HEAD**, or the checkout on the very branch being merged:
    refused.

  A side change is a `bl side` story with its own worktree
  (`prompts/_side-changes.md`), so a stale checkout should be rare.

**Integration** (F-36 D4). After the gates and before the first merge into
`main`, both kinds call `integrateForMerge` (`src/merge-integrate.js`), which
builds a prep from the unit's existing worktrees (`mergePrep`: the first repo
in merge order with a worktree on the branch leads, the rest are
`otherWorktrees`; a repo with no worktree is skipped, and with none at all
there is nothing to integrate) and runs `integrateUnit` (`src/feature-run.js`,
beside `reviewFeature`):

- It takes the unit's run lock (refused while a `bl run` of the unit holds it)
  and refuses when any worktree has uncommitted changes, before any merge.
- Per repo, in merge order: `git fetch origin` with `MAIN_REFSPEC` under the
  repo's main sync lock (a failed fetch is a warning and the last fetched
  `origin/main` is used; local `main` when there is no origin), then
  `git merge --no-edit <ref>` **into the branch, in the worktree**, never the
  reverse. Each repo ends `current`, `merged` or `conflicted`; a branch with
  no commits of its own (a repo prepared up front that no story changed) is
  left `current`, not fast-forwarded.
- A conflicted repo first goes through the `regenerate` stage (F-36 D5; see
  `### Lifecycle Stages`): the generated files its active `regenerate`
  plugins match are taken from the branch side and regenerated. When nothing
  else conflicts, `bl` commits the merge and the repo is `merged`; otherwise it
  stays `conflicted` with only the files left to merge by hand, which go to the
  resolution agent below, and any escalation also lists the regenerated files
  and any plugin that failed, with its output.
- When no repo conflicts but some took commits, the test gate (`runTestGate`)
  runs on the integrated tree of every repo and writes its `## Gate` line.
  Green pushes every branch with commits its origin lacks (`git push origin
HEAD`): one merged or committed on by a session, and one an earlier
  rejected push left behind, so the PR shows what merges; a failed push stops
  the merge with the merge kept on the branch, and the rerun pushes it. A
  misconfigured gate escalates.
- **The resolution agent** (F-36 D6). A repo still conflicted after the
  `regenerate` stage, or a red gate after clean merges, goes to one
  `merge-resolve` session for the unit (`resolveIntegration`): `workon` mode
  on `agent` (the implementer's permissions), in the lead worktree. Its
  `{{mergeRepos}}` names per repo the worktree, the ref, each conflicted file
  with both sides' commits since the merge base (`main: <sha> <subject>`,
  `branch: <sha> <subject>`) and the regenerated files it must not edit;
  `{{gateFailure}}` carries a red gate's details (command, log, excerpt). It
  resolves keeping both sides' intent, commits each merge with
  `git commit --no-edit` (fixes as ordinary commits on top), never touches a
  main checkout, and writes `## Escalation` when it cannot. After it, each
  repo must have no `MERGE_HEAD`, an empty `git ls-files -u`, the ref merged,
  and no conflict marker (`git grep -nE '^(<{7}|>{7})( |$)' <merge> --
<files>` in each merge since the integration began, over the conflicted
  files and those a retained resolution merged); a failed session, an escalation or any failed check runs
  `git merge --abort` where a merge is still in progress, rolls back and
  escalates `merge with main: <what failed>, and the resolution agent did not
resolve it`, with what bl found, the agent's last line and where its
  commits are kept (`git reset --keep <sha>` restores them). A merge that
  failed with no conflicted file (git refused to start it) has nothing to
  resolve and escalates `merge with main: <repo> conflicts with main` as
  before.
- Then the test gate runs with its fix step (`testGateWithFix`, as in
  `bl run`; its escalations read `merge with main: …` and name `bl merge`),
  and **one review round over the resolution only** (D7, see `## Review
Cycle`): per repo `git show --remerge-diff <merge>` and
  `git diff <merge>..HEAD` (`resolutionScope`), and for a repo current with
  main that a session committed in, `git diff <start>..HEAD`. `addressed`
  pushes and the merge goes on. `pending` escalates `merge with main: the
review of the resolution left open items` with the open items and keeps the
  resolution on the branch with `review_status: pending`: clear
  `## Escalation`, then `bl run <id> --resume` fixes it through the ordinary
  loop and `bl merge <id>` integrates again. The round is outside the round
  cap, and the run state records it (`integrationReview`), so the resume owes
  it its fix and a closing round below, at or above the cap. Anything else
  (an aborted round, no verdict, or `addressed` with an escalation written
  during the round) rolls back and escalates. A clean merge or a regeneration
  alone is never re-reviewed.
- Every escalation names, per repo, the ref, the conflicted files with both
  sides' commits, and the next step (D8); what an agent wrote in
  `## Escalation` during the merge is kept below bl's text ("Written during
  the merge:").
- Every stop before the push, except the `pending` review, rolls back the
  merges it made and every commit a session made in any repo, current ones
  too (`git reset --keep` to each repo's start), so each branch is left as it
  was reviewed and the rerun integrates and gates it again. A stop by any
  thrown error, not only a session that could not run, aborts every merge in
  progress, rolls back and escalates under the run lock, with the conflict
  evidence read before the abort (what the resolution recorded, else each repo
  still mid-merge); when that escalation cannot be written, the log carries
  it. A roll back that
  fails is named in the escalation (never "rolled back") and recorded in the
  run state (`integrationRetained`, each repo's start): the rerun counts what
  is left as its own merge, gates it before it can land, and rolls back to
  that start. When a resolution or fix session had run, the record says so
  (`review`, with the files the resolution was to merge), and the rerun owes
  that work the resolution checks, the gate with its fix step and an
  `addressed` review of the resolution (no new session when nothing else
  conflicts) before it can land; a `pending` review keeps it on the branch as
  above and clears the record.
  `bl merge` then exits 1 having touched no main checkout. The sessions run
  headless unless the agent has no headless mode, as `bl review` chooses.

**A failed merge into `main` is aborted** (F-36 D9). `cleanupOneRepo` keeps
`git merge --no-ff`; when it fails, `abortFailedMerge` runs
`git merge --abort` (when there is a `MERGE_HEAD`), then checks there is no
`MERGE_HEAD` and no tracked change (`git status --porcelain
--untracked-files=no`) and reports `main moved since the branch was
integrated; rerun \`bl merge <id>\``. When the abort fails, or the checkout is
not clean after it, it prints the exact `git -C <repo> merge --abort`to run.
The rerun integrates the moved`main` again.

After the merge the branch's open PR, if any, is closed through
`change.find` and `change.close`.

`bl merge F-<n>` also updates the feature order (F-53 D1): in the lock hold that marks the
feature done, `recordFeatureOrderMerge` drops its entries from `feature-order.md`'s `ranked:`
(through `serializeFrontmatter`) and appends `- <date>: F-<n> done (<title>).` to
`## History`; the sync after it rewrites the tables, and the merge's backlog commit takes the
file. A missing or malformed `feature-order.md` is a warning and the merge completes, since the
repos are merged by then. In the same hold, `recordThemeState` (`theme.js`, F-53 D4) appends
the same line to the `## State` of the feature's theme, creating the section at the end when
absent and writing the frontmatter back byte for byte; the commit takes the theme file too. A
feature whose theme is missing or unreadable only warns.

### `bl updates`

Renovate's dependency updates as backlog stories (F-32). Renovate opens the
branch and the PR and, at the end of each cycle, writes a report
(`backlog.json` `updates.report`, relative to the backlog's parent directory, for
example `renovate/reports/renovate-report.json`, F-50 D3) listing every
branch it manages with its PR number, title and upgrades. `bl updates sync`
turns that report into stories; `bl updates run` rebases, gates and merges
them; `bl updates status`, `approve` and `drop` (`src/updates-answer.js`)
are the operator's answer: one report per run, one or two commands back.
`approve` and `drop` are requests the runner's next `run` executes (F-50
D8): the operator's workstation runs no gate, merge or close.

```bash
bl updates sync                              # the report updates.report names
bl updates sync --report ./report.json       # a dated copy, or a fixture
bl updates sync --dry-run                    # print the plan, write nothing
bl updates run                               # every refined/in_progress update story
bl updates run S-840 S-841 --max-merges 3    # only these; at most 3 merges per repo
bl updates run --dry-run                     # print the order, touch nothing
bl updates status                            # open update stories by repo and state
bl updates status --json                     # the same as JSON
bl updates approve S-840                     # request: the run regates it, merges on green
bl updates drop S-841 --reason "not now"     # request: the run closes the PR, supersedes it
```

Rules (`src/updates.js`, F-32 Design D2 and D3):

- A branch is **open** when the report gives it a `prNo`; the rest wait
  (`pending`, `needs-approval`, `not-scheduled`) and get no story. The
  report, not the forge, says what is open.
- One story per open branch, keyed by `update_repo` (the forge slug) and
  `update_branch`, filed in its repo's home component (`home: true`, F-49 D4);
  a repo with no home component is skipped with a warning, and
  `updates.epic` is no longer read. A slug maps to a checkout only when it
  is exactly `<updates.namespace>/<repo>` for a repo `repos` lists
  (`repoForSlug`): `attacker/bl`, a nested path or a case variant is an
  unknown repo, never the registered `bl`. Open and no story: created from
  `templates/story-update.md` as `type: chore`, `status: refined`, the PR
  title as title, in the repo's home component (whose repo is the story's;
  no `primary_repo` is written), points 1 (3 when any upgrade is a
  major), `update_pr`, `update_head`
  (from `git ls-remote --heads origin`), `update_security` when an upgrade
  carries Renovate's `isVulnerabilityAlert` or the PR carries the `security`
  label (`change.find`, asked only for a new or renumbered PR), and
  `plugins` from the repo's `update_tests` in `backlog.json` `repos`.
  The body holds a summary, the upgrades table, the acceptance list and
  empty `## Gate result`, `## Release notes` and `## Decision needed`
  sections for the run.
- Open and a story exists: title, points, `update_pr`, `update_head` and the
  upgrades table are updated where they changed; status and the run's
  sections are kept. A closed story (`done`, `superseded`) counts only for
  the same PR number, so a PR Renovate recreates gets a new story.
- A story whose branch, or whose PR number, has left the report is marked
  `superseded` with the note "gone from the report: merged or closed on the
  forge" under its Summary. Only repos the report covers are closed this way;
  a repo Renovate did not reach keeps its stories.
- A repo slug `backlog.json` does not know is skipped with a warning, never a
  story. A missing report file (`loop.sh` deletes it before each run) means a
  run is in progress or failed: sync says so and exits 0 (the message is
  `no report: run in progress or failed`). A report of the wrong shape
  (`validateReport`: `repositories` not an object, a repository without an
  explicit `branches` array, a branch that is not an object, a `branchName`
  that is missing, empty or not a string, a `prNo` that is neither absent,
  null nor a positive integer, a `prTitle` that is not a string, `upgrades`
  that are not an array of objects) is refused before any story is created,
  updated or closed; only an explicit `branches: []` closes a repo's stories,
  and only an absent or null `prNo` reads as "not open".

The run (`src/updates-run.js`, F-32 Design D4, F-50 D5) is a state machine
like the feature loop, with no LLM: git, the gate's commands, forge ops and
the bell go through an injected runner, and every outcome is read from files.
It holds `.bl/run/updates.lock` (the lock `sync`, `approve` and `drop` take
too, before any story is read, so one command at a time rewrites stories or
touches the forge; a command that meets another is refused) and takes
stories with an operator's `update_request` first, then `update_security`
stories, then repo by repo (by repo name), oldest story first, one branch
at a time per repo, so each branch is rebased on the `main` the previous merge
produced. Per story:

1. `git fetch origin main <branch>`; the fetched head becomes `update_head`.
   A story whose `## Gate result` says `Red` at that same head and that same
   `origin/main` is **skipped**: nothing changed since. A Renovate rebase
   changes the head, a merge changes main, and either one gates it again (a
   red that was main's clears once main is repaired). A `Conflict` is
   retried: main may have moved.
2. A detached worktree at `worktrees/<story-dir, lower case>/<repo>` on
   `origin/<branch>`, rebased onto `origin/main`. A conflict aborts the rebase,
   records `conflict, left for Renovate` and holds the story; the remote branch
   is untouched.
3. The gate, in order, stopping at the first failure: a frozen install when
   the worktree has a lockfile (`pnpm install --frozen-lockfile` or `npm ci`,
   so a stale lockfile fails here), then the repo's `bootstrap` plugins (one
   step each, `bootstrap plugin <name>`, resolved through the same cascade as
   a story worktree's: backlog index, the story's repo entry, its component,
   the story; none is the log note
   `no bootstrap plugin for <repo>: stage skipped`),
   `<roostDir>/ci-cd/bin/ci gate` when it has a `.ci-cd.json`, then the test
   plugins the story names (`plugins:`, from the repo's `update_tests`). Both
   plugin stages get `{{sessionNum}}` / `{{sessionId}}` set to the story's
   number, as a story run does, plus `{{repoPath}}` / `{{repoName}}`. A
   failing bootstrap step, a missing binary included, is red like any other
   step: no soft skip. An unknown plugin or an unresolved placeholder in
   either stage is a broken gate, never a green one. After each step the
   worktree must still be the rebased commit the merge publishes: a step that
   moves HEAD or leaves a staged or unstaged change to a tracked file is red
   (ignored and untracked build output is fine). The whole output goes to
   `.bl/run/updates.<S-id>.gate-<n>.log`; the last 30 lines go under
   `## Gate result` after a record line
   `<Green|Red|Conflict> · <time> · Renovate head `<sha>`· main`<sha>` · <detail>`.
4. A major (an upgrade row of type `major`) takes the same gate and merges
   on green; nothing assesses it. A red major is held like any red, with
   the PR body from the forge op `update.notes` (Renovate's release notes)
   fenced under `## Release notes` beside `## Gate result`: the migration
   story starts there. A missing or failed op writes a one-line note in that
   section instead and the run goes on. Its outcome reason starts `major, `.
5. Merge, for a green gate: the repo's main checkout must be on `main`
   with no uncommitted tracked changes (else the story is held and nothing
   is touched); `git merge --ff-only origin/main`; the final head is pushed
   to the Renovate branch with `--force-with-lease` on the fetched head (so
   the forge marks the PR merged, and a branch Renovate moved meanwhile is
   left alone);
   `git merge --no-ff <sha> -m "Merge branch '<branch>' into main (S-n)"`;
   the PR marked ready through the forge op `change.ready` (Renovate opens
   drafts, F-50 D6; a no-op on a ready PR, and a failure is a note on the
   story, not a hold);
   `git push origin main` (a failed push resets local main to where it was;
   every rollback the run makes, the merge abort and that reset in the main
   checkout and the rebase abort in the worktree, is checked, and
   one that fails is reported on the story with what the checkout is left
   holding, never claimed);
   the merge commit written to the story (`recordMerge`: from here the merge
   is a fact on the forge, whatever fails next);
   `git push origin --delete <branch>`. The story is `done` with `commit` and `completed`, its
   acceptance boxes checked; a `## Decision needed` asked on an earlier run
   (a held security update whose branch then moved) gets a dated "merged by
   the run" line. A deletion that fails leaves the story `in_progress` with
   `commit` set and the branch box unchecked (the report lists the merge,
   with the failure); the next run or `approve` only finishes it
   (`finishMerge`: `ls-remote --exit-code`, `push --delete`, done), never
   gating or merging it again, and the sync marks it `done` when its branch
   leaves the report. When the write of `commit` itself fails (or the run
   dies between the push of main and that write), the merge commit on
   `origin/main` is the record: the next run finds it by its message
   (`mergeOnMain`: `git log --merges --fixed-strings --grep`, right after
   the fetch and before any gate) and finishes the story the same way. A
   run that throws after a merge (a story write, the output stream) still
   appends its report and commits what changed before the error surfaces.
6. Everything else is `in_progress` with the evidence under `## Gate result`.
   A held security update gets a mechanical `## Decision needed` (rule,
   options A approve / B drop, the question).
   `--max-merges <n>` (default 10) caps merges per repo per run; a story past
   the cap is skipped untouched.
7. One report per run is appended to `updates/<YYYY-MM-DD>.md`: an
   `## Approve S-<n> · <time>` or `## Drop S-<n> · <time>` entry per request
   the run executed, then `## Run <time>` (merged with packages and commit,
   held with reason, decisions needed, skipped), committed with the changed
   stories through `syncAndCommit`; then the tmux bell. A run with nothing
   open still writes `## Run <time>` (`No open update stories.`): it is the
   heartbeat `bl inbox` reads. stdout: one line per story (`merged`,
   `dropped`, `held`, `decision`, `skipped`, or `would run` with
   `--dry-run`).

Requests (F-50 D8). A requested **approve** is the machine above with the
approve flag: a known-red head is gated again instead of skipped, a green
gate merges whatever `## Decision needed` says (a decision asked gets a
dated "approved by the operator" line), a red gate holds the story as a run
would. The request is cleared once the gate gave a verdict (or the rebase
its conflict); one that never reached the gate (a failed fetch, a dirty main
checkout) stays for the next run. A requested **drop** (`dropStory`) marks
the story `superseded` with `update_request_reason` under its Summary (and
under `## Decision needed` when one was asked), clears the request, then
closes the PR through the forge op `change.close` with the reason as the
comment. The story goes first so a failure after the close never leaves an
open story for a closed PR; a forge that is not configured or a failed close
puts the story back, request and all, and the story is held for this run.
Renovate does not reopen a PR a user closed, and the sync keeps the
superseded story for that PR number. A drop on a story already merged
(`commit` set) only finishes the merge.

The operator's answer (`src/updates-answer.js`, D4's last step):

- `bl updates status [--json]` lists every open update story (`refined` or
  `in_progress`) by repo, security first, then oldest first, with a state read
  from the story alone: `skipped` (its repo is not in `backlog.json`),
  `approve pending` / `drop pending` (an `update_request` the runner has not
  executed yet; a drop's detail is its reason),
  `decision needed` (`## Decision needed` has content; the detail is its
  question), `new` (no `## Gate result` record yet), `green` (the last gate
  was green but the story is open: a failed merge, or a merge whose remote
  branch is still to delete, with the commit
  in the detail), `held` (the last gate was red or the rebase conflicted;
  the detail says whether the branch has moved since). The last line names the newest
  report under `updates/` and its last entry. `--json` emits
  `{ stories, last_report }` with the same fields.
- `bl updates approve S-<n>` and `bl updates drop S-<n> --reason <text>`
  (`requestUpdate`) write `update_request: approve` or `drop` (a drop also
  `update_request_reason`; an approve removes it) and commit through
  `syncAndCommit`, which pushes. Nothing is gated, fetched, merged or
  closed, and nothing goes in the report: the runner writes it when it acts.
  A second request replaces the first. Refused for a closed story, an id
  that is not an update story, a repo not in `backlog.json`, and (drop) a
  story with no `update_pr` or one merged already. Both take the run lock
  before reading the story, as the sync does, so a local sync is not raced.

Changes are synced and committed on the backlog's current branch
(`syncAndCommit`), as `bl new` does, under one lock hold from the first read.
A second sync on the same report changes nothing.

A `bl` that runs from a bl worktree (`<root>/<branch>/bl` or a path in it,
`foreignCheckout` through `isBlBranchPath`) refuses `sync`, `run`, `approve` and `drop` against the
backlog it found; a dry run is allowed. Every test and every check of a
branch uses a temporary backlog (`mkTempBacklog`, or `runBl` with
`BL_BACKLOG_DIR`) with the runner, git and the forge stubbed, never the
real backlog: on 2026-10-13 a session that simulated the host unit from
a worktree merged four Renovate PRs for real.

### `bl block`

Files, lifts and lists the holds in `blockers.json` (F-66 D4, `src/block.js`; see **Holds
between units**).

```bash
bl block add S-1 --gate merge --unit F-3 --until done     # F-3 does not merge until S-1 is done
bl block add S-1 --gate run --unit '*' --until done --active-when F-54 --active-status done
bl block remove S-1 --gate merge --unit F-3               # operator only
bl block list F-3        # edges on F-3, on its stories, on *, and by F-3: met, unmet or inactive
bl block list --fix      # rewrite a hand-edited blockers.json sorted, and commit it
```

- **`add`** checks every field (`edgeProblems`: known ids, a gate the unit's type has, `until`
  and `--active-status` statuses of their units' types, a blocker not already closed short of
  `until`), refuses a duplicate and an edge that
  would close a cycle in the hold graph (`wouldCycle`; an edge not yet active adds no arc, and
  `bl validate` reports the cycle once it is). It takes the backlog lock, rereads the file,
  writes it sorted and commits `blockers.json` alone as `chore: block <unit> at <gate> on
<blocker>`. stdout is `blocked: <unit> at <gate> by <blocker> until <status>`; every refusal
  is one `bl block add: <reason>` line on stderr and exit 1.
- **`remove`** drops the edge with that identity and commits `chore: unblock <unit> at <gate> on
<blocker>`; an unknown edge refuses. Agents may not run it: `MODE_DENY` in
  `src/allowed-tools.js` denies `bl block remove:*` in every mode (F-66 A7, generator v14),
  while `bl:*` keeps `add` and `list` allowed. `bl task done:*` is denied beside it (F-65 D3,
  generator v15).
- **`list [<id>]`** prints one line per edge on and by the unit (every edge without an id):
  `<unit> held at <gate> by <blocker> (<status>, needs <until>): <met|unmet|inactive>`, with
  `, active when <id> is <status> (<its status>)` for an `active_when` edge.
- `add`, `remove` and `list --fix` pull the backlog first (`commandPullsBacklog`) and commit
  `blockers.json` alone under the backlog lock; a backlog that is not a git repo is written
  and not committed. A missing or unreadable `flow.json` stops `add` and `list` with the
  `FlowError`; an unreadable `blockers.json` stops every subcommand with the `BlockersError`.

### `bl inbox`

Everything waiting on the operator, in one list (F-42 Design D1,
`src/inbox.js`). It scans the backlog on every call (no index) and prints
the groups below, each by unit id, newest first, features before stories:

| Kind         | Source                                                                                                                                                                                 | Id           | Answered by                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------- |
| `escalation` | an active (not `done` or `superseded`) feature's or story's `## Escalation` with content                                                                                               | `F-42:esc`   | `bl status F-42`                                            |
| `task`       | an open task (`tasks/`, see **`bl task`**) of any unit, open or closed, with a `holds:` line per edge of it in `blockers.json` that holds now                                          | `T-7`        | `bl task done T-7 [note]`                                   |
| `change`     | unmerged work (F-48 D4): an open feature, or an open story with no `feature:`, whose current change document is `status: open` and names a branch with commits ahead of `main` (below) | `S-7:change` | `bl run S-7`; `bl merge S-7` once its review is `addressed` |
| `update`     | an F-32 update story in the `decision needed` or `held` state of `bl updates status`                                                                                                   | `S-842`      | `bl updates approve S-842` / `drop … --reason`              |
| `pending`    | an update story in the `approve pending` or `drop pending` state: it waits on the runner, not on the operator (F-50 D8)                                                                | `S-842`      | nothing: the runner's next `bl updates run`                 |

One more line comes first, `runner: no bl updates run since <time> …`
(kind `runner`, id `updates:run`), when the newest `## Run <time>` heading
under `updates/` (`lastRun`: the newest report holding one) is more than 8 h
old, twice the runner's cadence (F-50 D7); none when it is newer or when no
report holds a run. A `pending` item is not counted by `inboxCountLine`.

A `change` item is one per unit, naming every repo with unmerged commits:
`tools, web: <title> · tools 2 commit(s) on <branch>, web 1 commit(s) on <branch>, not merged`
(one repo: `tools: <title> · 1 commit(s) on <branch>, not merged`). Each repo a candidate names
is read once in its main checkout (`git for-each-ref refs/heads`), and `git rev-list --count
main..<branch>` runs only for a branch that exists. A story with a `feature:` is left out (it
merges with its feature), and so is a change document with no branch, a branch that is gone or
level with `main`, and a done, superseded or merged unit. The next verb is `changeNextVerb`
(`src/change-doc.js`), the rule `bl review`'s summary line uses. A repo git cannot read is a
warning on stderr; the other items are still listed.

```bash
bl inbox                          # the groups, each item with its id, unit, first line and next:
bl inbox --json                   # [{ kind, id, unit, line, holds?, next, path }]
bl inbox done T-7                 # refuses: "T-7 is a task: close it with bl task done T-7 [note]"
```

A `task` item is `T-<n>  <unit>  <title>`, then one `holds:` line per edge whose blocker is the
task and which holds now (active, unmet), in the words of the `## Tasks` table without its
`once …`: `holds: bl merge F-53`, `holds: bl run, bl implement (every unit)`; a `next` task whose
unit is still open has none. Then `next: bl task done T-<n> [note]`. The inbox reads tasks from
their files and the holds from `blockers.json`, never from a unit's body; a `blockers.json` or
`flow.json` it cannot read is a warning, and the tasks are listed without holds.

`bl inbox done` closes nothing (F-65 D3): every id exits 1 naming the verb that answers it, a
`T-<n>` and a retired `F-<n>:op<k>` id `bl task done` (an alias would be a second way to close a
task), an escalation, change, update or pending id its own; an id not in the inbox is unknown.

The S-970 operator tasks (a `### Operator tasks` sub-list, or legacy `operator:` bullets, in a
unit's `## Deferred` / `## To Do`) are retired: nothing in `bl` reads a body for tasks, an open
unit that has one fails `bl validate` (`operator-tasks-retired`), and a closed unit keeps its
items as history. Their reader, `scanOperatorTasks`, went with F-65's migration (S-581).

- `bl status` prints `deferred: <n> items` (the section's top-level items, through
  `scanDeferred`, a closed unit's retired operator items not among them) and, for a unit with
  tasks, `tasks: <n> open, <m> done`; the `held:` lines show what the tasks hold.
- The one-off migrations that moved the backlog to this shape
  (`migrate-taxonomy`, `migrate-value-axis`, `migrate-operator-tasks`,
  `migrate-feature-secondary-repos`, `migrate-repo-fields`) have run on the live
  backlog; F-62 removed them, with `migration-write.js`, since each read and wrote the
  frontmatter format F-62 retired (they are in git history before F-62). F-53's
  `migrate-roadmap` and F-65's `migrate-tasks` have run too; S-581 removed them, since they
  moved one backlog's own documents (in git history before S-581).
  `migration-txn.js` (fetch, refuse unless clean at `origin/main` with no `bl` run active,
  write, one commit, git rollback) carries F-62's `migrate-frontmatter-yaml` and F-60's
  `migrate-worktree-layout`.
- `bl run` and `bl merge` end with `inbox: <n> item(s) need you (bl inbox)`
  on stderr when the count is non-zero (`printInboxCount`). A failed scan
  prints nothing and never fails the command.
- When the update stories cannot be read (no `updates.namespace` in
  `backlog.json`), `bl inbox` warns on stderr and lists the rest.

### Testing

bl uses Node's built-in `node --test` runner with bash-driven CLI checks
where invoking the real binary is the point. There are no test framework
dependencies — `node:assert/strict` is sufficient.

Layout:

```
test/
  helpers/         # shared test helpers
    run-bl.js      # spawnSync wrapper around bin/bl with BL_BACKLOG_DIR;
                   # startBlBehindLock() spawns bl and resolves on its announced lock wait;
                   # lockOwnerVisible(t) skips a lock-wait test where a child can't see
                   # this pid (fails instead under BL_REQUIRE_PID_TESTS=1)
    tempdir.js     # mkTempDir(prefix) — a temp dir removed when the test process exits;
                   # mkTempBacklog() — scaffolds a tempdir backlog the same way
    token-writer.js    # startTokenWriter() — a node child holding a spec lock (unit lock tests)
    sample-backlog.js  # 2-component / 4-story chain used by graph tests
    tempdir.sh     # bash equivalent for cli/ + e2e/
  unit/            # node --test, pure functions, in-process
  integration/     # node --test, spawns bl against a tempdir backlog
  cli/             # bash, asserts stdout/stderr/exit-code contracts
  e2e/             # bash, full lifecycle incl. git worktrees
```

Run:

```bash
npm test            # unit + integration + cli   (under 30s on a laptop)
npm run test:unit
npm run test:integration
npm run test:cli
npm run test:e2e    # separate — uses git worktrees
npm run test:all    # everything
```

Adding a test:

- **unit** — write `test/unit/<module>.test.js` using `node:test` and
  `node:assert/strict`. Import the module under test from `../../src/...`.
  No fs writes outside `os.tmpdir()`. No spawning, with one exception: a
  test of a spec-lock overlap may start the second lock holder as a `node`
  child — `startTokenWriter` (`test/helpers/token-writer.js`), which runs
  `updateSpecFile` from `src/`, or a bare live pid to stand for a holder.
  `withSpecLock` is re-entrant within a process, so only another pid can
  hold the lock against the code under test, and the writers whose overlap
  matters (the loop's escalation and status writes) are driven only by the
  unit tests' fake runner, which an integration test spawning `bl` cannot
  reach (F-67). Make every temp dir with
  `mkTempDir(prefix)` or `mkTempBacklog()` from `test/helpers/tempdir.js`,
  never a bare `mkdtempSync`, so the dir is removed when the file's tests end.
- **integration** — write `test/integration/<command>.test.js` that
  `mkTempBacklog()`s a backlog and `runBl(args, { cwd })`s the binary
  against it. Assert filesystem effects, frontmatter, and exit codes.
- **cli** — write `test/cli/<topic>.sh`. Source `helpers/tempdir.sh`,
  call `mk_temp_backlog`, then drive `"$BL"` with the assert\_\* helpers.
  `cli/run-all.sh` picks it up automatically.
- **e2e** — write `test/e2e/<scenario>.sh`. `git init` your own tempdirs
  for the code repos and a bare origin if cleanup paths are exercised;
  set `BL_BACKLOG_DIR` to the backlog tempdir.

`bl new` exposes private test seams `BL_INTERNAL_TEST_FAIL_ON_STORY` and
`BL_INTERNAL_TEST_FAIL_ON_MOVE` for unwind-path coverage. They are not
public CLI surface — change or remove them freely if a test stops needing
them.

## Conventions for Agents

- **Custom formats and parsers: argued and approved one at a time** (operator rule,
  2026-10-25). A custom format or hand-written parser needs a compelling argument, that
  argument written down where the format lives, and an operator approval given for that one
  format specifically, in a question and answer of its own, never as a line in a list of
  approvals or inside another request. Without all three, use the standard format and its
  library, dependency or not. "It already exists" or "it is small" is not an argument; say
  what the standard format and its library fail to do here.
- **A child's stdin text, and any captured stream of a Node child, go through files**
  (F-70 D1): call `spawnSyncFiles` (`src/child-stdio.js`), a drop-in for `spawnSync`, never
  `child_process` with an `input:` option or a `'pipe'` stream to a Node child
  (`process.execPath`, `node`, `bl`). Node connects `'pipe'` and `input:` over a socketpair.
  Inside Codex's sandbox `shutdown(2)` is refused, so `input:` never reaches EOF and the call
  hangs, and a Node child on a socket gets dummy stdio: its output vanishes and the parent
  reads `""` from a child that exited 0. Non-Node children (`git`, `rg`) may keep `'pipe'`
  for stdout and stderr: they work there. A synchronous call never leaves stdin `'pipe'`
  (its default) either: Node ends it with the same refused `shutdown`, the call reports
  `EPERM` from a child that succeeded, and `execFileSync`/`execSync` throw it. Give it
  `stdio: ['ignore', 'pipe', 'pipe']`. A command whose output `bl` reads and that may be a
  Node program (a configured forge op) goes through `spawnSyncFiles`. Tests start an asynchronous Node child with
  `spawnToFiles` (`test/helpers/spawn-files.js`) and watch its files; a live two-way
  protocol with a Node child (the fake `codex app-server`) uses `fs.readSync(0)` and
  `fs.writeSync(1)` in the child. `test/unit/child-stdio-guard.test.js` parses `src/` and
  `test/` with `acorn` and fails on each of these shapes at a `child_process` call.
- Frontmatter is YAML (failsafe schema), read and written only by `parseFrontmatter` and
  `serializeFrontmatter` (see **Frontmatter is YAML**). Never read a frontmatter line with a
  regex or write one as text.
- **Never** hand-edit the generated tables in `index.md` files — always edit story frontmatter
  then run `bl sync`.
- `story_id` format is always `S-<number>` with a hyphen (e.g. `S-40`). Directory names omit
  the hyphen (e.g. `S40-my-feature/`).
- Points use the Fibonacci sequence: 1, 2, 3, 5, 8, 13. Never use other values.
- Only set `status: done` after a real commit exists. Set `commit` and `completed` simultaneously.
- A story, component or feature directory never moves: status is frontmatter. Do not
  create `.completed/` directories; bl does not read them.
- **Commit story edits with `bl validate`, then `bl sync --commit`.** Run `bl validate`
  until it is clean on the stories you touched (surface, do not fix, findings on others),
  then `bl sync --commit -m "<msg>" --story <each story you created or edited>`. Put the
  why/how in the commit message, never in new frontmatter keys. Never run raw
  `git add` / `git commit` in the backlog repo: the lock makes concurrent and batch syncs
  safe only when every agent commits through it. `bl merge` still runs the authoritative
  sync after merge. The prompts carry this flow as `{{validateBeforeSync}}`
  (`prompts/_validate-before-sync.md`), and every run-loop prompt that commits the backlog
  (`story-run.md`, `feature-story.md`, `review-verify.md`, `_blocked-by-bug*.md`, …) names
  its exact `bl sync --commit` line (`--path` for a feature file), so the rule and the
  prompts agree; `test/unit/feature-prompts.test.js` fails on a raw
  `git -C {{backlogDir}} add|commit` in any prompt. In headless sessions the bash-shape
  guard also denies a pathspec-less or `-a` `git commit` in the backlog (see below).
- **NEVER `git add` files that are in `.gitignore`** (e.g. `.env`, credentials). Create
  them in the worktree but do not commit. File a task for the operator
  (`bl task <unit> --gate none`) noting the file path and its destination.
- The backlog path comes from `backlog.json` — do not hardcode paths like `docs/backlog`.
- For other backlog git operations from a code worktree (status, log, push), use
  `git -C <backlogPath> ...` (no `cd`). The backlog repo is shared and uses an unstable
  `main` — direct commits and pushes to backlog `main` are expected; do NOT create
  branches or worktrees in it.
  (When your working directory is already the backlog repo — e.g. `bl merge` triage —
  run plain `git` commands; `git -C` is unnecessary there.)

## Prompts

Prompt content lives in `prompts/<name>.md`. `loadPrompt(name, vars,
{ agent, config })` in `src/session.js` reads the file, interpolates
`{{vars}}`, and substitutes agent-specific tool names supplied by the
provider's `getToolHints()`.

### Fragment convention

Files whose name starts with `_` are **fragments** — meant to be
included via `{{slot}}` injection, not loaded as top-level prompts:

| Fragment                         | Purpose                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_tool-guide.md`                 | The shared tool-usage / format / lint / PR / on-PATH block. One per top-level prompt.                                                                                                                |
| `_dedicated-tools.md`            | The "use dedicated tools instead of shell equivalents" bullet list.                                                                                                                                  |
| `_ide-hints.<surface>.md`        | Optional host-surface hints injected at the end of `_tool-guide.md`.                                                                                                                                 |
| `_working-dir-unit.md`           | `{{workingDirectory}}` in `_tool-guide.md` when the session has a `unitDir`: the unit directory is the working directory, each repo's worktree `{{unitDir}}/<repo>` (F-60 D3).                       |
| `_working-dir.md`                | `{{workingDirectory}}` for a session with no unit directory (refine, triage).                                                                                                                        |
| `_blocked-by-bug.md`             | `{{blockedByBug}}`: fix a blocking bug with an ad-hoc story, keep going.                                                                                                                             |
| `_blocked-by-bug-story.md`       | `{{blockedByBug}}` when `unitKind` is `story` (`bl run S-n`): fix the bug, note it in the story's `## Notes`; a story has no feature to hold an ad-hoc story.                                        |
| `_escalation.md`                 | `{{escalationGuide}}`: the shape of an escalation the operator can read at a glance.                                                                                                                 |
| `_validate-before-sync.md`       | `{{validateBeforeSync}}`: `bl validate` until clean, then a locked `bl sync --commit`. Every story-editing prompt carries it.                                                                        |
| `_side-changes.md`               | `{{sideChangeGuide}}`: a change outside the unit's repos is a `bl side --from {{sideFrom}}` story, never a hand-made worktree, PR or operator task. Refine, workon, `feature-story` and `story-run`. |
| `_self-consistency.md`           | `{{selfConsistencyGuide}}`: derive from what the system already defines, never restate it. Refine, workon, `feature-story`, `story-run`, `review-correctness` and `feature-self-review`.             |
| `_cd-git-guard-deny.md`          | Deny message for the cd-then-git Claude hook.                                                                                                                                                        |
| `_cd-search-guard-deny.md`       | Deny message for the cd-then-search Claude hook.                                                                                                                                                     |
| `_cd-guard-deny.md`              | Bash-shape hook: `cd <path> && <cmd>` (cmd not git or a search tool).                                                                                                                                |
| `_env-prefix-guard-deny.md`      | Bash-shape hook: a bare `VAR=val cmd` prefix.                                                                                                                                                        |
| `_shell-construct-guard-deny.md` | Bash-shape hook: loops, variables used after assignment, `$(…)`/backticks.                                                                                                                           |
| `_backlog-commit-guard-deny.md`  | Bash-shape hook: a `git commit` in the backlog repo with no pathspec or with `-a` / `--all` / `-i` / `--include`.                                                                                    |

Top-level prompts (`workon.md`, `refine.md`, …) reference fragments
through interpolation slots — most importantly `{{toolGuide}}`, which
renders `_tool-guide.md` against the live `plugins`, `language_dispatch`,
and `forge` registries. Swapping `plugins.md.format` in `backlog.json`
changes what the agent reads with no source or prompt edit.

### `renderToolGuide(config, toolHints, vars, agent)`

Implemented in `src/tool-guide.js`. Builds the four config-driven slots:

| Slot                   | Source                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `{{toolUsageHint}}`    | `_dedicated-tools.md` with `{{readTool}}` / `{{editTool}}` from `getToolHints()`.  |
| `{{formatExamples}}`   | `language_dispatch.format` × `plugins[name].format` — `<ext> → <command>` bullets. |
| `{{lintExamples}}`     | Same shape for `language_dispatch.lint`.                                           |
| `{{prOps}}`            | `plugins[<forge>].pr.*` ops (sorted, only configured slots).                       |
| `{{toolsOnPath}}`      | Union of first-token leaders across every plugin + forge command + baseline.       |
| `{{ideHints}}`         | Optional `_ide-hints.<surface>.md` fragment for the resolved host surface.         |
| `{{workingDirectory}}` | `_working-dir-unit.md` with `vars.unitDir`, else `_working-dir.md`.                |

Optional sections that have no config render `_(none configured)_`
rather than blowing up — keeps the prompt usable during landing windows
where a backlog hasn't declared every registry slot yet. A plugin leader
that starts with `{{roostDir}}` reaches `{{toolsOnPath}}` templated
(`commandLeader` keeps a leading `{{var}}` token intact) and the
`{{roostDir}}` slot, interpolated after it, turns it into the real path.

### Hook deny messages

`src/agents/claude.js` installs PreToolUse Bash hooks that deny the
chdir-then-tool pattern (a chdir followed by git or a search tool). The
English deny text lives in
`prompts/_cd-git-guard-deny.md` and `_cd-search-guard-deny.md`;
`loadHookDenyMessage(name, agent)` reads the file and the hook installer
JSON-stringifies + shell-quotes it into the wrapper. To tweak the
wording, edit the `.md` — no JS edit required. The `marker` field
(`bl:hook:cd-git-guard`, `bl:hook:cd-search-guard`) is the stable
identifier `upsertHook` uses to locate the existing entry on regen.

A third hook, `bl:hook:bash-shape-guard`, runs `node src/hooks/bash-guard.js`
instead of a grep. It parses the command (quotes,
heredoc bodies, comments) and denies four shapes a headless session can never
get approved: `cd <path> && <cmd>` (git and search tools stay with the grep
guards), a bare `VAR=val cmd` prefix, shell constructs (loops, a variable
assigned then used, `$(…)` / backticks) and raw `docker
restart|stop|start|exec|inspect|run|kill|rm`, the last only when the backlog's
`session_stack` guide has a `docker-guard-deny.md`, which is its message (see
**Session stack**; bl itself knows no session stack). A fifth rule, `backlog-commit`,
denies a `git commit` aimed at the backlog repo (one whose Git directory,
named by `--git-dir` or found from its working directory as git does, after
`-C`, `cd` and the payload's `cwd`, is the backlog's own, read from disk, so a
repository nested in the backlog is not the backlog) that has no pathspec or uses
`-a` / `--all` or `-i` / `--include`: the backlog's index is shared, so such a commit takes along what
other sessions have staged. `git commit [--only] … -- <paths>` and every other
git verb pass. The backlog root is the session's own, whatever its directory is
called: `BL_BACKLOG_DIR`, which bl sets on every agent it launches (the hook in
the shared settings names no backlog, so two backlogs never overwrite each
other's); the docker guide is read from it too, and its parent is `{{roostDir}}`.
Paths filled into a message are shell-quoted when needed. Without one both rules allow. It reads the matching
`_<rule>-guard-deny.md` when it fires, so a wording change needs no
reinstall; the `### Shell` table in `_tool-guide.md` mirrors the same
shapes. It parses conservatively and allows anything it cannot parse, and it
fails open (exit 0, no output) on any error. All three hooks are installed by
`bl init` into the user's `~/.claude/settings.json`, so every Claude Code
session runs them. The two grep guards deny everywhere; the shape guard denies
only in unattended print-mode sessions (`CLAUDE_CODE_SESSION_ATTENDED=0`, as
`claude -p` sets it), where nobody could approve these shapes. Interactively
the operator approves them, and denying there would block working commands.

### Session stack (`backlog.json` `session_stack`, S-581)

bl ships no session stack and no prose about one. A workspace that runs a
stack of services per agent session (an overlay of its application on
isolated data) names its own guidance in `backlog.json`:

```json
"session_stack": {
  "guide": "agents/session-stack",
  "allow": ["Bash({{roostDir}}/stack/scripts/*)"]
}
```

`guide` is a directory relative to the backlog (`src/session-stack.js`).
`loadPrompt` renders the `{{sessionStack}}` slot of `workon`, `story-run`,
`feature-story`, `feature-workon`, `feature-workon-review` and
`feature-fix-tests` from `<guide>/<prompt>.md`, else `<guide>/default.md`,
with the prompt's own variables (`{{sessionId}}`, `{{sessionNum}}`,
`{{worktreePath}}`, …); the tool guide's `{{sessionStackTools}}` from
`<guide>/tool-guide.md`; the bash-shape hook's docker message from
`<guide>/docker-guard-deny.md`. A missing file renders as "". `allow` tokens
join every session's allowlist (`getAllowedTools`), `{{roostDir}}` and
`{{backlogRoot}}` resolved like the generated file's. A malformed
`session_stack` makes `loadConfig` throw, naming the key.

### Per-agent variants

Fragments and top-level prompts can opt into agent-specific prose by
placing the agent registry key before the locale suffix:

```
prompts/
  _tool-guide.md             ← shared default
  _tool-guide.claude.md      ← Claude-specific (optional)
  _tool-guide.gemini.md      ← Gemini-specific (optional)
```

Use lowercase `<agentId>` values that match the provider registry keys
in `src/agents/index.js` (currently `claude`, `codex`, and `gemini`).
Unrecognized or malformed agent IDs are ignored for prompt lookup and
fall back to the shared chain.

When both agent and locale variants exist, the agent axis is more
specific than the locale axis. For a fragment named `_foo`, agent
`claude`, and locale `fr-FR`, the lookup order is:

1. `_foo.claude.fr-FR.md`
2. `_foo.claude.fr.md`
3. `_foo.claude.md`
4. `_foo.fr-FR.md`
5. `_foo.fr.md`
6. `_foo.md`

Per-agent variants are opt-in. The shared file remains the default and
continues to work for every agent.

### Surface variants

Surface variants are independent of agent identity. The agent axis
(`claude`, `codex`, `gemini`) changes tool names and agent-specific
prompt prose; the surface axis describes the host wrapping that agent,
such as `claude-code`, where slash commands and IDE behaviour may matter.

`resolveSurface(config)` in `src/surface.js` uses this precedence:

1. `backlog.json` top-level `"surface"` key
2. `BL_SURFACE` env
3. `CLAUDECODE=1` autodetect, which resolves to `claude-code`
4. no surface

Surface names are normalized to lowercase kebab-case. Empty strings,
`none`, and `null` resolve to no surface, so `BL_SURFACE=none` disables
autodetect for a session.

IDE hint fragments use the `_ide-hints.<surface>.md` naming convention
and are rendered into `{{ideHints}}` at the end of `_tool-guide.md`.
The fragment supplies its own heading and body; when no surface resolves,
the named file is missing, or the fragment is empty, the slot renders as
the empty string.

Localized variants stack on the same lookup chain:

```
prompts/
  _ide-hints.claude-code.md       ← shared Claude Code hints
  _ide-hints.claude-code.fr.md    ← French Claude Code hints
```

IDE hint fragments interpolate with the same slots as the rest of the
tool guide, including `{{readTool}}`, `{{editTool}}`, `{{storyId}}`,
and the other tool/config slots.

### Localization

Prompt fragments and top-level prompts can ship a localized variant
side-by-side with the English original:

```
prompts/
  _pre-task-discussion.md       ← English (default)
  _pre-task-discussion.fr.md    ← French (optional)
```

`loadPrompt` and `readFragment` resolve a locale signal once per call and
prefer the localized file when one exists. The lookup order for a
fragment named `foo` and a resolved locale `fr-FR` is:

1. `foo.fr-FR.md`
2. `foo.fr.md`
3. `foo.md`

Locale precedence (first non-empty wins; see `src/locale.js`):

1. `backlog.json` top-level `"locale"` key (mirrors `agent`, `forge`)
2. `BL_LOCALE` env
3. `LC_ALL` env
4. `LANG` env

Normalization: codeset and modifier suffixes (`.UTF-8`, `@euro`) are
stripped; the language part is lowercased; the region is kept as
written. `fr_FR.UTF-8` resolves to `fr-FR`. `C` / `POSIX` resolve to
"no locale" — the un-suffixed file loads.

Conventions and limitations:

- The project ships English-only by default. Localization is **opt-in**:
  add `prompts/<name>.<locale>.md` to a backlog where the locale signal
  resolves and the renderer picks it up. No `bl` source edit needed.
- File matching is **case-sensitive** on Linux. Recommended convention:
  `<lang>` in lowercase (e.g. `_foo.fr.md`); region-tagged variants are
  supported but should match the casing your locale signal normalizes
  to (`fr-FR`, not `FR-fr`). For v1, language-only files are the safer
  bet.
- Interpolation is unchanged: localized fragments use the same
  `{{slot}}` names as their English original. Slot names are part of
  the contract — a translator must keep them verbatim. Missing keys
  render as empty strings (same forgiving behavior as English).
- `loadHookDenyMessage` is invoked at hook-install time for whichever
  provider is installing hooks (currently Claude), not per prompt. An
  agent or locale change between sessions does not retroactively rewrite
  installed hooks; reinstalling them (any `bl` invocation that touches
  the hook) picks up the new variant.

## Plugins

Plugins run shell commands at lifecycle stages (`new`, `workon`, `cleanup`, `done`).
They are defined in `backlog.json` and activated via frontmatter.

### Configuration

Register plugins in `backlog.json`:

```json
{
  "backlog": "backlog",
  "plugins": {
    "session-stack": {
      "workon": "../stack/session up {{sessionId}} {{worktreePath}}",
      "cleanup": "../stack/session down {{sessionId}}"
    }
  }
}
```

Each plugin maps stage names to shell commands. Commands support `{{variable}}` interpolation:

| Variable           | Example                                    |
| ------------------ | ------------------------------------------ |
| `{{sessionId}}`    | `s67`                                      |
| `{{storyId}}`      | `S-67`                                     |
| `{{worktreePath}}` | `/home/.../worktrees/s67-.../app.acme.com` |
| `{{branchName}}`   | `s67-spa-navigation`                       |
| `{{componentId}}`  | `C00`                                      |
| `{{repoRoot}}`     | `/home/.../app.acme.com`                   |

### Activation via Frontmatter

Plugins are activated in backlog frontmatter and cascade: **root → repo → component → story**.

**Root `<backlog>/index.md`** — defaults for all stories:

```yaml
plugins: [session-stack]
```

**Repo `backlog.json` `repos.<name>`** — for every unit in that repo (its
component's repo, F-51 D4); stage-specific lists only:

```json
"app.acme.com": { "…": "…", "plugins-bootstrap": ["node-ws", "acme-vendor"], "plugins-test": ["app-tests"] }
```

**Component `components/C00-infrastructure/index.md`** — override for the component:

```yaml
plugins: [-session-stack]
```

**Story `stories/S99-my-story/index.md`** — override for a single story:

```yaml
plugins: [session-stack]
```

- A plugin list is a YAML sequence (F-62 D2); a scalar is no list and activates nothing
- Bare names (`session-stack`) add the plugin
- Prefixed with `-` (`-session-stack`) removes it
- Stage-specific overrides: `plugins-workon: [-session-stack]` (only affects the `workon` stage)

### Lifecycle Stages

| Stage        | When it runs                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new`        | After `bl new` creates a story and runs sync                                                                                                                                |
| `workon`     | After `bl implement` sets up the worktree (new worktrees only)                                                                                                              |
| `bootstrap`  | During `bl implement`, once per repo configured for the story, and in every `bl updates run` gate, after the frozen install (red on failure, no soft skip)                  |
| `format`     | On `bl format --story <id>` and during `bl sync` (`.md` only)                                                                                                               |
| `lint`       | On `bl lint --story <id>`                                                                                                                                                   |
| `cleanup`    | During `bl merge`, before worktree removal                                                                                                                                  |
| `done`       | After `bl done` marks the story complete and syncs                                                                                                                          |
| `test`       | The test gate of `bl run`, in each prepared repo's worktree with that repo's config (`plugins-test: [<name>]`); each attempt's output goes to `.bl/run/<F-id>.test-<n>.log` |
| `regenerate` | During `bl merge`'s integration, in a worktree whose merge with main conflicts: regenerates the conflicted files its `paths` match (F-36 D5; see below)                     |

A `regenerate` plugin names the generated files it rebuilds: `regenerate` (the
command, run in the worktree) and `paths` (a non-empty list of repo-relative
globs, matched by `pathMatches`, dotfiles included). Each needs the other;
`loadConfig` refuses a plugin with one and not the other, naming it (top level
and every repo's `overrides`), and there are no defaults. A repo activates one
on its `repos` entry:

```json
"plugins": {
  "pnpm-lock": { "regenerate": "pnpm install --lockfile-only", "paths": ["pnpm-lock.yaml"] }
},
"repos": {
  "app.acme.com": { "path": "../app.acme.com", "deployable": true, "update_tests": [], "plugins-regenerate": ["pnpm-lock"] }
}
```

The stage (`regenerateConflicts`, `src/regenerate.js`) runs per conflicted
repo, per active plugin: every conflicted path its `paths` match is taken from
the branch side (`git checkout --ours`), or removed when the branch deleted it,
the command runs once, and those paths (and every other path its `paths` match
that the command created, changed or deleted, untracked included, ignored not)
are staged (`git add -A`). A failing command, or any failing step around it
(reading the index, the checkout, the scan for outputs, the staging), puts its
paths back as conflicted (`git checkout -m`, or the one side left when the other
deleted the path) and reports the plugin failed. With no
conflicted path left, `bl` commits the merge (`git commit --no-edit`) and the
repo counts as `merged`: gated, pushed, and never re-reviewed.

For feature commands (`bl implement`, `bl run` or `bl merge` on an F-id) the cascade is
**root → repo → feature**, the repo being each worktree's: a feature has no
component, and its frontmatter is where per-feature tooling is chosen
(`plugins-test: [bl-tests]` on a feature in bl). `bl run S-n` adds the story's
component before the story file.

#### A feature's session number

A feature has one test-session number `N`: the number of the **first** story in
its `stories:` list (listed order, not the lowest; F-4 with `[S-596, …]` gets
596). A story belongs to one feature, so two features never share a number.
Feature commands pass it in two forms, because the consumers need both:

| Variable         | Value  | Used by                                                          |
| ---------------- | ------ | ---------------------------------------------------------------- |
| `{{sessionId}}`  | `s596` | the session CLI (`session up s596 …`), `containers-<svc>-s596-1` |
| `{{sessionNum}}` | `596`  | `PLAYWRIGHT_SESSION_ID`, which must be a bare number             |

Both reach the prompts (`baseVars`), the feature's `bootstrap` / `workon` /
`cleanup` stage plugins, and the test gate's plugin commands
(`featureSessionVars()` in `feature.js`). A session-stack guide (see
**Session stack**) can name this number instead of asking the agent to pick one, and the
implementers of a feature's stories run in sequence, so they share it. A
`test` plugin command still holding a `{{…}}` after interpolation (a typo, or
a feature whose first `stories:` entry is not a story ID) fails the gate as
`test gate misconfigured`, naming the placeholder, and is never run.

Operator rollout after `bl merge F-5`: set `backlog.json`
`plugins.app-tests.test` to
`env PLAYWRIGHT_SESSION_PROFILE=agent PLAYWRIGHT_SESSION_ID={{sessionNum}} npm test`,
so two app features gating at once use different Playwright sessions instead
of both tearing down session 0. Not before the merge: an older bl would pass
the placeholder through literally.

### Toolchain stages (`format`, `lint`, `bootstrap`)

These three stages exist so `bl` itself never names a toolchain binary.
They replace what used to be hardcoded calls to `ppp` (a site-specific
prettier wrapper) in `bl sync` and to `pnpm install` in `bl implement`.

> **Upgrade note (generator v13, F-48 D5):** the baseline agent allowlist
> no longer includes `gh:*` (S-440 added it for side PRs and `gh repo` /
> `gh release` lookups). A side change is a `bl side` story now, and every
> forge call is `bl`'s own, so a session that runs `gh` gets a permission
> prompt (or a denial when headless). On upgrade,
> `<backlogRoot>/allowed-tools.json` regenerates automatically on the
> next `bl` invocation that needs the allowlist (the bumped
> `_generated.generator_version` triggers regen). No user action
> required; this note exists so the behavior change is discoverable.

- **`bootstrap`** — `bl implement` resolves the story's repo (its
  component's) and runs the `bootstrap` plugin in its worktree; a
  feature run does so for each of the feature's repos. JS repos register `"plugins-bootstrap": ["node-ws"]` and get
  `pnpm install`; Go repos register `go-ws` and get `go mod download`;
  etc. Missing binaries print a warning and skip — never block the
  session. The stage also runs in every `bl updates run` gate, after the
  frozen install (red on failure, no soft skip).

- **`format` / `lint`** — `bl format --story <id>` and
  `bl lint --story <id>` resolve the story's backlog `index.md` and
  dispatch it by extension via a top-level `language_dispatch` map. Files
  with no registered plugin are silently skipped. Implementation repo
  worktrees and agents are not involved. The story ID is required by
  default — pass `--no-story` with explicit paths for ad-hoc work outside
  any story scope. A feature ID (`--story F-5`, what feature sessions pass)
  covers the feature's `index.md` and the `index.md` of every story it
  lists, each under its own plugin cascade (the feature file under the
  backlog root's); explicit paths narrow it to those files.

#### `language_dispatch` shape

```jsonc
{
  "plugins": {
    "md": { "format": "prettier --write {{path}}" },
    "py": { "format": "ruff format {{path}}", "lint": "ruff check {{path}}" },
    "go": {
      "format": "gofmt -w {{path}}",
      "lint": "golangci-lint run {{path}}",
    },
    "node-ws": { "bootstrap": "pnpm install --no-frozen-lockfile" },
    "go-ws": { "bootstrap": "go mod download" },
    // Cascade-add plugins that aren't in the default `language_dispatch`
    // map declare `extensions` so `bl format` / `bl lint` know which files
    // to send to them when they're activated via
    // `plugins-format: [<name>]` / `plugins-lint: [<name>]` frontmatter.
    "extra-md": {
      "format": "markdownlint-cli2 --fix {{path}}",
      "extensions": [".md"],
    },
  },
  "language_dispatch": {
    "format": { ".md": "md", ".py": "py", ".go": "go" },
    "lint": { ".py": "py", ".go": "go" },
  },
}
```

**Plugin fields**

| Field        | Type     | Notes                                                                                                                                                                               |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<stage>`    | string   | Shell command for that stage (`format`, `lint`, `bootstrap`, `workon`, `cleanup`, `done`, `new`). `{{path}}` is interpolated to the matched files; `{{var}}` for runtime variables. |
| `extensions` | string[] | File extensions (`.md`, `.go`, …) this plugin handles when added via the `plugins-<stage>: <name>` cascade. Required for cascade-add plugins not listed in `language_dispatch`.     |

`language_dispatch[stage][ext]` accepts either a single plugin name (`"md"`)
or an array (`["md", "extra-md"]`) when multiple plugins should run on the
same extension. The cascade can also fan-out — `plugins-format: [extra-md]`
augments the default `md` plugin rather than replacing it.

The merge of a repo's `overrides` over the top-level `backlog.json`
(`configForRepo`) deep-merges per-plugin one level: a repo that overrides
`plugins.md.format` keeps any top-level `plugins.md.extensions`. To
override a whole plugin, restate every field you want present.

#### Recommended language → linter / formatter defaults

`bl init` should emit these in a fresh `backlog.json`. Users override
per repo in its `repos` entry's `overrides` (which shallow-merge into the
top level on both `plugins` and `language_dispatch`).

| Language | Linter (default)      | Formatter (default)         |
| -------- | --------------------- | --------------------------- |
| JS / TS  | `eslint .`            | `prettier --write {{path}}` |
| Python   | `ruff check {{path}}` | `ruff format {{path}}`      |
| Go       | `golangci-lint run`   | `gofmt -w {{path}}`         |
| Shell    | `shellcheck`          | `shfmt -w {{path}}`         |
| HTML/CSS | `stylelint`           | `prettier --write {{path}}` |
| Markdown | `markdownlint-cli2`   | `prettier --write {{path}}` |
| YAML     | `yamllint`            | `prettier --write {{path}}` |

#### Allowed-tools generation

`<backlogRoot>/allowed-tools.json` is **lazily regenerated** by every
`bl` invocation that needs the agent allowlist. One file serves every
repo, so its input is repo-independent: `allowlistInput(config)`
takes the top-level `{plugins, forge}` slice of `backlog.json` plus the
`overrides.plugins` of every `repos` entry (keyed `<repo>/<name>`),
never the repo-scoped merge in `config.raw`. A `plugins` value that is
not an object map of object definitions throws, naming the file, rather
than being hashed while yielding no leaders. The file carries a
`_generated.config_hash` (sha256 of that canonicalised union) and a
`_generated.generator_version`; there is no timestamp, so two
regenerations from the same input are byte-identical and git history
records when the file changed. Regen triggers (`regenReason`): file
missing, JSON parse failure, hash mismatch, version bump. A regen whose
bytes equal the current file is skipped; one that writes prints its
trigger to stderr (`allowed-tools.json regenerated: config hash
<old8>→<new8>`). Writes are atomic (temp file + rename) through
`atomicWriteFile` in `src/atomic-write.js`, the helper `bl fix` and
`bl merge` use too. The temp file is staged in the backlog's ignored
`.bl/tmp/` (`.bl/tmp/allowed-tools.json.<pid>.<random>.tmp`), so a crash
between write and rename leaves nothing in `git status`. Its name is
per-process because concurrent `bl` processes regenerate the same file
outside the backlog lock, and a fixed staging path let one rename consume
the other's. The staging file is created exclusively (`wx`): a name that
already exists belongs to another regeneration in this process that drew
the same random token, so a fresh name is tried instead of truncating
theirs, up to `STAGING_ATTEMPTS` (10); after that the EEXIST propagates
and the other caller's file is left alone. A write or rename that throws
unlinks its own staging file before the error propagates; an unlink
failure other than ENOENT (the file is already gone) is reported on
stderr with the staging path, never swallowed, since it leaves an orphan.
`_hooks.beforeRename` (in `src/atomic-write.js`) is a
private test seam that runs
between the two steps so a unit test can interleave two regenerations;
like the `BL_INTERNAL_TEST_*` seams it is not public surface. The
`templates/allowed-tools.json` in the bl repo is a **seed** copied at
`bl init`; it is never regenerated against bl source changes —
user-installed backlogs stay current via the staleness check, not by
editing the bl repo.

**Mode denials (`deny`).** The generated file carries a per-mode `deny`
map of hard-denied command prefixes that override the allowlist. Review
mode denies `gh pr merge:*` and `git push:*`: no allow token grants a merge
since `gh:*` left the base (generator v13), but a user rule could, and the
reviewer reads content authored by the agent under review — so the
irreversible commands get a hard rail rather than prompt-level trust.
`launchSession` reads the mode's deny list (`getDeniedTools`) and passes
it to `provider.spawn` as generic tokens; Claude renders them as
`--disallowedTools`, Gemini as priority-300 policy deny rules, Codex as
explicit prompt guidance (it has no per-invocation deny mechanism).
Denials are prefix-matched, like allow tokens — belt-and-braces, not a
sandbox.

**No forge rules.** The forge plugin contributes nothing: no leader in
`base` and no two-word rule in any mode (F-42 D4, generator v12). `bl`
makes every forge call itself. `commandWords` (`config.js`) still returns
a command's leader and the trimmed word after it; `commandLeader` is that
pair's leader.

**Templated leaders.** A plugin command whose leader starts with
`{{roostDir}}` or `{{backlogRoot}}` (the top-level `prettier`, a
repo's session-stack plugin) is written templated,
`{{roostDir}}/tools/node_modules/.bin/prettier:*`, so the committed file
is identical on every machine; `commandLeader` keeps a leading `{{var}}`
token intact, also inside a `(cmd)` or `{ cmd; }` wrapper (its brace strip
is for shell grouping and stops at the template, and the trailing `;`/`)`
trim never eats a template's closing `}}`), and the generator never
interpolates. A permission rule holds no variables, so
`resolveAllowedTokens` substitutes the two vars and drops any token that
still carries a placeholder. It has three callers: `getAllowedTools`
resolves `base`, the mode list and the local extras per machine
(`roostDir` argument, else `config.roostDir`; when none
is known the templated rule is dropped, never passed through raw), with
`backlog.json` `session_stack.allow` after the local extras;
`bl allow` compares a suggestion against the resolved set as well as the
raw one (`existingPatternSet`, committed patterns and local extras alike),
so the absolute path the permission log reports is recognised as already
granted; and `recoverUserExtras` treats the absolute form a pre-v10
generator wrote into `base` or `extra` under this checkout's configured
roots as config-derived, so the one-time v10 regeneration drops it instead
of rescuing it into `extra`. Only exact generated tokens and those resolved
forms are dropped; a declared token is never classified by shape, so a
user grant with the same suffix under another root (or the absolute form
another machine wrote) is preserved as a user addition. Codex resolves the
same placeholders again in `expandRoostPlaceholders`, harmlessly.

**User additions (`extra`).** `bl allow` records user-discretion grants
in the gitignored `allowed-tools.local.json` beside the backlog (merged
into every launch by `getAllowedTools`), never in the committed file. The
committed file's top-level `extra` array holds patterns that earlier bl
versions wrote there or that a user added by hand; `ensureAllowedTools`
preserves them across regens by passing them back into
`generateAllowedTools`, so a `backlog.json` change (which bumps the
`config_hash` and triggers regen) doesn't nuke them. Legacy backlogs that
have user additions only in `base` (from before the `extra` field
existed) are auto-rescued on the first regen: anything in `base` not
produced by `BASE_DEFAULT` + the union's plugin leaders moves into
`extra`, and an `extra` entry the union now generates leaves `extra` (it
is config-derived, not a user addition).

**Codex native approvals.** `allowed-tools.json` remains the generated,
mode-specific source of prompt guidance for every provider. Codex also
receives a best-effort projection of enforceable shell patterns into its
native `prefix_rule(pattern=[...], decision="allow")` rules. Only exact
command prefixes that Codex can enforce are installed; broad backlog
patterns such as `npm:*` are translated into concrete project test
commands, `bl:*` resolves to the shared `{{roostDir}}/bl/bin/bl`, and
repo-local `./bin/bl` is added only for `bl` worktrees. Tool names, file
globs, environment-assignment patterns, and other entries without a safe
command-prefix equivalent stay prompt-only.

## Forge ops (F-42 D4)

The record of a change is its change document (`change.md`); the forge's PR
is a **projection** of it. `bl` generates the PR's title and body from the
change document, one way, and never reads review content back. Every forge
call is made by `bl` itself, through the op set below; no agent permission
mode is granted a forge command. Dropping the mirror later is `forge: none`
(no `forge` key), a config change.

### Configuration

`backlog.json` declares the forge plugin under `plugins` and names it as the
active forge. `templates/forge-github.json` is the GitHub block:

```jsonc
{
  "plugins": {
    "github": {
      "change.open": "gh pr create --title {{title}} --body {{body}}",
      "change.describe": "gh pr edit {{number}} --body {{body}}",
      "change.find": "gh pr list --head {{branch}} --state all --json number,url,state,headRefOid,labels --limit 1",
      "change.close": "gh pr close {{number}} --comment {{comment}}",
      "change.ready": "gh pr ready {{number}}",
      "update.notes": "gh pr view {{number}} --json body --jq .body",
    },
  },
  "forge": "github",
}
```

A `gitlab` plugin with `glab`-flavored commands swaps the forge wholesale.

### Op surface

Every op runs with the repo's checkout as its working directory
(`runForgeOp`'s `repoPath`), so an op is keyed by that repo and a
`{{branch}}`, or by the `{{number}}` the change document records. The set
is `FORGE_OPS` in `src/config.js`.

| Op                | Variables           | Returns                                  | Called by                                                                                                     |
| ----------------- | ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `change.open`     | `title`, `body`     | the PR's URL                             | `bl run` (the PR step), `bl review` (a branch with commits and no PR)                                         |
| `change.describe` | `number`, `body`    | —                                        | `bl run`, when `## Description` changed since the body last sent, and for a PR it adopted                     |
| `change.find`     | `branch`            | `[{number,url,state,headRefOid,labels}]` | `bl run` (adoption), `bl review` (open or merged), `bl merge` (close, main-checkout gate), `bl updates` (url) |
| `change.close`    | `number`, `comment` | —                                        | `bl merge`, `bl updates run` (a requested drop)                                                               |
| `change.ready`    | `number`            | —                                        | `bl updates run`, before it pushes a merge to `main` (Renovate opens drafts; a no-op on a ready PR)           |
| `update.notes`    | `number`            | Renovate's PR body                       | `bl updates run` (a red major's `## Release notes`); Renovate's PRs only                                      |

- The PR title is `<id>: <title>`; the body is the change document's
  `## Description`, the spec's path, and a line saying edits made on the
  forge are overwritten (`changePrContent` in `src/feature-run.js`).
- `findChange` (`src/config.js`) runs `change.find` and upper-cases each
  PR's `state` (`OPEN`, `MERGED`, `CLOSED`; `OPEN` when the template asks
  for no state). `bl review` takes each repo's PR from the change document
  (`findUnitPRs` in `src/story.js`), its state from `change.find`; nothing
  is searched by title. A `MERGED` PR is the S-789 "merged before review"
  case.
- There is no merge or push op: `bl merge` merges with `git merge --no-ff`
  and pushes `main`, plain git against any remote. There is no CI op either:
  no repo has hosted CI since S-565, so `bl merge` has no CI gate.
- `bl validate` fails a forge plugin with an op outside the set, a missing
  op, or an op that is not a command string (`forge-op`), a `forge` that
  names no plugin (`forge-plugin`), and any op
  but `update.notes` whose template reads a PR body or comments
  (`--json body`, `comments`, `gh pr view`: `forge-op-reads-body`).

### `runForgeOp` contract

`runForgeOp(opName, vars, { config, repoPath })` in `src/config.js`:

- `repoPath` is **required**. Every forge op runs against a specific repo's
  working tree, not "current cwd" — `bl merge <story>` iterates each
  story repo and calls `runForgeOp` per worktree, so a story with PRs in
  two repos closes both.
- Returns `{ configured: true, stdout, stderr, status, repoName, repoPath }`
  on success so callers can `JSON.parse(stdout)` for list-shaped ops.
- Returns `{ configured: false, reason, repoName, repoPath }` when forge
  isn't configured (`no-forge`, silently: `forge: none` prints no warning
  per op), the named plugin doesn't exist (`no-plugin`), the op isn't
  declared (`no-op`), the binary is absent (`missing-binary` — also emits
  one warning line), or spawn itself fails (`spawn-error`). Callers fall
  through to their non-fatal path; `bl run` treats `no-forge` as the
  explicit opt-out (no PR, `pr:` left empty in `change.md`) and any other
  sentinel as a broken setup.
- Each `{{var}}` value is shell-quoted (POSIX single-quoting with
  `'\''` escaping) before substitution, so values containing spaces,
  apostrophes, or shell metacharacters survive `spawnSync(..., { shell:
true })`. Plugin templates therefore use the **bare** `{{var}}` form
  (e.g. `--comment {{comment}}`, not `--comment "{{comment}}"`); any
  template-level quoting double-quotes the value and breaks splitting.

### No forge command for agents

`FORGE_OP_MODES` and the `gh pr:*` workon/review baselines are gone
(generator v12), and the forge plugin contributes no leader to the
allowlist or to "Available on PATH". The tool guide's **Pull requests**
section says `bl` opens, describes and closes the PR; the workon prompts
only push. Since generator v13 (F-48 D5) `BASE_DEFAULT` has no `gh:*`
either: a side change is a `bl side` story (`prompts/_side-changes.md`),
and every forge call is `bl`'s own (`runForgeOp`, in bl's process), so no
session needs the forge CLI. Review mode keeps its `gh pr merge:*` denial
as a rail.

### Caveat: `gh auth git-credential`

Removing `gh` entirely from a workflow can break setups that use
`gh auth git-credential` as `git`'s credential helper. The agents'
allowlist no longer has `gh:*` (generator v13), and does not need it: the
helper is run by `git` itself, not by the agent's shell, so a `git push`
from a session still authenticates. This caveat is here for users designing
alternative forge plugins (a pure `glab`-only shop will need its own
credential helper story).

#### Migration recipe

Detect current credential helpers:

```bash
git config --get-regexp '^credential(\..*)?\.helper$'
```

Inspect both the global helper and any URL-scoped GitHub helper:

```bash
git config --global --get credential.helper
git config --global --get credential.https://github.com.helper
```

If either key resolves to `gh auth git-credential`, unset the `gh`-backed
helper before removing `gh`:

```bash
git config --global --unset credential.helper
git config --global --unset credential.https://github.com.helper
```

Install a replacement helper appropriate for the host:

```bash
# Portable plaintext store in ~/.git-credentials.
git config --global credential.helper store

# Linux desktop secret service, when git-credential-libsecret is installed.
git config --global credential.helper libsecret

# macOS keychain.
git config --global credential.helper osxkeychain
```

Verify from a repository you already have cloned and can push to:

```bash
git push --dry-run origin HEAD
```

If the dry run still reaches for the wrong helper, repeat the detection
command with `GIT_TRACE=1` to see which credential helper `git` invokes.
