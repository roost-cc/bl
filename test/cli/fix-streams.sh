#!/usr/bin/env bash
# Stream policy regression tests for `bl fix`.
#
# Mirrors test/cli/validate-streams.sh — asserts the per-S-392 stdout/stderr
# split for fix:
#   - human mode: report on stdout, "scanning N stories…" on stderr
#   - --json mode (piped): one JSON line on stdout, stderr empty
#   - --help: help text on stdout, stderr empty
#   - exit codes: 0 (clean), 2 (bad args)
#   - S-858: unknown options / positionals exit 2 before anything is written.
#   - F-77 D3: no code is supported (asymmetric-dep is gone: an edge is stated
#     once, today in blockers.json), so every run prints the empty report.
#
# Run from the bl repo root:
#   bash test/cli/fix-streams.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"

if [[ ! -x "$BL" ]]; then
  echo "FAIL: $BL not found or not executable" >&2
  exit 1
fi

PASS=0
FAIL=0
fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass; else fail "$label — expected '$expected', got '$actual'"; fi
}
assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass; else fail "$label — '$needle' not found in '$haystack'"; fi
}
assert_empty() {
  local label="$1" actual="$2"
  if [[ -z "$actual" ]]; then pass; else fail "$label — expected empty, got '$actual'"; fi
}

# ---------------------------------------------------------------------------
# Build a tempdir backlog with one one-sided depends_on edge.
# ---------------------------------------------------------------------------

setup_asym_backlog() {
  local root="$1"
  cat > "$root/backlog.json" <<JSON
{
  "backlog": "backlog",
  "worktrees": "../worktrees",
  "agent": [{ "agent": "claude" }],
  "review_agent": [{ "agent": "claude" }],
  "effort": { "refine": "high", "review": "high", "default": "high" },
  "repos": {
    "demo-repo": { "path": "../demo-repo", "deployable": false, "update_tests": [] }
  }
}
JSON
  mkdir -p "$root/components/C00-foundation" "$root/stories/S1-first"
  mkdir -p "$root/stories/S2-second"
  cat > "$root/components/C00-foundation/index.md" <<'MD'
---
component_id: C00
title: Foundation
repo: demo-repo
home: true
---
MD
  cat > "$root/stories/S1-first/index.md" <<'MD'
---
component: C00
story_id: S-1
title: First
type: feature
points: 1
status: backlog
---
MD
  cat > "$root/stories/S2-second/index.md" <<'MD'
---
component: C00
story_id: S-2
title: Second
type: feature
points: 1
status: backlog
depends_on: [S-1]
---
MD
}

# Checksum of every story file in a fixture backlog.
fixture_sum() {
  cat "$1"/stories/S*/index.md | md5sum
}

# ---------------------------------------------------------------------------
# Case 1: a one-sided depends_on is not a finding: exit 0, empty stdout,
# scanning on stderr, nothing written.
# ---------------------------------------------------------------------------
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
setup_asym_backlog "$TMP"
export BL_BACKLOG_DIR="$TMP"
SUM1_BEFORE=$(fixture_sum "$TMP")

so=$(mktemp); se=$(mktemp)
"$BL" fix >"$so" 2>"$se"; rc=$?
assert_eq "fix one-sided exit 0" "0" "$rc"
out=$(cat "$so"); err=$(cat "$se")
assert_empty "fix one-sided stdout empty" "$out"
assert_contains "fix stderr has scanning" "scanning" "$err"
assert_eq "fix one-sided writes nothing" "$SUM1_BEFORE" "$(fixture_sum "$TMP")"

# ---------------------------------------------------------------------------
# Case 3: --json piped → one JSON line on stdout, empty stderr.
# ---------------------------------------------------------------------------
TMP2=$(mktemp -d)
setup_asym_backlog "$TMP2"
BL_BACKLOG_DIR="$TMP2" "$BL" fix --json >"$so" 2>"$se"; rc=$?
assert_eq "fix --json exit 0" "0" "$rc"
err=$(cat "$se")
assert_empty "fix --json piped stderr empty" "$err"
nl=$(wc -l <"$so" | tr -d ' ')
assert_eq "fix --json stdout has exactly one line" "1" "$nl"
if node -e '
  const obj = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(obj.fixes)) { console.error("fixes"); process.exit(1); }
  if (typeof obj.summary !== "object") { console.error("summary"); process.exit(1); }
  if (typeof obj.summary.total !== "number") { console.error("summary.total"); process.exit(1); }
  if (typeof obj.summary.byCode !== "object") { console.error("summary.byCode"); process.exit(1); }
  if (obj.fixes.length !== 0 || obj.summary.total !== 0) { console.error("not empty"); process.exit(1); }
' "$so"; then pass; else fail "fix --json schema"; fi
rm -rf "$TMP2"

# ---------------------------------------------------------------------------
# Case 4: --dry-run prints the empty report, leaves files unchanged.
# ---------------------------------------------------------------------------
TMP3=$(mktemp -d)
setup_asym_backlog "$TMP3"
S1_BEFORE=$(stat -c %Y "$TMP3/stories/S1-first/index.md")
sleep 0.05
BL_BACKLOG_DIR="$TMP3" "$BL" fix --dry-run >"$so" 2>"$se"; rc=$?
assert_eq "fix --dry-run exit 0" "0" "$rc"
out=$(cat "$so")
assert_empty "fix --dry-run stdout empty" "$out"
S1_AFTER=$(stat -c %Y "$TMP3/stories/S1-first/index.md")
assert_eq "fix --dry-run leaves mtime unchanged" "$S1_BEFORE" "$S1_AFTER"
rm -rf "$TMP3"

