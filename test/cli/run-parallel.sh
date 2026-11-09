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

# An item that starts with `-` is a name, not an option of basename.
out=$(bash "$RUN_PARALLEL" demo echo -n 2>&1)
assert_eq "an item that starts with -: its line names it" $'──── -n\n\ndemo summary: 1 passed' "$out"

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

# A signal to the runner stops every item that has not ended, with its child
# processes, and prints the output of those items so far. `stubborn` ignores
# SIGTERM, so only the SIGKILL after the grace time ends it. The background
# runner would ignore SIGINT; `env --default-signal` gives it back.
printf 'echo slow-start; sleep 30 & echo $! >"%s/slow.child"; echo $$ >"%s/slow.pid"; wait; echo slow-end\n' "$DIR" "$DIR" >"$DIR/slow"
printf 'trap "" TERM; echo stubborn-start; echo $$ >"%s/stubborn.pid"; while :; do sleep 0.1; done\n' "$DIR" >"$DIR/stubborn"

# Waits up to 5 s until every file $@ is written.
wait_for() {
  local f
  for f in "$@"; do
    for _ in $(seq 50); do
      [[ -s "$f" ]] && break
      sleep 0.1
    done
  done
}

# Passes if the process whose pid file $2 names has ended; ends it if not.
assert_ended() {
  if [[ ! -s "$2" ]]; then
    fail "$1: $(basename "$2") was not written"
  elif kill -0 "$(cat "$2")" 2>/dev/null; then
    fail "$1: $(basename "$2") process still runs"
    kill -KILL "$(cat "$2")"
  else
    pass
  fi
}

for sig in TERM INT HUP; do
  STOP="$DIR/stop-$sig"
  mkdir -p "$STOP"
  rm -f "$DIR"/*.pid "$DIR"/*.child
  items=("$DIR/fast" "$DIR/slow")
  watched=("$DIR/slow.pid" "$DIR/slow.child")
  [[ "$sig" == TERM ]] && items+=("$DIR/stubborn") && watched+=("$DIR/stubborn.pid")
  env --default-signal=INT TMPDIR="$STOP" bash "$RUN_PARALLEL" demo bash "${items[@]}" >"$STOP.out" 2>&1 &
  runner=$!
  wait_for "${watched[@]}"
  kill -s "$sig" "$runner"
  set +e
  wait "$runner" 2>/dev/null
  rc=$?
  set -e
  out=$(cat "$STOP.out")
  assert_exit "SIG$sig: the runner ends by the signal" "$((128 + $(kill -l "$sig")))" "$rc"
  assert_contains "SIG$sig: an ended item's output is printed" $'──── fast\nfast-out' "$out"
  assert_contains "SIG$sig: a stopped item's output so far is printed" $'──── slow\nslow-start' "$out"
  assert_contains "SIG$sig: the runner says it was stopped" "demo: stopped by SIG$sig" "$out"
  for f in "${watched[@]}"; do
    assert_ended "SIG$sig" "$f"
  done
  assert_eq "SIG$sig: temp directory removed" "" "$(ls -A "$STOP")"
done

# A signal to a nested runner ends an item of the inner runner that ignores
# SIGTERM: the inner runner has half the grace time, so it sends SIGKILL to
# its item before the outer runner sends SIGKILL to it. Three runs, because a
# leak depends on timing.
printf 'bash "%s" inner bash "%s"\n' "$RUN_PARALLEL" "$DIR/stubborn" >"$DIR/inner"
for run in 1 2 3; do
  STOP="$DIR/nested-$run"
  mkdir -p "$STOP"
  rm -f "$DIR/stubborn.pid"
  env RUN_PARALLEL_GRACE=20 TMPDIR="$STOP" bash "$RUN_PARALLEL" outer bash "$DIR/inner" >"$STOP.out" 2>&1 &
  runner=$!
  wait_for "$DIR/stubborn.pid"
  kill -TERM "$runner"
  set +e
  wait "$runner" 2>/dev/null
  rc=$?
  set -e
  out=$(cat "$STOP.out")
  assert_exit "nested $run: the runner ends by the signal" "143" "$rc"
  assert_contains "nested $run: the inner item's output so far is printed" "stubborn-start" "$out"
  assert_contains "nested $run: the inner runner says it was stopped" "inner: stopped by SIGTERM" "$out"
  assert_ended "nested $run" "$DIR/stubborn.pid"
  assert_eq "nested $run: both temp directories removed" "" "$(ls -A "$STOP")"
done

# A second signal during the stop does nothing: the stop still sends SIGKILL
# to the item that ignores SIGTERM and removes the temp directory.
STOP="$DIR/second"
mkdir -p "$STOP"
rm -f "$DIR/stubborn.pid"
env RUN_PARALLEL_GRACE=20 TMPDIR="$STOP" bash "$RUN_PARALLEL" demo bash "$DIR/stubborn" >"$STOP.out" 2>&1 &
runner=$!
wait_for "$DIR/stubborn.pid"
set +e
kill -TERM "$runner"
sleep 0.5
kill -TERM "$runner"
kill -HUP "$runner"
wait "$runner" 2>/dev/null
rc=$?
set -e
out=$(cat "$STOP.out")
assert_exit "second signal: the runner ends by the first signal" "143" "$rc"
assert_contains "second signal: the item's output so far is printed" $'──── stubborn\nstubborn-start' "$out"
assert_contains "second signal: the runner says it was stopped" "demo: stopped by SIGTERM" "$out"
assert_ended "second signal" "$DIR/stubborn.pid"
assert_eq "second signal: temp directory removed" "" "$(ls -A "$STOP")"

# A caller with `set -e` still gets the whole stop, although a `kill` on an
# item that has already ended fails.
STOP="$DIR/errexit"
mkdir -p "$STOP"
rm -f "$DIR"/*.pid "$DIR"/*.child
env TMPDIR="$STOP" RUN_PARALLEL="$RUN_PARALLEL" bash -c '
  set -e
  source "$RUN_PARALLEL"
  run_parallel demo bash "$1" "$2"
  echo after-the-runner
' _ "$DIR/fast" "$DIR/slow" >"$STOP.out" 2>&1 &
runner=$!
wait_for "$DIR/slow.pid" "$DIR/slow.child"
kill -TERM "$runner"
set +e
wait "$runner" 2>/dev/null
rc=$?
set -e
out=$(cat "$STOP.out")
assert_exit "set -e caller: the runner ends by the signal" "143" "$rc"
assert_contains "set -e caller: an ended item's output is printed" $'──── fast\nfast-out' "$out"
assert_contains "set -e caller: a stopped item's output so far is printed" $'──── slow\nslow-start' "$out"
assert_contains "set -e caller: the runner says it was stopped" "demo: stopped by SIGTERM" "$out"
if [[ "$out" == *after-the-runner* ]]; then fail "set -e caller: the caller goes on"; else pass; fi
assert_ended "set -e caller" "$DIR/slow.pid"
assert_ended "set -e caller" "$DIR/slow.child"
assert_eq "set -e caller: temp directory removed" "" "$(ls -A "$STOP")"

summary_and_exit
