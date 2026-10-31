#!/usr/bin/env bash
# Stream policy regression tests for `bl`.
#
# For each command in the `src/AGENTS.md` § Stream policy table, asserts that
# stdout contains exactly the documented content (or is empty) and that
# status / progress messages land on stderr.
#
# Run from the bl repo root:
#   bash test/cli/streams.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"

if [[ ! -x "$BL" ]]; then
  echo "FAIL: $BL not found or not executable" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Per-test scaffolding: a fresh tempdir backlog with one repo, demo-repo.
# ---------------------------------------------------------------------------

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

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


# demo-repo's home component, which the stories below go in.
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
assert_nonempty() {
  local label="$1" actual="$2"
  if [[ -n "$actual" ]]; then pass; else fail "$label — expected non-empty, got empty"; fi
}

# ---------------------------------------------------------------------------
# bl new — stdout is one path line; everything else on stderr
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
"$BL" new C00 --title "First Story" --points 1 >"$so" 2>"$se"

# stdout: exactly one line, ending with /index.md, no "File:" prefix
out=$(cat "$so")
nl=$(wc -l <"$so" | tr -d ' ')
assert_eq "bl new stdout has exactly one line" "1" "$nl"
case "$out" in
  *"index.md") pass ;;
  *) fail "bl new stdout should end in index.md (got: $out)" ;;
esac
case "$out" in
  *"File:"*) fail "bl new stdout should not contain 'File:' prefix (got: $out)" ;;
  *) pass ;;
