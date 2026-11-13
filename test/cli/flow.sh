#!/usr/bin/env bash
# `bl flow` (F-119 D3): each type's transitions as a table. Outside a backlog
# it prints bl's template flow.json (as --help does); in a backlog it prints
# that backlog's file, and a file bl cannot read stops it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"

# A non-git tempdir as cwd, so bl's activity log is not written (see help.sh).
TMP=$(mktemp -d -t bl-flow-XXXXXX)
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/outside" "$TMP/backlog"
cd "$TMP/outside"
unset BL_BACKLOG_DIR

PASS=0
FAIL=0
fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }
assert_contains() {
  if [[ "$3" == *"$2"* ]]; then pass; else fail "$1 — '$2' not found in: $3"; fi
}
assert_not_contains() {
  if [[ "$3" != *"$2"* ]]; then pass; else fail "$1 — '$2' found"; fi
}
assert_eq() {
  if [[ "$3" == "$2" ]]; then pass; else fail "$1 — expected '$2', got '$3'"; fi
}

# Outside a backlog: the template.
out=$("$BL" flow 2>&1)
assert_contains "outside: names the template" "templates/flow.json" "$out"
for type in story feature batch task; do
  assert_contains "outside: a $type table" "### $type" "$out"
done
assert_contains "outside: the header row" "| From " "$out"
assert_contains "outside: refine's gates are its nominal path" "in_refinement, refined" "$out"
assert_contains "outside: a new row starts from (none)" "| (none) " "$out"
assert_not_contains "outside: no force row" "| force " "$out"

# --help names the format document.
out=$("$BL" flow --help 2>&1)
assert_contains "--help: Usage" "Usage: bl flow" "$out"
assert_contains "--help: names the format document" "bl/templates/flow.schema.md" "$out"

# An argument is refused.
set +e
"$BL" flow S-1 >/dev/null 2>&1
rc=$?
set -e
assert_eq "an argument exits 1" "1" "$rc"

# In a backlog: its own flow.json, a verb the template lacks shown.
cat >"$TMP/backlog/backlog.json" <<'JSON'
{ "backlog": "backlog", "worktrees": "../worktrees", "agent": [{ "agent": "claude" }],
  "review_agent": [{ "agent": "claude" }], "effort": { "default": "high" }, "repos": {} }
JSON
node -e '
  const fs = require("fs");
  const flow = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  flow.types.task.verbs.reopen = { from: ["done"], success: [{ to: "draft" }] };
  fs.writeFileSync(process.argv[2], JSON.stringify(flow));
' "$REPO_ROOT/templates/flow.json" "$TMP/backlog/flow.json"
out=$(env BL_BACKLOG_DIR="$TMP/backlog" "$BL" flow 2>&1)
assert_contains "backlog: names its file" "$TMP/backlog/flow.json" "$out"
assert_contains "backlog: its own verb" "| reopen " "$out"

# A flow.json bl cannot read stops bl flow, not the template in its place.
printf '{' >|"$TMP/backlog/flow.json"
set +e
out=$(env BL_BACKLOG_DIR="$TMP/backlog" "$BL" flow 2>&1)
rc=$?
set -e
assert_eq "broken flow.json exits 1" "1" "$rc"
assert_contains "broken flow.json: names the fault" "not valid JSON" "$out"

if ((FAIL > 0)); then
  echo "FAIL: $FAIL test(s) failed; $PASS passed" >&2
  exit 1
fi
echo "PASS: $PASS test(s) passed"
