#!/usr/bin/env bash
# Smoke test for `bl --help` and per-command `--help`. Stdout must carry the
# help text; stderr must stay empty. The command list is derived from `bl
# --help` so a new subcommand is automatically covered.
#
# IMPORTANT: `bl <cmd>` calls `logAppend()` before dispatch (`src/bl.js`),
# which writes to `<git-root>/.bl/activity.log` whenever cwd is inside a
# worktree. Running this loop with the developer's bl checkout as cwd would
# pollute that log. So we cd into a non-git tempdir for the whole run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"

TMP_CWD=$(mktemp -d -t bl-help-XXXXXX)
ERR_FILES=()
trap 'rm -rf "$TMP_CWD" "${ERR_FILES[@]}"' EXIT
cd "$TMP_CWD"

PASS=0
FAIL=0
fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass; else fail "$label — '$needle' not found"; fi
}
assert_empty() {
  local label="$1" actual="$2"
  if [[ -z "$actual" ]]; then pass; else fail "$label — expected empty, got '$actual'"; fi
}

# Run `bl <args>` and emit "<rc>\x1f<stdout>\x1f<stderr-path>". `set +e` is
# scoped tightly so a non-zero exit is reported as a real failure rather than
# silently aborting the whole script.
capture_help() {
  local err out rc
  err=$(mktemp)
  ERR_FILES+=("$err")
  set +e
  out=$("$@" 2>"$err")
  rc=$?
  set -e
  printf '%s\x1f%s\x1f%s' "$rc" "$out" "$err"
}

split_capture() {
  local raw="$1"
  CAP_RC=${raw%%$'\x1f'*}
  raw=${raw#*$'\x1f'}
  CAP_OUT=${raw%%$'\x1f'*}
  CAP_ERR_FILE=${raw#*$'\x1f'}
  CAP_ERR=$(<"$CAP_ERR_FILE")
}

assert_help_exit_zero() {
  local label="$1" rc="$2"
  if [[ "$rc" == "0" ]]; then pass; else fail "$label — expected exit 0, got $rc"; fi
}

# bl --help (top-level)
result=$(capture_help "$BL" --help)
split_capture "$result"
assert_help_exit_zero "bl --help exit" "$CAP_RC"
assert_contains "bl --help mentions Usage" "Usage:" "$CAP_OUT"
assert_contains "bl --help lists 'new'" "new" "$CAP_OUT"
assert_empty "bl --help stderr empty" "$CAP_ERR"

# Derive the command list from `bl --help`. The "Commands:" section lists each
# command as `  <name>   <description>` — pull the first whitespace-delimited
# token from those lines until the next blank/section break.
TOP_HELP="$CAP_OUT"
COMMANDS=$(printf '%s\n' "$TOP_HELP" | awk '
  /^Commands:/ { in_cmds = 1; next }
  in_cmds && /^[[:space:]]*$/ { in_cmds = 0 }
  in_cmds && /^  [a-z]/ { print $1 }
')

if [[ -z "$COMMANDS" ]]; then
  fail "could not parse command list from bl --help"
fi

# Per-command --help. Every subcommand listed in `bl --help` should accept
# --help without a backlog. If a new command violates that contract this loop
# reports the offender by name.
for cmd in $COMMANDS; do
  result=$(capture_help "$BL" "$cmd" --help)
  split_capture "$result"
  assert_help_exit_zero "bl $cmd --help exit" "$CAP_RC"
  assert_contains "bl $cmd --help mentions Usage" "Usage:" "$CAP_OUT"
  assert_empty "bl $cmd --help stderr empty" "$CAP_ERR"
done

# `bl review --help` must keep documenting --repo (S-430): the multi-PR
# discovery still honors --repo to scope to one repo's PR.
result=$(capture_help "$BL" review --help)
split_capture "$result"
assert_contains "bl review --help documents --repo" "--repo" "$CAP_OUT"

if (( FAIL > 0 )); then
  echo "FAIL: $FAIL test(s) failed; $PASS passed" >&2
  exit 1
fi
echo "PASS: $PASS test(s) passed"
