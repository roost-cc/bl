#!/usr/bin/env bash
# Several targets (F-35 Design §5): run and implement defer dependents and
# overlaps up front and start the rest; run and review run each started unit as
# a child with its output in .bl/run/<id>.out; merge goes in dependency order
# and stops at the first failure; status and done take each target on its own.
#
# The stories' repo (their component's) is unknown, so every run or implement stops at its prep
# ("Unknown repo: nope") before a worktree or an agent session.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"
source "$REPO_ROOT/test/helpers/tempdir.sh"

# S-1 and S-3 plan the same file; S-2 depends on S-1; S-4 is independent;
# S-6 waits on S-9 (backlog); S-8 depends on S-10, whose review is pending;
# S-11 is in feature F-1; S-12 and S-13 are for bl done. S-8 and S-10 are in
# C01, whose repo is registered, so bl merge reaches its gates.
DIR=$(node --input-type=module -e "
import { mkTempBacklog } from '$REPO_ROOT/test/helpers/tempdir.js';
const plan = (p) => '## Implementation Plan\\n\\n1. Change \`' + p + '\`.\\n';
const story = (id, extra) => ({ id, component: 'C00', title: 'story ' + id, dirSuffix: id.toLowerCase(), points: 1, status: 'refined', ...extra });
const { dir } = mkTempBacklog({
  repos: ['../demo-repo'],
  components: [
    { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'nope' },
    { id: 'C01', title: 'Demo', dirSuffix: 'demo', repo: 'demo-repo' },
  ],
  stories: [
    story('S-1', { body: plan('src/a.js') }),
    story('S-2', { depends_on: 'S-1', body: plan('src/b.js') }),
    story('S-3', { body: plan('src/a.js') }),
    story('S-4', { body: plan('src/d.js') }),
    story('S-6', { depends_on: 'S-9' }),
    story('S-8', { depends_on: 'S-10', component: 'C01' }),
    story('S-9', { status: 'backlog' }),
    story('S-10', { component: 'C01' }),
    story('S-11', { feature: 'F-1' }),
    story('S-12', { status: 'in_progress' }),
    story('S-13', { status: 'in_progress' }),
  ],
  features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'draft', primary_repo: 'nope', stories: ['S-11'] }],
}, { keep: true });
process.stdout.write(dir);
")
trap 'rm -rf "$DIR"' EXIT
export BL_BACKLOG_DIR="$DIR"
cd "$DIR"
# The review state lives in the story's change document.
printf -- '---\nchange_of: S-10\nstatus: open\nreview_status: pending\nrepos:\n---\n' >"$DIR"/stories/S10-s-10/change.md

# Run `bl <args>` outside tmux; sets RC, OUT, ERR.
blrun() {
  local errf
  errf=$(mktemp)
  set +e
  OUT=$(env -u TMUX -u TMUX_PANE -u BL_TMUX_WINDOW_ID "$BL" "$@" 2>"$errf")
  RC=$?
  set -e
  ERR=$(<"$errf")
  rm -f "$errf"
}

# --- run: deferral before anything starts ----------------------------------
blrun run S-3 S-2 S-1 S-6 --plan
assert_exit "run S-3 S-2 S-1 S-6 --plan" 0 "$RC"
assert_contains "a dependent waits, naming its blocker" "  S-2: S-2 depends on S-1; run it after S-1 merges" "$ERR"
assert_contains "an overlap waits, naming the shared file" "  S-3: S-3 overlaps S-1 on src/a.js; run it after S-1 merges" "$ERR"
assert_contains "an undone outside dependency waits" "  S-6: S-6 depends on S-9, which is backlog; merge S-9 first" "$ERR"
assert_contains "the deferred list comes first" $'Deferred:\n' "${ERR%%Starting:*}"
assert_contains "only S-1 starts" "Starting: S-1" "$ERR"
assert_contains "the one started unit runs in place" "S-1 · story S-1 — run plan" "$OUT"
if [[ "$OUT" == *"S-3 · "* ]]; then fail "a deferred unit does not run"; else pass; fi

blrun run S-1 S-4 --plan
assert_exit "run S-1 S-4 --plan" 0 "$RC"
assert_contains "independent units both start" "Starting: S-1, S-4" "$ERR"
assert_contains "S-1's plan" "S-1 · story S-1 — run plan" "$OUT"
assert_contains "S-4's plan" "S-4 · story S-4 — run plan" "$OUT"

