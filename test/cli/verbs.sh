#!/usr/bin/env bash
# The id-dispatched verbs (F-35 Design §1); the old names are gone (S-801).
#
# Each verb picks its handler by the id's kind. Every case below ends in a
# refusal or a read-only answer, so no agent session starts: the handler is
# recognised by the message only it prints.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"
source "$REPO_ROOT/test/helpers/tempdir.sh"

# Fixture: loose stories S-1 (refined, its component's repo unknown so implement stops
# before any worktree), S-3 (backlog), S-4 (refined, review pending), S-5
# (done), S-6 (refined, an open escalation); S-2 in F-1. Features in each
# status the handlers gate on.
DIR=$(node --input-type=module -e "
import { mkTempBacklog } from '$REPO_ROOT/test/helpers/tempdir.js';
const story = (id, slug, extra) => ({ id, component: 'C00', title: slug, dirSuffix: slug, points: 3, ...extra });
const { dir } = mkTempBacklog({
  repos: ['../demo-repo'],
  components: [
    { id: 'C00', title: 'Core', dirSuffix: 'core' },
    { id: 'C01', title: 'Loose', dirSuffix: 'loose', repo: 'nope' },
    { id: 'C02', title: 'Demo', dirSuffix: 'demo', repo: 'demo-repo' },
  ],
  stories: [
    story('S-1', 'loose', { status: 'refined', component: 'C01' }),
    story('S-2', 'in-feature', { status: 'refined', feature: 'F-1' }),
    story('S-3', 'backlog', { status: 'backlog' }),
    story('S-4', 'pending', { status: 'refined', component: 'C02' }),
    story('S-5', 'closed', { status: 'done', completed: '2026-01-01' }),
    story('S-6', 'escalated', { status: 'refined', component: 'C02', body: '## Escalation\\n\\nWhich way?\\n' }),
  ],
  features: [
    { id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'approved', primary_repo: 'demo-repo', stories: ['S-2'] },
    { id: 'F-2', title: 'Refined', dirSuffix: 'refined', status: 'refined', primary_repo: 'demo-repo', stories: ['S-2'] },
    { id: 'F-3', title: 'Draft', dirSuffix: 'draft', status: 'draft', primary_repo: 'demo-repo' },
    { id: 'F-4', title: 'Closed', dirSuffix: 'closed', status: 'done', primary_repo: 'demo-repo' },
  ],
}, { keep: true });
process.stdout.write(dir);
")
trap 'rm -rf "$DIR"' EXIT
export BL_BACKLOG_DIR="$DIR"
cd "$DIR"
# The review state lives in the story's change document.
printf -- '---\nchange_of: S-4\nstatus: open\nreview_status: pending\nrepos:\n---\n' >"$DIR"/stories/S4-pending/change.md

# Run `bl <args>`; sets RC, OUT, ERR.
blrun() {
  local errf
  errf=$(mktemp)
  set +e
  OUT=$("$BL" "$@" 2>"$errf")
  RC=$?
  set -e
  ERR=$(<"$errf")
  rm -f "$errf"
}

# --- Feature cells: the feature-cmd.js handlers ----------------------------
blrun status F-1
assert_exit "status F-1" 0 "$RC"
assert_contains "status F-1 → feature status" "F-1 · Feat" "$OUT"

blrun approve F-3
assert_exit "approve F-3" 1 "$RC"
assert_contains "approve F-3 → feature approve" 'still a draft — run `bl refine F-3`' "$ERR"

blrun run F-1 --plan
assert_exit "run F-1 --plan" 0 "$RC"
assert_contains "run F-1 → feature run" "1. setup" "$OUT"

blrun implement F-2
assert_exit "implement F-2" 1 "$RC"
assert_contains "implement F-2 → feature workon" 'run `bl approve F-2` first' "$ERR"

blrun review F-2
assert_exit "review F-2" 1 "$RC"
assert_contains "review F-2 → feature review" "has no branch yet" "$ERR"

blrun merge F-2
assert_exit "merge F-2" 1 "$RC"
assert_contains "merge F-2 → feature merge" "nothing has been implemented on a branch yet" "$ERR"

blrun refine F-4
assert_exit "refine F-4" 1 "$RC"
assert_contains "refine F-4 → feature refine" "Feature F-4 is done; nothing to refine." "$ERR"

# --- Story cells: today's story commands ----------------------------------
blrun implement S-3
assert_exit "implement S-3" 1 "$RC"
assert_contains "implement S-3 → workon" "must be refined first (run: bl refine S-3)" "$ERR"

blrun review S-1
assert_exit "review S-1" 1 "$RC"
assert_contains "review S-1 → story review" "No open PR found for story S-1." "$ERR"

blrun merge S-4
assert_exit "merge S-4" 1 "$RC"
assert_contains "merge S-4 → cleanup" "S-4 has unresolved review state" "$ERR"
assert_contains "merge S-4 hint uses the new verb" "Address the review feedback (bl implement S-4)" "$ERR"

blrun refine S-5
assert_exit "refine S-5" 1 "$RC"
assert_contains "refine S-5 → story refine" "Story S-5 has status 'done' — skipping (cannot refine)." "$ERR"

# --- Refusals --------------------------------------------------------------
for verb in run implement; do
  blrun "$verb" C00
  assert_exit "$verb C00" 1 "$RC"
  assert_contains "$verb C00 refuses a component" 'C00 is a component. Make the stories you want into a feature: `bl new --feature --title … S-1 S-2`' "$ERR"
done
for verb in run implement review merge; do
  blrun "$verb" S-2
  assert_exit "$verb S-2" 1 "$RC"
  assert_contains "$verb S-2 names its feature" "S-2 is part of F-1; use F-1" "$ERR"
done
# A story's repo is its component's (F-52 D1): no story verb takes --repo.
for verb in run implement review merge; do
  for flag in --repo -r; do
    blrun "$verb" S-4 "$flag" demo-repo
    assert_exit "$verb S-4 $flag" 1 "$RC"
    assert_contains "$verb S-4 $flag is refused" "bl $verb: unknown option \"--repo\" for a story: a story's repo is its component's." "$ERR"
  done
done
blrun merge --help
if [[ "$OUT" == *"--repo"* ]]; then fail "merge --help lists no --repo"; else pass; fi
blrun approve S-1
assert_exit "approve S-1" 1 "$RC"
assert_contains "approve refuses a story" "S-1 is a story; stories have no approve step" "$ERR"
blrun done F-1
assert_exit "done F-1" 1 "$RC"
assert_contains "done refuses a feature" "F-1 is a feature; bl merge F-1 marks it done." "$ERR"
blrun run F-1 F-2 --plan
assert_exit "run F-1 F-2 --plan" 0 "$RC"
assert_contains "several targets go through the scheduler" "Starting: F-1, F-2" "$ERR"
blrun run X-1
assert_exit "run X-1" 1 "$RC"
assert_contains "malformed id" "Invalid id: X-1" "$ERR"

# --- Story run, status and merge gate (S-797) -------------------------------
blrun run S-1 --plan
assert_exit "run S-1 --plan" 0 "$RC"
assert_contains "run S-1 → the loop's plan for the story" "S-1 · loose — run plan" "$OUT"
assert_contains "run S-1 plan implements the story" " 2. implement S-1" "$OUT"

blrun run S-3
assert_exit "run S-3" 1 "$RC"
assert_contains "run refuses a backlog story" 'Story S-3 is backlog — run `bl refine S-3` first.' "$ERR"

blrun run S-6
assert_exit "run S-6" 1 "$RC"
assert_contains "run refuses an open escalation" "Story S-6 has an open ## Escalation" "$ERR"

blrun status S-1
assert_exit "status S-1" 0 "$RC"
assert_contains "status S-1 → story status" "S-1 · loose" "$OUT"
assert_contains "status S-1 shows status and branch" "status: refined   repo: nope   branch: -   pr: -   points: 3" "$OUT"
assert_contains "status S-1 shows the review round" "review: none (round 0/2)" "$OUT"

blrun status S-6
assert_exit "status S-6" 0 "$RC"
assert_contains "status S-6 shows the escalation" $'escalation:\nWhich way?' "$OUT"

blrun merge S-6
assert_exit "merge S-6" 1 "$RC"
assert_contains "merge refuses an open story escalation" 'S-6 has an open Escalation section — resolve it and set it back to "None." before merging:' "$ERR"

# --- Removed aliases (S-801) ----------------------------------------------
# The old names are plain unknown commands: no redirect, no hint.
blrun workon S-3
assert_exit "workon S-3" 1 "$RC"
assert_contains "workon is unknown" "bl: unknown command 'workon'" "$ERR"

blrun cleanup S-4
assert_exit "cleanup S-4" 1 "$RC"
assert_contains "cleanup is unknown" "bl: unknown command 'cleanup'" "$ERR"

blrun feature status F-1
assert_exit "feature status F-1" 1 "$RC"
assert_contains "feature is unknown" "bl: unknown command 'feature'" "$ERR"

blrun f run F-1
assert_exit "f run F-1" 1 "$RC"
assert_contains "f is unknown" "bl: unknown command 'f'" "$ERR"

# No verb (once `bl list --features`) and --help (once implement's help) are
# unknown too: nothing behind the old name answers.
blrun feature
assert_exit "feature (no verb)" 1 "$RC"
assert_contains "feature with no verb is unknown" "bl: unknown command 'feature'" "$ERR"

blrun workon --help
assert_exit "workon --help" 1 "$RC"
assert_contains "workon --help is unknown" "bl: unknown command 'workon'" "$ERR"
if [[ "$OUT" == *"Usage: bl implement"* ]]; then fail "workon --help still shows implement's help"; else pass; fi

# --- bl help ---------------------------------------------------------------
blrun help
for verb in run implement review merge refine status approve done; do
  assert_contains "bl help lists $verb" "  $verb " "$OUT"
done
if [[ "$OUT" == *"deprecated"* ]]; then fail "bl help still lists deprecated aliases"; else pass; fi

# Last: it writes. bl done on a story still goes to today's bl done, with the
# commit-hash positional passed through.
blrun done S-3 abc1234
assert_exit "done S-3 abc1234" 0 "$RC"
assert_contains "done S-3 → story done" "commit=abc1234" "$ERR$OUT"

# A short hash that reads as a component id (c + digits) is still the
# commit hash.
blrun done S-1 c123456
assert_exit "done S-1 c123456" 0 "$RC"
assert_contains "done S-1 c123456 → the hash, not a component" "commit=c123456" "$ERR$OUT"

summary_and_exit
