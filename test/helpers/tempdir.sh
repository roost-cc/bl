#!/usr/bin/env bash
# tempdir.sh — shared scaffolding for cli/ and e2e/ bash tests.
#
# Source this from a test script:
#   source "$(dirname "$0")/../helpers/tempdir.sh"
#   mk_temp_backlog          # populates $TMPDIR_ROOT, exports BL_BACKLOG_DIR,
#                            # registers a trap to clean up on EXIT.
#
# The script must already have set `set -euo pipefail`. PASS / FAIL counters
# and the assert_* helpers are defined here too so individual scripts stay
# small.

if [[ -z "${BL:-}" ]]; then
  HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  BL="$(cd "$HELPER_DIR/../.." && pwd)/bin/bl"
  export BL
fi

if [[ ! -x "$BL" ]]; then
  echo "FAIL: $BL not found or not executable" >&2
  exit 1
fi

# ----- assertion counters -------------------------------------------------
PASS=${PASS:-0}
FAIL=${FAIL:-0}
fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass; else fail "$label — expected '$expected', got '$actual'"; fi
}
assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass; else fail "$label — expected exit $expected, got $actual"; fi
}
assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass; else fail "$label — '$needle' not found in '$haystack'"; fi
}
assert_empty() {
  local label="$1" actual="$2"
  if [[ -z "$actual" ]]; then pass; else fail "$label — expected empty, got '$actual'"; fi
}
assert_nonempty() {
  local label="$1" actual="$2"
  if [[ -n "$actual" ]]; then pass; else fail "$label — expected non-empty, got empty"; fi
}

summary_and_exit() {
  if (( FAIL > 0 )); then
    echo "FAIL: $FAIL test(s) failed; $PASS passed" >&2
    exit 1
  fi
  echo "PASS: $PASS test(s) passed"
}

# ----- tempdir backlog ----------------------------------------------------
# Creates a fresh backlog at $TMPDIR_ROOT with one registered repo,
# demo-repo (whose home component is C00), and exports BL_BACKLOG_DIR. Appends to CLEANUP_PATHS rather than replacing the
# EXIT trap, so callers (or earlier helpers) that already registered cleanups
# aren't silently overwritten. Matches the pattern used in cli/next-id.sh.
mk_temp_backlog() {
  if ! declare -p CLEANUP_PATHS >/dev/null 2>&1; then
    CLEANUP_PATHS=()
    trap 'rm -rf "${CLEANUP_PATHS[@]}"' EXIT
  fi

  TMPDIR_ROOT=$(mktemp -d -t bl-test-XXXXXX)
  CLEANUP_PATHS+=("$TMPDIR_ROOT")

  cat > "$TMPDIR_ROOT/backlog.json" <<'JSON'
{
  "backlog": "backlog",
  "worktrees": "../worktrees",
  "agent": [{ "agent": "claude" }],
  "review_agent": [{ "agent": "claude" }],
  "repos": {
    "demo-repo": { "path": "../demo-repo", "deployable": false, "update_tests": [] }
  }
}
JSON
  cp "$(dirname "$BL")/../templates/flow.json" "$TMPDIR_ROOT/flow.json"

mkdir -p "$TMPDIR_ROOT/components/C00-core"
cat > "$TMPDIR_ROOT/components/C00-core/index.md" <<'MD'
---
component_id: C00
title: Core
repo: demo-repo
home: true
---

# C00 · Core
MD

  export BL_BACKLOG_DIR="$TMPDIR_ROOT"
}