blrun run S-2
assert_exit "run S-2 alone" 1 "$RC"

# --- run: started units as children, one line each --------------------------
blrun run S-4 S-1 S-3
assert_exit "run with a failing unit exits 1" 1 "$RC"
assert_contains "S-3 deferred" "S-3: S-3 overlaps S-1" "$ERR"
assert_contains "children run in parallel" "Running bl run for S-1, S-4 in parallel; output in .bl/run/<id>.out" "$ERR"
assert_contains "one line for S-1" "S-1: failed (exit 1) — see .bl/run/S-1.out" "$OUT"
assert_contains "one line for S-4" "S-4: failed (exit 1) — see .bl/run/S-4.out" "$OUT"
assert_contains "S-1's output is in its .out" "Unknown repo: nope" "$(<"$DIR/.bl/run/S-1.out")"
assert_contains "S-4's output is in its .out" "Unknown repo: nope" "$(<"$DIR/.bl/run/S-4.out")"

blrun run S-1 S-4 --interactive
assert_exit "run --interactive with several" 1 "$RC"
assert_contains "--interactive takes one target" "bl run: --interactive takes one target" "$ERR"

# --- review: every target as a child ---------------------------------------
blrun review S-1 S-4
assert_exit "review S-1 S-4" 1 "$RC"
assert_contains "review runs children" "Running bl review for S-1, S-4 in parallel" "$ERR"
assert_contains "review line for S-1" "S-1: failed (exit 1) — see .bl/run/S-1.out" "$OUT"
assert_contains "review child output" "No open PR found for story S-4." "$(<"$DIR/.bl/run/S-4.out")"

# --- implement: tmux windows, else a clear refusal --------------------------
blrun implement S-1 S-4
assert_exit "implement S-1 S-4 outside tmux" 1 "$RC"
assert_contains "implement needs tmux for several" \
  "several targets need tmux: start a tmux session and rerun this, or run them one at a time, or use run" "$ERR"

blrun implement S-2 S-1 S-6
assert_exit "implement with one startable" 1 "$RC"
assert_contains "implement defers S-2" "S-2: S-2 depends on S-1" "$ERR"
assert_contains "the one started unit runs here" "Unknown repo: nope" "$ERR"
if [[ "$ERR" == *"need tmux"* ]]; then fail "one started unit needs no tmux"; else pass; fi

blrun implement S-2 S-6
assert_exit "implement with nothing startable" 1 "$RC"
assert_contains "nothing to start" "Nothing to start: every target waits (see above)." "$ERR"

# --- refine: a feature among several targets needs tmux --------------------
blrun refine S-9 F-1
assert_exit "refine S-9 F-1 outside tmux" 1 "$RC"
assert_contains "refine with a feature needs tmux" "several targets with a feature among them need tmux" "$ERR"

# --- merge: dependency order, stop at the first failure ---------------------
blrun merge S-8 S-10
assert_exit "merge S-8 S-10" 1 "$RC"
assert_contains "merge goes in dependency order" "Merging in dependency order: S-10, S-8" "$ERR"
assert_contains "S-10 is gated" "S-10 has unresolved review state" "$ERR"
assert_contains "merge stops at the first failure" "bl merge: S-10 failed; stopped. Not merged: S-8." "$ERR"
if [[ "$ERR" == *"== bl merge S-8 =="* ]]; then fail "S-8 is not attempted"; else pass; fi

# --- status: each target, components expanded -----------------------------------
blrun status S-1 C00
assert_exit "status S-1 C00" 0 "$RC"
assert_contains "status of the story" "S-1 · story S-1" "$OUT"
assert_contains "status of the component" "C00 · C00-core" "$OUT"
assert_contains "the component's stories" "S-13" "$OUT"

# Last: it writes. bl done marks each id, the flags going to each.
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git -C "$DIR" init -q
git -C "$DIR" add -A
git -C "$DIR" commit -q -m init
blrun done --superseded S-12 S-13
assert_exit "done --superseded S-12 S-13" 0 "$RC"
assert_contains "S-12 superseded" "status: superseded" "$(<"$DIR"/stories/S12-s-12/index.md)"
assert_contains "S-13 superseded" "status: superseded" "$(<"$DIR"/stories/S13-s-13/index.md)"

summary_and_exit
