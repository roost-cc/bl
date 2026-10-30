#!/usr/bin/env bash
# Smoke test for `bl next-id` and `bl new --json`.
# Exits 0 on success; non-zero on the first failed assertion.
#
# Run from the bl repo root:
#   bash test/cli/next-id.sh
set -euo pipefail

# Resolve the bl repo root (script lives at bl/test/cli/next-id.sh).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"

if [[ ! -x "$BL" ]]; then
  echo "FAIL: $BL not found or not executable" >&2
  exit 1
fi

# Make a fresh tempdir backlog. We bypass `bl init` (which would prompt) and
# scaffold a minimal layout by hand.
#
# All temp paths are accumulated into CLEANUP_PATHS and removed by a single
# EXIT trap. Don't replace the trap later — push paths instead.
CLEANUP_PATHS=()
trap 'rm -rf "${CLEANUP_PATHS[@]}"' EXIT

# Push to CLEANUP_PATHS in the same statement as the mktemp so a failure in any
# subsequent setup line still triggers cleanup. (Otherwise an early failure
# would also fire `rm -rf` with no args, causing a "missing operand" warning.)
TMPDIR_ROOT=$(mktemp -d) && CLEANUP_PATHS+=("$TMPDIR_ROOT")

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


export BL_BACKLOG_DIR="$TMPDIR_ROOT"

PASS=0
FAIL=0
fail() {
  echo "FAIL: $1" >&2
  FAIL=$((FAIL + 1))
}
pass() {
  PASS=$((PASS + 1))
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass
  else
    fail "$label — expected exit $expected, got $actual"
  fi
}

# ---------------------------------------------------------------------------
# bl next-id story / component — empty backlog
# ---------------------------------------------------------------------------

out=$("$BL" next-id story)
assert_eq "next-id story (empty backlog)" "S-1" "$out"

out=$("$BL" next-id component)
assert_eq "next-id component (empty backlog)" "C00" "$out"

# Epics start at E50: E00–E49 were components (F-49 D2, F-51 D1).
out=$("$BL" next-id epic)
assert_eq "next-id epic (empty backlog)" "E50" "$out"

out=$("$BL" next-id task)
assert_eq "next-id task (empty backlog)" "T-1" "$out"

# ---------------------------------------------------------------------------
# --count
# ---------------------------------------------------------------------------

out=$("$BL" next-id story --count 7)
expected=$(printf "S-1\nS-2\nS-3\nS-4\nS-5\nS-6\nS-7")
assert_eq "next-id story --count 7" "$expected" "$out"

# Trailing newline check: stdout must end in exactly one \n (no blank line).
# `wc -l` counts lines (which equals the number of trailing newlines for a
# file that ends in one). Two IDs printed → exactly 2 newlines.
nl=$("$BL" next-id story --count 2 | wc -l | tr -d ' ')
assert_eq "next-id story --count 2 line count" "2" "$nl"
# And the content matches.
out=$("$BL" next-id story --count 2)
expected=$(printf "S-1\nS-2")
assert_eq "next-id story --count 2 content" "$expected" "$out"

out=$("$BL" next-id component --count 3)
expected=$(printf "C00\nC01\nC02")
assert_eq "next-id component --count 3" "$expected" "$out"

out=$("$BL" next-id epic --count 2)
expected=$(printf "E50\nE51")
assert_eq "next-id epic --count 2" "$expected" "$out"

# An epic past 2^53 keeps its exact successor (no float rounding).
mkdir -p "$TMPDIR_ROOT/epics/E9007199254740993-big"
printf -- '---\ntitle: Big\ntheme: demo\n---\n' >| "$TMPDIR_ROOT/epics/E9007199254740993-big/index.md"
out=$("$BL" next-id epic --count 2)
expected=$(printf "E9007199254740994\nE9007199254740995")
assert_eq "next-id epic --count 2 past 2^53" "$expected" "$out"
rm -rf "$TMPDIR_ROOT/epics/E9007199254740993-big"

# ---------------------------------------------------------------------------
# --project is an unknown option (F-51 D5)
# ---------------------------------------------------------------------------

err=$("$BL" next-id story --project demo 2>&1 >/dev/null || true)
case "$err" in
  *'unknown option "--project"'*) pass ;;
  *) fail "next-id --project not refused as an unknown option (got: $err)" ;;
