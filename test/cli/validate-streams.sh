#!/usr/bin/env bash
# Stream policy regression tests for `bl validate`.
#
# Asserts the per-S-392 stdout/stderr split:
#   - human mode: report on stdout, "scanning N stories…" on stderr
#   - --json mode (piped): one JSON line on stdout, stderr empty
#   - --help: help text on stdout, stderr empty
#   - exit codes: 0 (clean), 1 (errors), 2 (--strict + warnings only)
#
# Run from the bl repo root:
#   bash test/cli/validate-streams.sh
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
# Build a clean tempdir backlog with one repo, demo-repo, and two stories.
# ---------------------------------------------------------------------------

setup_clean_backlog() {
  local root="$1"
  cat > "$root/backlog.json" <<JSON
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
  # The statuses and gates per type (F-66 D1): bl init's template.
  cp "$REPO_ROOT/templates/flow.json" "$root/flow.json"
  mkdir -p "$root/components/C00-foundation" "$root/stories/S1-first"
  cat > "$root/components/C00-foundation/index.md" <<'MD'
---
component_id: C00
title: Foundation
repo: demo-repo
home: true
paths: ["**"]
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
  # The feature order (F-53 D1): an empty `ranked:` is a clean one.
  cat > "$root/feature-order.md" <<'MD'
---
ranked: []
---
MD
  # The roadmap (F-53 D2): no entries and no sections is a clean one.
  cat > "$root/roadmap.md" <<'MD'
---
entries: []
---
MD
}

# ---------------------------------------------------------------------------
# Case 1: clean backlog → exit 0, empty stdout, scanning… on stderr.
# ---------------------------------------------------------------------------
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
setup_clean_backlog "$TMP"
export BL_BACKLOG_DIR="$TMP"

so=$(mktemp); se=$(mktemp)
"$BL" validate >"$so" 2>"$se"; rc=$?
assert_eq "validate clean exit 0" "0" "$rc"
out=$(cat "$so"); err=$(cat "$se")
assert_empty "validate clean stdout empty" "$out"
assert_contains "validate clean stderr has scanning…" "scanning" "$err"

# ---------------------------------------------------------------------------
# Case 2: bad-status → exit 1, report on stdout, scanning on stderr.
# ---------------------------------------------------------------------------
TMP2=$(mktemp -d)
setup_clean_backlog "$TMP2"
mkdir -p "$TMP2/stories/S2-bad"
cat > "$TMP2/stories/S2-bad/index.md" <<'MD'
---
component: C00
story_id: S-2
title: Broken
type: feature
points: 1
status: WRONG
---
MD
BL_BACKLOG_DIR="$TMP2" "$BL" validate >"$so" 2>"$se"; rc=$?
assert_eq "validate bad-status exit 1" "1" "$rc"
out=$(cat "$so"); err=$(cat "$se")
assert_contains "validate stdout has bad-status finding" "bad-status" "$out"
assert_contains "validate stdout has trailing summary" "findings" "$out"
assert_contains "validate stderr has scanning…" "scanning" "$err"
case "$err" in
  *"bad-status"*) fail "validate stderr leaked finding text into progress" ;;
  *) pass ;;
esac
rm -rf "$TMP2"

# ---------------------------------------------------------------------------
# Case 3: --json piped → one JSON line on stdout, empty stderr.
# ---------------------------------------------------------------------------
so=$(mktemp); se=$(mktemp)
BL_BACKLOG_DIR="$TMP" "$BL" validate --json >"$so" 2>"$se"; rc=$?
assert_eq "validate --json clean exit 0" "0" "$rc"
err=$(cat "$se")
assert_empty "validate --json piped stderr empty" "$err"
nl=$(wc -l <"$so" | tr -d ' ')
assert_eq "validate --json stdout has exactly one line" "1" "$nl"
if node -e '
  const obj = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(obj.findings)) { console.error("findings"); process.exit(1); }
  if (typeof obj.summary !== "object") { console.error("summary"); process.exit(1); }
  for (const k of ["errors","warnings","total"]) {
    if (typeof obj.summary[k] !== "number") { console.error("summary."+k); process.exit(1); }
  }
' "$so"; then pass; else fail "validate --json schema"; fi

# ---------------------------------------------------------------------------
# Case 4: --strict promotes warnings to exit 2.
# ---------------------------------------------------------------------------
TMP3=$(mktemp -d)
setup_clean_backlog "$TMP3"
# Add a one-sided dep to S-1 → asymmetric-dep warning.
mkdir -p "$TMP3/stories/S2-second"
cat > "$TMP3/stories/S2-second/index.md" <<'MD'
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
BL_BACKLOG_DIR="$TMP3" "$BL" validate >"$so" 2>"$se"; rc=$?
assert_eq "validate warnings-only exit 0" "0" "$rc"
BL_BACKLOG_DIR="$TMP3" "$BL" validate --strict >"$so" 2>"$se"; rc=$?
assert_eq "validate --strict warnings-only exit 2" "2" "$rc"
out=$(cat "$so")
assert_contains "validate --strict stdout still has report" "asymmetric-dep" "$out"
rm -rf "$TMP3"

# ---------------------------------------------------------------------------
# Case 5: --help on stdout, empty stderr, exit 0.
# ---------------------------------------------------------------------------
so=$(mktemp); se=$(mktemp)
"$BL" validate --help >"$so" 2>"$se"; rc=$?
assert_eq "validate --help exit 0" "0" "$rc"
out=$(cat "$so"); err=$(cat "$se")
assert_contains "validate --help has Usage" "Usage: bl validate" "$out"
assert_contains "validate --help has Output: block" "Output:" "$out"
assert_contains "validate --help has Exit codes:" "Exit codes:" "$out"
assert_contains "validate --help mentions stdout" "stdout" "$out"
assert_contains "validate --help mentions stderr" "stderr" "$out"
assert_empty "validate --help stderr empty" "$err"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if (( FAIL > 0 )); then
  echo "FAIL: $FAIL test(s) failed; $PASS passed" >&2
  exit 1
fi
echo "PASS: $PASS test(s) passed"
