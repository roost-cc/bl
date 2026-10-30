#!/usr/bin/env bash
# bl new's positional ids and the --feature switch (F-35 Design §6), and
# bl list --features.
#
# `bl new F-n` / `bl new C-n` name the story's feature and component; a flag that
# names another one is an error. `bl new --feature` with no F-id creates a
# feature and moves the listed stories into it, refusing (before anything is
# written) a story past refined or already in a feature.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"
source "$REPO_ROOT/test/helpers/tempdir.sh"

# Fixture: S-1 (backlog), S-2 (refined), S-3 (in F-1), S-4 (done),
# S-5 (in_progress), S-6 (backlog); features F-1 (approved) and F-2 (done).
DIR=$(node --input-type=module -e "
import { mkTempBacklog } from '$REPO_ROOT/test/helpers/tempdir.js';
const story = (id, slug, extra) => ({ id, component: 'C00', title: slug, dirSuffix: slug, points: 3, ...extra });
const { dir } = mkTempBacklog({
  repos: ['../demo-repo'],
  components: [
    { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true },
    { id: 'C01', title: 'Other', dirSuffix: 'other', repo: 'demo-repo' },
  ],
  stories: [
    story('S-1', 'one', { status: 'backlog' }),
    story('S-2', 'two', { status: 'refined' }),
    story('S-3', 'three', { status: 'refined', feature: 'F-1' }),
    story('S-4', 'four', { status: 'done', completed: '2026-01-01' }),
    story('S-5', 'five', { status: 'in_progress' }),
    story('S-6', 'six', { status: 'backlog' }),
  ],
  features: [
    { id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'approved', stories: ['S-3'] },
    { id: 'F-2', title: 'Closed', dirSuffix: 'closed', status: 'done' },
  ],
}, { keep: true });
process.stdout.write(dir);
")
trap 'rm -rf "$DIR"' EXIT
export BL_BACKLOG_DIR="$DIR"
cd "$DIR"
STORIES="$DIR/stories"

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

# --- A story in a feature or component, by positional id -------------------
blrun new F-1 C00 --title "By position" --points 1 --no-sync
assert_exit "new F-1 C00" 0 "$RC"
assert_contains "new F-1 C00 → story under stories/" "stories/S7-by-position/index.md" "$OUT"
assert_contains "new F-1 C00 sets component:" "component: C00" "$(<"$STORIES/S7-by-position/index.md")"
assert_contains "new F-1 sets feature:" "feature: F-1" "$(<"$STORIES/S7-by-position/index.md")"
assert_contains "new F-1 appends to stories:" "stories: [S-3, S-7]" "$(<"$DIR/features/F1-feat/index.md")"

blrun new C01 --title "In other" --points 2 --no-sync
assert_exit "new C01" 0 "$RC"
assert_contains "new C01 → story under stories/" "stories/S8-in-other/index.md" "$OUT"
assert_contains "new C01 sets component:" "component: C01" "$(<"$STORIES/S8-in-other/index.md")"

blrun new E01 --title "Old id" --points 2 --no-sync
assert_exit "new E01" 1 "$RC"
assert_contains "an E-id is told components are C-ids" "E01 is not a component id: components are C-ids (C01)." "$ERR"

blrun new --feature F-1 --component C00 --title "Flag spelling" --points 1 --no-sync
assert_exit "new --feature F-1 --component C00 (flag spelling)" 0 "$RC"
assert_contains "--feature F-1 sets feature:" "feature: F-1" "$(<"$STORIES/S9-flag-spelling/index.md")"

blrun new F-1 --feature F-2 --component C00 --title X --points 1 --no-sync
assert_exit "F-1 with --feature F-2" 1 "$RC"
assert_contains "positional and --feature disagree" "F-1 and --feature F-2 disagree" "$ERR"

blrun new C00 --component C01 --title X --points 1 --no-sync
assert_exit "C00 with --component C01" 1 "$RC"
assert_contains "positional and --component disagree" "C00 and --component C01 disagree" "$ERR"

blrun new F-1 C00 C01 --title X --points 1 --no-sync
assert_exit "two components" 1 "$RC"
assert_contains "two components refused" "bl new takes one component id" "$ERR"

blrun new S-1 --component C00 --title X --points 1 --no-sync
assert_exit "story ids without --feature" 1 "$RC"
assert_contains "story ids need --feature" "bl new takes story ids only with --feature" "$ERR"

blrun new F-9 --component C00 --title X --points 1 --no-sync
assert_exit "unknown feature" 1 "$RC"
assert_contains "unknown feature refused" "Feature F-9 not found" "$ERR"

# --- --feature creates a feature from stories ------------------------------
blrun new --feature --title "Refused" S-1 S-4 --theme demo
assert_exit "a done story" 1 "$RC"
assert_contains "a done story is refused" "S-4 is done" "$ERR"

blrun new --feature --title "Refused" S-5 --theme demo
assert_exit "an in_progress story" 1 "$RC"
assert_contains "an in_progress story is refused" "S-5 is in_progress" "$ERR"

blrun new --feature --title "Refused" S-2 S-3 --theme demo
assert_exit "a story in a feature" 1 "$RC"
assert_contains "a story in a feature is refused" "S-3 is already in F-1." "$ERR"
assert_eq "a refusal writes no feature" "" "$(ls "$DIR/features" | grep -i refused || true)"
assert_eq "a refusal leaves S-1 alone" "" "$(grep '^feature:' "$STORIES/S1-one/index.md" || true)"
assert_eq "a refusal leaves S-2 alone" "" "$(grep '^feature:' "$STORIES/S2-two/index.md" || true)"

blrun new --feature --title "Made" C00
assert_exit "--feature with a component" 1 "$RC"
assert_contains "--feature with a component is refused" "not from a component" "$ERR"

blrun new --feature --title "Made" S-1 S-2 --no-sync --theme demo
assert_exit "new --feature S-1 S-2" 0 "$RC"
assert_contains "new --feature prints the feature file" "features/F3-made/index.md" "$OUT"
FEAT=$(<"$DIR/features/F3-made/index.md")
assert_contains "the feature lists S-1 and S-2" "stories: [S-1, S-2]" "$FEAT"
assert_eq "the feature names no repo: its repos are its stories' (F-52 D3)" "" "$(grep '^primary_repo:' "$DIR/features/F3-made/index.md" || true)"
assert_contains "S-1 is in F-3" "feature: F-3" "$(<"$STORIES/S1-one/index.md")"
assert_contains "S-2 is in F-3" "feature: F-3" "$(<"$STORIES/S2-two/index.md")"

# S-6 carries an empty feature: key; the move fills it rather than adding a second.
sed -i 's/^status: backlog$/status: backlog\nfeature:/' "$STORIES/S6-six/index.md"
blrun new --feature S-6 --title "Value spelling" --no-sync --theme demo
assert_exit "new --feature S-6" 0 "$RC"
assert_contains "--feature S-6 is the switch plus a story" "stories: [S-6]" "$(<"$DIR/features/F4-value-spelling/index.md")"
assert_eq "an empty feature: key is filled, not doubled" "feature: F-4" "$(grep '^feature:' "$STORIES/S6-six/index.md")"

blrun new --feature --title "Empty" --no-sync --theme demo
assert_exit "new --feature with no stories" 0 "$RC"
assert_contains "new --feature with no stories" "features/F5-empty/index.md" "$OUT"

# --- bl list --features ----------------------------------------------------
blrun list --features
assert_exit "list --features" 0 "$RC"
LIST="$OUT"
assert_contains "list --features lists F-1" "F-1" "$LIST"
assert_eq "list --features hides done features" "" "$(grep 'F-2 ' <<<"$LIST" || true)"

blrun list --features -a
assert_exit "list --features -a" 0 "$RC"
LIST_ALL="$OUT"
assert_contains "list --features -a includes done features" "F-2 " "$LIST_ALL"

summary_and_exit
