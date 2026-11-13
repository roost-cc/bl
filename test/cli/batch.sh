#!/usr/bin/env bash
# bl batch (F-125 D1): build a two-story batch in a test backlog with a stub
# agent for the cross-story pass, then run it: `bl run B-1 --plan` computes
# its execution plan through the feature loop, and the verbs take B-1 as
# they take a feature. The whole loop on a batch, with a fake runner, is
# test/unit/batch-run.test.js; its merge is test/integration/batch-merge.test.js.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"
source "$REPO_ROOT/test/helpers/tempdir.sh"

# Two refined loose stories in C00 (repo demo-repo), each with a plan.
DIR=$(node --input-type=module -e "
import { mkTempBacklog } from '$REPO_ROOT/test/helpers/tempdir.js';
const story = (id, slug) => ({
  id, component: 'C00', title: slug, dirSuffix: slug, points: 2, status: 'refined',
  body: '## Acceptance Criteria\n\n- [ ] works\n\n## Implementation Plan\n\n1. Change \`src/' + slug + '.js\`.\n',
});
const { dir } = mkTempBacklog({
  repos: ['../demo-repo'],
  components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo' }],
  stories: [story('S-1', 'one'), story('S-2', 'two')],
}, { keep: true });
process.stdout.write(dir);
")
STUB=$(mktemp -d -t bl-batch-stub-XXXXXX)
trap 'rm -rf "$DIR" "$STUB"' EXIT
export BL_BACKLOG_DIR="$DIR"
cd "$DIR"

# The cross-story pass: S-2 needs what S-1 builds, so it adds the order edge.
cat >"$STUB/claude" <<SH
#!/bin/sh
"$BL" block add S-1 --gate order --unit S-2 --until implemented >/dev/null 2>&1 || exit 3
echo '{"type":"result","is_error":false,"result":"S-2 waits for S-1."}'
SH
chmod +x "$STUB/claude"

blrun() {
  local errf
  errf=$(mktemp)
  set +e
  OUT=$(PATH="$STUB:$PATH" "$BL" "$@" 2>"$errf")
  RC=$?
  set -e
  ERR=$(<"$errf")
  rm -f "$errf"
}

# --- Build --------------------------------------------------------------
blrun batch S-1 S-2 --title "Two fixes"
assert_exit "batch S-1 S-2" 0 "$RC"
assert_eq "batch prints its file" "batches/B1-two-fixes/index.md" "$OUT"
assert_contains "batch names the batch" "New story batch: B-1 — Two fixes" "$ERR"
assert_contains "batch file is approved by new" "to: approved" "$(<"$DIR/batches/B1-two-fixes/index.md")"
assert_contains "S-1 joins it" "batch: B-1" "$(<"$DIR/stories/S1-one/index.md")"
assert_contains "S-2 joins it" "batch: B-1" "$(<"$DIR/stories/S2-two/index.md")"
assert_contains "the pass added the order edge" '"blocker":"S-1"' "$(tr -d ' ' <"$DIR/blockers.json")"
assert_contains "the pass reports" "S-2 waits for S-1." "$ERR"

# --- Run: the plan, the verbs -------------------------------------------
blrun run B-1 --plan
assert_exit "run B-1 --plan" 0 "$RC"
assert_contains "run B-1 → the loop's plan" "B-1 · Two fixes — run plan" "$OUT"
assert_contains "run B-1 --plan follows the edge" "S-2 waits for S-1" "$OUT"
assert_contains "run B-1 --plan prints the work order" "Work order  : S-1, S-2" "$OUT"
assert_contains "run B-1 implements each story" "implement S-2" "$OUT"
if [[ -e "$DIR/batches/B1-two-fixes/plan.yaml" ]]; then fail "run B-1 --plan writes no plan.yaml"; else pass; fi

blrun status B-1
assert_exit "status B-1" 0 "$RC"
assert_contains "status B-1 → the batch" "B-1 · Two fixes" "$OUT"
assert_contains "status B-1 is approved" "status: approved" "$OUT"
assert_contains "status B-1 lists its stories" "S-2" "$OUT"

blrun review B-1
assert_exit "review B-1" 1 "$RC"
assert_contains "review B-1 → the feature review handler" "Batch B-1 has no branch yet" "$ERR"

for verb in run implement review merge; do
  blrun "$verb" S-1
  assert_exit "$verb S-1" 1 "$RC"
  assert_contains "$verb S-1 names its batch" "S-1 is part of B-1; use B-1" "$ERR"
done
blrun approve B-1
assert_exit "approve B-1" 1 "$RC"
assert_contains "approve refuses a batch" "B-1 is a story batch" "$ERR"

# --- Refusals -----------------------------------------------------------
blrun batch S-1 S-2 --title "Again"
assert_exit "batch of batched stories" 1 "$RC"
assert_contains "batch refuses a story in a batch" "S-1: it is in B-1." "$ERR"

summary_and_exit
