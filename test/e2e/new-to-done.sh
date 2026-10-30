#!/usr/bin/env bash
# E2E lifecycle test (no git involved):
#   scaffold backlog → bl new → edit body → bl done → bl sync.
# Asserts the story stays where it is with status done (F-49 D3) and the index
# is regenerated.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../helpers/tempdir.sh"

mk_temp_backlog

# --- bl new -----------------------------------------------------------------

INDEX_REL=$("$BL" new C00 --title "Lifecycle Story" --points 1 2>/dev/null)
INDEX_ABS="$TMPDIR_ROOT/$INDEX_REL"
if [[ -f "$INDEX_ABS" ]]; then pass; else fail "bl new did not create $INDEX_ABS"; fi

# --- Edit body in place -----------------------------------------------------

printf '\n## Notes\n\nManual body edit.\n' >> "$INDEX_ABS"

# --- bl done ----------------------------------------------------------------

"$BL" done S-1 deadbeef >/dev/null 2>&1
ARCHIVED="$INDEX_ABS"
if [[ -f "$ARCHIVED" ]]; then pass; else fail "the done story should stay at $INDEX_REL"; fi
if [[ ! -e "$TMPDIR_ROOT/stories/.completed" ]]; then pass; else fail "bl done should move nothing to .completed/"; fi

# Frontmatter should now record status=done.
if grep -q '^status: done' "$ARCHIVED"; then pass; else fail "archived story missing status: done"; fi
if grep -q '^commit: deadbeef' "$ARCHIVED"; then pass; else fail "archived story missing commit"; fi

# Body edit should still be there.
if grep -q 'Manual body edit' "$ARCHIVED"; then pass; else fail "body edit was lost during done"; fi

# --- bl sync (idempotent after done) ----------------------------------------

"$BL" sync >/dev/null 2>&1
"$BL" sync >/dev/null 2>&1   # second run must be a no-op

# The root index should not render completed stories or carry a Completed
# section — those tables were dropped in S-395.
ROOT_INDEX="$TMPDIR_ROOT/index.md"
if grep -q '^## Completed' "$ROOT_INDEX"; then
  fail "root index should not contain a ## Completed heading"
else
  pass
fi
if grep -q 'S-1.*Lifecycle Story' "$ROOT_INDEX"; then
  fail "root index should not list completed S-1 Lifecycle Story"
else
  pass
fi

summary_and_exit