esac
case "$out" in
  /*) fail "bl new stdout should be a relative path (got: $out)" ;;
  *) pass ;;
esac

# stderr: must contain progress markers (the things that used to be on stdout)
err=$(cat "$se")
assert_contains "bl new stderr has 'New story:'" "New story:" "$err"
assert_contains "bl new stderr has 'Created story:'" "Created story:" "$err"
assert_contains "bl new stderr has 'Syncing backlog'" "Syncing backlog" "$err"
assert_contains "bl new stderr has 'Done.'" "Done." "$err"

# ---------------------------------------------------------------------------
# bl new --json — single JSON object on stdout, status on stderr
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
"$BL" new C00 --title "JSON Story" --points 1 --json \
  >"$so" 2>"$se"
nl=$(wc -l <"$so" | tr -d ' ')
assert_eq "bl new --json stdout has exactly one line" "1" "$nl"
if node -e '
  const obj = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (obj.schema !== "bl-new-json/v3") { console.error("schema"); process.exit(1); }
  if (!/^S-\d+$/.test(obj.id)) { console.error("id"); process.exit(1); }
' "$so"; then pass; else fail "bl new --json stdout schema"; fi

# stderr should still carry the chatter
err=$(cat "$se")
assert_contains "bl new --json stderr has Syncing" "Syncing" "$err"

# ---------------------------------------------------------------------------
# bl new --print-template story — template body on stdout, no status
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
"$BL" new --print-template story >"$so" 2>"$se"
out=$(cat "$so")
case "$out" in
  *"---"*) pass ;;
  *) fail "bl new --print-template story expected frontmatter on stdout" ;;
esac
err=$(cat "$se")
assert_empty "bl new --print-template story stderr empty" "$err"

# ---------------------------------------------------------------------------
# bl new --print-template --json — refused with clear error
# ---------------------------------------------------------------------------

set +e
so=$(mktemp); se=$(mktemp)
"$BL" new --print-template story --json >"$so" 2>"$se"; rc=$?
set -e
assert_eq "bl new --print-template --json exit" "1" "$rc"
size=$(wc -c <"$so" | tr -d ' ')
assert_eq "bl new --print-template --json stdout empty" "0" "$size"
err=$(cat "$se")
assert_contains "bl new --print-template --json explains why" "cannot be combined" "$err"

# ---------------------------------------------------------------------------
# bl sync — stdout empty; stderr has progress
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
"$BL" sync >"$so" 2>"$se"
size=$(wc -c <"$so" | tr -d ' ')
assert_eq "bl sync stdout empty" "0" "$size"
err=$(cat "$se")
assert_contains "bl sync stderr has 'backlog-sync'" "backlog-sync" "$err"
assert_contains "bl sync stderr has 'done.'" "done." "$err"

# ---------------------------------------------------------------------------
# bl which — stdout is one absolute path line
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
"$BL" which S-1 >"$so" 2>"$se"
out=$(cat "$so")
nl=$(wc -l <"$so" | tr -d ' ')
assert_eq "bl which stdout has exactly one line" "1" "$nl"
case "$out" in
  /*"/index.md") pass ;;
  *) fail "bl which stdout should be absolute /…/index.md (got: $out)" ;;
esac
err=$(cat "$se")
assert_empty "bl which stderr empty" "$err"

# ---------------------------------------------------------------------------
# bl list / ls — stdout has the table; stderr empty in normal case
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
"$BL" list >"$so" 2>"$se"
out=$(cat "$so")
assert_nonempty "bl list stdout non-empty" "$out"
assert_contains "bl list stdout has S-1" "S-1" "$out"
err=$(cat "$se")
assert_empty "bl list stderr empty (with stories present)" "$err"

# ---------------------------------------------------------------------------
# bl status (no ids) — the same table on stdout; stderr empty in normal case
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
"$BL" status >"$so" 2>"$se"
out=$(cat "$so")
assert_nonempty "bl status stdout non-empty" "$out"
assert_contains "bl status stdout has S-1" "S-1" "$out"
err=$(cat "$se")
assert_empty "bl status stderr empty (with stories present)" "$err"

# ---------------------------------------------------------------------------
# bl tree — stdout empty when no deps recorded; explanation on stderr
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
"$BL" tree >"$so" 2>"$se"
size=$(wc -c <"$so" | tr -d ' ')
assert_eq "bl tree stdout empty (no deps)" "0" "$size"
err=$(cat "$se")
assert_contains "bl tree stderr explains" "No dependency trees" "$err"

# ---------------------------------------------------------------------------
# bl what-next — stdout has at most the story ID; reasoning on stderr
# ---------------------------------------------------------------------------

# No closed stories yet → empty stdout, explanation on stderr.
so=$(mktemp); se=$(mktemp)
"$BL" what-next >"$so" 2>"$se"
size=$(wc -c <"$so" | tr -d ' ')
assert_eq "bl what-next stdout empty (no closed stories)" "0" "$size"
err=$(cat "$se")
assert_contains "bl what-next stderr explains" "No closed stories" "$err"

# Mark S-1 done, link required_for so what-next has a chain to follow.
# We mutate frontmatter directly because `bl done` is not in scope here.
S1=$("$BL" which S-1)
S2=$("$BL" which S-2)
# Add required_for: S-2 to S-1, depends_on: S-1 to S-2.
node -e '
  const fs = require("fs");
  const path1 = process.argv[1];
  const path2 = process.argv[2];
  let t1 = fs.readFileSync(path1, "utf8")
    .replace(/^required_for:.*$/m, "required_for: [S-2]");
  fs.writeFileSync(path1, t1);
  let t2 = fs.readFileSync(path2, "utf8")
    .replace(/^depends_on:.*$/m, "depends_on: [S-1]");
  fs.writeFileSync(path2, t2);
' "$S1" "$S2"

# Mark S-1 done by editing frontmatter (skip bl done — just need a closed story).
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  let t = fs.readFileSync(p, "utf8")
    .replace(/^status:.*$/m, "status: done")
    .replace(/^completed:.*$/m, "completed: 2026-05-03")
    .replace(/^commit:.*$/m, "commit: deadbee");
  fs.writeFileSync(p, t);
' "$S1"

"$BL" sync >/dev/null 2>&1

so=$(mktemp); se=$(mktemp)
"$BL" what-next >"$so" 2>"$se"
out=$(cat "$so")
nl=$(wc -l <"$so" | tr -d ' ')
assert_eq "bl what-next suggests one ID" "1" "$nl"
case "$out" in
  S-*) pass ;;
  *) fail "bl what-next stdout should be a story id (got: '$out')" ;;
esac
err=$(cat "$se")
assert_contains "bl what-next stderr has 'Next:'" "Next:" "$err"

# ---------------------------------------------------------------------------
# bl deps — stdout is bare story IDs, one per line; the plan goes to stderr
# ---------------------------------------------------------------------------

# S-2 depends_on S-1 (done, from the what-next setup above), so the cone for
# S-2 prunes down to S-2 itself.
so=$(mktemp); se=$(mktemp)
"$BL" deps S-2 >"$so" 2>"$se"
out=$(cat "$so")
assert_eq "bl deps stdout is the target alone" "S-2" "$out"
err=$(cat "$se")
assert_contains "bl deps stderr has the plan header" "Plan for S-2" "$err"

# Every stdout line must be a bare ID — no titles, counts, or blank lines.
while IFS= read -r line; do
  case "$line" in
    S-*) ;;
    *) fail "bl deps stdout line should be a bare story id (got: '$line')" ;;
  esac
done <"$so"
pass

# A done target: nothing on stdout, explanation on stderr.
so=$(mktemp); se=$(mktemp)
"$BL" deps S-1 >"$so" 2>"$se"
size=$(wc -c <"$so" | tr -d ' ')
assert_eq "bl deps stdout empty (done target)" "0" "$size"
err=$(cat "$se")
assert_contains "bl deps stderr explains done target" "is done" "$err"

# ---------------------------------------------------------------------------
# bl agents — full AGENTS.md content on stdout, empty stderr
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
"$BL" agents >"$so" 2>"$se"
out=$(cat "$so")
assert_contains "bl agents stdout has section header" "Stream policy" "$out"
err=$(cat "$se")
assert_empty "bl agents stderr empty" "$err"

# ---------------------------------------------------------------------------
# bl --help / bl <cmd> --help — help text on stdout; empty stderr
# ---------------------------------------------------------------------------

for cmd in "" "new" "sync" "list" "which" "what-next" "deps" "tree" "grep" "agents"; do
  so=$(mktemp); se=$(mktemp)
  if [[ -z "$cmd" ]]; then
    "$BL" --help >"$so" 2>"$se"
    label="bl --help"
  else
    "$BL" "$cmd" --help >"$so" 2>"$se"
    label="bl $cmd --help"
  fi
  out=$(cat "$so")
  err=$(cat "$se")
  assert_contains "$label stdout has 'Usage:'" "Usage:" "$out"
  assert_empty "$label stderr empty" "$err"
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if (( FAIL > 0 )); then
  echo "FAIL: $FAIL test(s) failed; $PASS passed" >&2
  exit 1
fi
echo "PASS: $PASS test(s) passed"