esac

# ---------------------------------------------------------------------------
# Invalid --count
# ---------------------------------------------------------------------------

set +e
out=$("$BL" next-id story --count 0 2>/dev/null); rc=$?
set -e
assert_exit "next-id --count 0 exit" "1" "$rc"
assert_eq  "next-id --count 0 stdout empty" "" "$out"

# A separate `-1` token is refused as a value (it looks like an option), so
# --count is left without one; the negative number itself goes inline.
set +e
out=$("$BL" next-id story --count -1 2>/dev/null); rc=$?
err=$("$BL" next-id story --count -1 2>&1 >/dev/null)
set -e
assert_exit "next-id --count -1 exit" "1" "$rc"
assert_eq  "next-id --count -1 stdout empty" "" "$out"
case "$err" in
  *"--count requires a value"*) pass ;;
  *) fail "next-id --count -1 should report a missing value (got: $err)" ;;
esac

set +e
out=$("$BL" next-id story --count=-1 2>/dev/null); rc=$?
err=$("$BL" next-id story --count=-1 2>&1 >/dev/null)
set -e
assert_exit "next-id --count=-1 exit" "1" "$rc"
assert_eq  "next-id --count=-1 stdout empty" "" "$out"
case "$err" in
  *"--count must be between 1 and 1000"*) pass ;;
  *) fail "next-id --count=-1 should reject the negative number (got: $err)" ;;
esac

set +e
out=$("$BL" next-id story --count abc 2>/dev/null); rc=$?
set -e
assert_exit "next-id --count abc exit" "1" "$rc"
assert_eq  "next-id --count abc stdout empty" "" "$out"

set +e
out=$("$BL" next-id story --count 1001 2>/dev/null); rc=$?
set -e
assert_exit "next-id --count 1001 exit" "1" "$rc"
assert_eq  "next-id --count 1001 stdout empty" "" "$out"

# ---------------------------------------------------------------------------
# Unknown kind
# ---------------------------------------------------------------------------

set +e
err=$("$BL" next-id banana 2>&1 >/dev/null); rc=$?
set -e
assert_exit "next-id banana exit" "1" "$rc"
case "$err" in
  *"kind must be 'story', 'component', 'epic' or 'task'"*) pass ;;
  *) fail "next-id banana error message missing (got: $err)" ;;
esac
case "$err" in
  *"Usage:"*) pass ;;
  *) fail "next-id banana missing Usage: line" ;;
esac

# ---------------------------------------------------------------------------
# --help
# ---------------------------------------------------------------------------

set +e
out=$("$BL" next-id --help); rc=$?
set -e
assert_exit "next-id --help exit" "0" "$rc"
case "$out" in
  *"Usage:"*) pass ;;
  *) fail "next-id --help missing Usage:" ;;
esac

# ---------------------------------------------------------------------------
# next-id does NOT log to activity log
#
# `src/log.js:62-67` resolves the log path via `git rev-parse --show-toplevel`
# inside a real worktree. To exercise that code path we make a tempdir git
# worktree (init + worktree add) and run `bl next-id` from inside it, then
# check that `<git-root>/.bl/activity.log` is unchanged (or .bl/ does not
# exist).
# ---------------------------------------------------------------------------

WT_BASE=$(mktemp -d)
CLEANUP_PATHS+=("$WT_BASE")
git -C "$WT_BASE" init -q
git -C "$WT_BASE" -c user.email=t@t -c user.name=t commit --allow-empty -q -m init
git -C "$WT_BASE" worktree add -q -b s-next-id-probe "$WT_BASE/wt" >/dev/null 2>&1

ACTIVITY_LOG="$WT_BASE/wt/.bl/activity.log"
log_size() {
  if [[ -f "$ACTIVITY_LOG" ]]; then wc -c <"$ACTIVITY_LOG" | tr -d ' '; else echo 0; fi
}
before=$(log_size)
( cd "$WT_BASE/wt" && "$BL" next-id story >/dev/null )
( cd "$WT_BASE/wt" && "$BL" next-id component --count 5 >/dev/null )
after=$(log_size)
assert_eq "next-id does not append to activity log" "$before" "$after"

# ---------------------------------------------------------------------------
# bl new --component --json, then next-id component moves on
# ---------------------------------------------------------------------------