# ---------------------------------------------------------------------------
# Case 5: bogus --code → exit 2, usage on stderr.
# ---------------------------------------------------------------------------
"$BL" fix --code not-a-code >"$so" 2>"$se"; rc=$?
assert_eq "fix --code bogus exit 2" "2" "$rc"
err=$(cat "$se")
assert_contains "fix --code bogus stderr has unknown" "unknown --code" "$err"

# ---------------------------------------------------------------------------
# Case 6: --help on stdout, empty stderr, exit 0.
# ---------------------------------------------------------------------------
"$BL" fix --help >"$so" 2>"$se"; rc=$?
assert_eq "fix --help exit 0" "0" "$rc"
out=$(cat "$so"); err=$(cat "$se")
assert_contains "fix --help has Usage" "Usage: bl fix" "$out"
assert_contains "fix --help has Output: block" "Output:" "$out"
assert_contains "fix --help has Exit codes:" "Exit codes:" "$out"
assert_contains "fix --help mentions stdout" "stdout" "$out"
assert_contains "fix --help mentions stderr" "stderr" "$out"
assert_contains "fix --help lists no code" "(none)" "$out"
assert_empty "fix --help stderr empty" "$err"

# ---------------------------------------------------------------------------
# Case 7 (S-858): unknown option or stray positional → exit 2, one line on
# stderr, nothing on stdout, nothing read or written.
# ---------------------------------------------------------------------------
TMP7=$(mktemp -d)
setup_asym_backlog "$TMP7"
SUM7_BEFORE=$(fixture_sum "$TMP7")

check_rejected() {
  local label="$1" expected_err="$2"; shift 2
  BL_BACKLOG_DIR="$TMP7" "$BL" fix "$@" >"$so" 2>"$se"; rc=$?
  assert_eq "$label exit 2" "2" "$rc"
  out=$(cat "$so"); err=$(cat "$se")
  assert_eq "$label stderr" "$expected_err" "$err"
  assert_empty "$label stdout empty" "$out"
  assert_eq "$label leaves fixture untouched" "$SUM7_BEFORE" "$(fixture_sum "$TMP7")"
}

check_rejected "fix --bogus" 'bl fix: unknown option "--bogus"' --bogus
check_rejected "fix --bogus value" 'bl fix: unknown option "--bogus"' --bogus value
check_rejected "fix --bogus=value" 'bl fix: unknown option "--bogus"' --bogus=value
check_rejected "fix --dry-run --bogus" 'bl fix: unknown option "--bogus"' --dry-run --bogus
check_rejected "fix --json --bogus" 'bl fix: unknown option "--bogus"' --json --bogus
check_rejected "fix --bogus --json" 'bl fix: unknown option "--bogus"' --bogus --json
check_rejected "fix S-1" 'bl fix: unexpected argument "S-1"' S-1
check_rejected "fix --story (no value)" 'bl fix: option "--story" needs a value' --story

# ---------------------------------------------------------------------------
# Case 8 (S-858): unknown --story → exit 2 before anything is written.
# ---------------------------------------------------------------------------
check_rejected "fix --story S-999" 'bl fix: unknown --story "S-999"' --story S-999
check_rejected "fix --story S-1 --story S-999" 'bl fix: unknown --story "S-999"' --story S-1 --story S-999
check_rejected "fix --story bogus" 'bl fix: unknown --story "bogus"' --story bogus
check_rejected "fix --story S-999 --dry-run" 'bl fix: unknown --story "S-999"' --story S-999 --dry-run

# --help still wins over a bad option.
BL_BACKLOG_DIR="$TMP7" "$BL" fix --bogus --help >"$so" 2>"$se"; rc=$?
assert_eq "fix --bogus --help exit 0" "0" "$rc"
assert_contains "fix --bogus --help prints usage" "Usage: bl fix" "$(cat "$so")"
assert_contains "fix --help documents --story" "--story <id>" "$(cat "$so")"
rm -rf "$TMP7"

# ---------------------------------------------------------------------------
# Case 9 (S-858): --story and --theme are still judged and scope a run that
# finds nothing; --project is an unknown option (F-51 D5).
# ---------------------------------------------------------------------------
TMP9=$(mktemp -d)
setup_asym_backlog "$TMP9"
mkdir -p "$TMP9/themes/demo"
cat > "$TMP9/themes/demo/index.md" <<'MD'
---
theme_id: demo
title: Demo
repos: [demo-repo]
---

# Demo

## Overview
MD
SUM9_BEFORE=$(fixture_sum "$TMP9")
for args in "--story s2" "--dry-run --story S-2" "--theme demo --story S-2"; do
  # shellcheck disable=SC2086
  BL_BACKLOG_DIR="$TMP9" "$BL" fix $args >"$so" 2>"$se"; rc=$?
  assert_eq "fix $args exit 0" "0" "$rc"
  assert_empty "fix $args stdout empty" "$(cat "$so")"
done
BL_BACKLOG_DIR="$TMP9" "$BL" fix --project demo --story S-2 >"$so" 2>"$se"; rc=$?
assert_eq "fix --project exit 2" "2" "$rc"
assert_contains "fix --project is an unknown option" 'unknown option "--project"' "$(cat "$se")"
assert_eq "fix --story/--theme write nothing" "$SUM9_BEFORE" "$(fixture_sum "$TMP9")"
rm -rf "$TMP9"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if (( FAIL > 0 )); then
  echo "FAIL: $FAIL test(s) failed; $PASS passed" >&2
  exit 1
fi
echo "PASS: $PASS test(s) passed"
