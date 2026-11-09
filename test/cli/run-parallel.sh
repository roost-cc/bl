#!/usr/bin/env bash
# The contract of test/helpers/run-parallel.sh (F-99 D1): every item runs,
# each output is printed whole under its own line in the given order, and a
# failed item makes the summary name it and the exit non-zero.
set -euo pipefail
source "$(dirname "$0")/../helpers/tempdir.sh"
RUN_PARALLEL="$(dirname "$0")/../helpers/run-parallel.sh"

CLEANUP_PATHS=()
trap 'rm -rf "${CLEANUP_PATHS[@]}"' EXIT
DIR=$(mktemp -d) && CLEANUP_PATHS+=("$DIR")

# `slow` ends last but is printed first; its stderr line stays with its stdout.
printf 'sleep 0.3; echo slow-out; echo slow-err >&2\n' >"$DIR/slow"
printf 'echo fast-out\n' >"$DIR/fast"
printf 'echo broken-out; exit 3\n' >"$DIR/broken"

set +e
out=$(bash "$RUN_PARALLEL" demo bash "$DIR/slow" "$DIR/fast" 2>&1)
rc=$?
set -e
assert_exit "all pass: exit" "0" "$rc"
expected=$(printf '──── slow\nslow-out\nslow-err\n\n──── fast\nfast-out\n\ndemo summary: 2 passed')
assert_eq "all pass: each output whole, in the given order" "$expected" "$out"

set +e
out=$(bash "$RUN_PARALLEL" demo bash "$DIR/broken" "$DIR/fast" 2>/dev/null)
err=$(bash "$RUN_PARALLEL" demo bash "$DIR/broken" "$DIR/fast" 2>&1 >/dev/null)
rc=$?
set -e
assert_exit "one fails: exit" "1" "$rc"
assert_contains "one fails: its output is printed" $'──── broken\nbroken-out' "$out"
assert_contains "one fails: the other still runs" $'──── fast\nfast-out' "$out"
assert_eq "one fails: the summary names it" $'demo summary: 1 failed, 1 passed\n  failed: broken' "$err"

# Without a temp directory no item starts, and the runner fails.
set +e
out=$(env TMPDIR="$DIR/missing" bash "$RUN_PARALLEL" demo bash "$DIR/fast" 2>/dev/null)
rc=$?
set -e
assert_exit "no temp directory: exit" "1" "$rc"
assert_eq "no temp directory: nothing runs" "" "$out"

# The runner removes its temp directory for any TMPDIR, even one with a quote.
QUOTED="$DIR/it's"
mkdir -p "$QUOTED"
set +e
err=$(env TMPDIR="$QUOTED" bash "$RUN_PARALLEL" demo bash "$DIR/fast" 2>&1 >/dev/null)
rc=$?
set -e
assert_exit "TMPDIR with a quote: exit" "0" "$rc"
assert_eq "TMPDIR with a quote: no error" "" "$err"
assert_eq "TMPDIR with a quote: temp directory removed" "" "$(ls -A "$QUOTED")"

# Two calls in one shell remove both temp directories and keep the caller's
# EXIT trap.
TWICE="$DIR/twice"
mkdir -p "$TWICE"
out=$(env TMPDIR="$TWICE" RUN_PARALLEL="$RUN_PARALLEL" ITEM="$DIR/fast" bash -c '
  source "$RUN_PARALLEL"
  trap "echo caller-trap-ran" EXIT
  run_parallel a bash "$ITEM" >/dev/null
  run_parallel b bash "$ITEM" >/dev/null
')
assert_eq "two calls: the caller's EXIT trap runs" "caller-trap-ran" "$out"
assert_eq "two calls: both temp directories removed" "" "$(ls -A "$TWICE")"

summary_and_exit