so0=$(mktemp); se0=$(mktemp)
CLEANUP_PATHS+=("$so0" "$se0")
set +e
"$BL" new --component --json --repo demo-repo --title "First Component" --paths "**" --home >"$so0" 2>"$se0"
rc=$?
set -e
assert_exit "bl new --component --json exit" "0" "$rc"
node -e '
const obj = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const want = { schema: "bl-new-component-json/v1", id: "C00", path: "components/C00-first-component/index.md", repo: "demo-repo", home: true, paths: ["**"] };
if (JSON.stringify(obj) !== JSON.stringify(want)) { console.error("got " + JSON.stringify(obj)); process.exit(1); }
' "$so0"
if [[ $? -eq 0 ]]; then pass; else fail "bl new --component --json"; fi
out=$("$BL" next-id component)
assert_eq "next-id component after one" "C01" "$out"

# ---------------------------------------------------------------------------
# bl new --json — happy path
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
CLEANUP_PATHS+=("$so" "$se")
set +e
"$BL" new --json C00 --title "First Story" --points 1 >"$so" 2>"$se"
rc=$?
set -e
assert_exit "bl new --json exit" "0" "$rc"

# Stdout must be ONLY a single JSON object.
node -e '
const txt = require("fs").readFileSync(process.argv[1], "utf8");
const lines = txt.split("\n").filter(Boolean);
if (lines.length !== 1) { console.error("expected exactly one line on stdout, got " + lines.length); process.exit(1); }
const obj = JSON.parse(lines[0]);
const errors = [];
if (obj.schema !== "bl-new-json/v3") errors.push("schema");
if (!/^S-\d+$/.test(obj.id)) errors.push("id");
if (obj.path !== "stories/S1-first-story/index.md") errors.push("path");
if (obj.component !== "C00") errors.push("component");
if ("epic" in obj) errors.push("no epic key in v2");
if ("project" in obj) errors.push("no project key in v3");
if (obj.primary_repo !== "demo-repo") errors.push("primary_repo is the component repo");
if (errors.length) { console.error("validation failed: " + errors.join(", ")); process.exit(1); }
' "$so"
if [[ $? -eq 0 ]]; then pass; else fail "bl new --json schema validation"; fi

# ---------------------------------------------------------------------------
# bl new --json --repo with no component — the repo's home component
# ---------------------------------------------------------------------------

so2=$(mktemp); se2=$(mktemp)
CLEANUP_PATHS+=("$so2" "$se2")
"$BL" new --json --repo demo-repo --title "Second Story" --points 1 \
  >"$so2" 2>"$se2"
node -e '
const obj = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (obj.component !== "C00") { console.error("component should be the home C00, got " + obj.component); process.exit(1); }
if (obj.id !== "S-2") { console.error("expected id S-2, got " + obj.id); process.exit(1); }
' "$so2"
if [[ $? -eq 0 ]]; then pass; else fail "bl new --json --repo home component"; fi

# ---------------------------------------------------------------------------
# bl new --json error path — missing --title — stdout empty, exit 1
# ---------------------------------------------------------------------------

so3=$(mktemp); se3=$(mktemp)
CLEANUP_PATHS+=("$so3" "$se3")
set +e
"$BL" new --json C00 --points 1 </dev/null >"$so3" 2>"$se3"
rc=$?
set -e
assert_exit "bl new --json missing-title exit" "1" "$rc"
size=$(wc -c <"$so3" | tr -d ' ')
assert_eq "bl new --json missing-title stdout empty" "0" "$size"

# ---------------------------------------------------------------------------
# bl new --help mentions --json
# ---------------------------------------------------------------------------

helptxt=$("$BL" new --help)
case "$helptxt" in
  *"--json"*) pass ;;
  *) fail "bl new --help missing --json" ;;
esac

# ---------------------------------------------------------------------------
# bl --help lists next-id
# ---------------------------------------------------------------------------

helptxt=$("$BL" --help)
case "$helptxt" in
  *"next-id"*) pass ;;
  *) fail "bl --help missing next-id" ;;
esac

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if (( FAIL > 0 )); then
  echo "FAIL: $FAIL test(s) failed; $PASS passed" >&2
  exit 1
fi
echo "PASS: $PASS test(s) passed"
