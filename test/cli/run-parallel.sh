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
# `fast` writes fast.done after its output, so a stop test can wait until it
# has ended; the file is not part of its output.
printf 'echo fast-out; echo done >"%s/fast.done"\n' "$DIR" >"$DIR/fast"
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
  rm -f "$DIR"/*.pid "$DIR"/*.child "$DIR/fast.done"
  items=("$DIR/fast" "$DIR/slow")
  watched=("$DIR/slow.pid" "$DIR/slow.child")
  [[ "$sig" == TERM ]] && items+=("$DIR/stubborn") && watched+=("$DIR/stubborn.pid")
  env --default-signal=INT TMPDIR="$STOP" bash "$RUN_PARALLEL" demo bash "${items[@]}" >"$STOP.out" 2>&1 &
  runner=$!
  # `fast` must have ended before the signal: under load it can start late.
  wait_for "${watched[@]}" "$DIR/fast.done"
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

# A signal while the runner starts its items still ends every item that has
# started (S-1414). Each `eager` item sends SIGTERM to the runner as it starts
# and ignores SIGTERM itself, so the signal comes while later items start, and
# only the stop's SIGKILL ends an item. Before S-1414 a signal right after an
# `&` left that item running in most runs. pgrep also finds an item that has
# not yet run exec: until then its command line is the runner's.
eager=()
for n in $(seq 20); do
  printf 'trap "" TERM; kill -TERM $PPID; while :; do sleep 0.1; done\n' >"$DIR/eager-$n"
  eager+=("$DIR/eager-$n")
done
for run in 1 2 3; do
  STOP="$DIR/start-$run"
  mkdir -p "$STOP"
  env RUN_PARALLEL_GRACE=5 TMPDIR="$STOP" bash "$RUN_PARALLEL" demo bash "${eager[@]}" >"$STOP.out" 2>&1 &
  runner=$!
  set +e
  wait "$runner" 2>/dev/null
  rc=$?
  set -e
  out=$(cat "$STOP.out")
  assert_exit "start $run: the runner ends by the signal" "143" "$rc"
  assert_contains "start $run: the runner says it was stopped" "demo: stopped by SIGTERM" "$out"
  if pgrep -f -- "$DIR/eager-" >/dev/null; then
    fail "start $run: an item still runs"
    pkill -KILL -f -- "$DIR/eager-"
  else
    pass
  fi
  assert_eq "start $run: temp directory removed" "" "$(ls -A "$STOP")"
done

# A signal just before `wait` starts still stops the run at once (S-1414). The
# runner's first `kill -0` of its poll sends SIGTERM to the runner, so the
# signal comes after the poll's flag check. A `wait` there would block for the
# whole `sleep 30` of the item. The case needs the poll to use `kill -0`: it
# proves that the poll ends soon after a signal that comes after the flag
# check (about 0.1 s; the time bound below allows 5 s for a loaded host).
# The item names its `sleep` "$DIR/long-sleep", so pgrep finds the child too.
printf '(exec -a "$0-sleep" sleep 30)\n' >"$DIR/long"
STOP="$DIR/before-wait"
mkdir -p "$STOP"
started=$EPOCHREALTIME
env TMPDIR="$STOP" RUN_PARALLEL="$RUN_PARALLEL" bash -c '
  source "$RUN_PARALLEL"
  fired=
  kill() {
    if [[ "$1" == -0 && -z "$fired" ]]; then
      fired=1
      builtin kill -TERM $$
    fi
    builtin kill "$@"
  }
  run_parallel demo bash "$1"
' _ "$DIR/long" >"$STOP.out" 2>&1 &
runner=$!
set +e
wait "$runner" 2>/dev/null
rc=$?
set -e
# A locale with a decimal comma writes EPOCHREALTIME with a comma.
took=$(((${EPOCHREALTIME//[.,]/} - ${started//[.,]/}) / 1000))
out=$(cat "$STOP.out")
assert_exit "signal before wait: the runner ends by the signal" "143" "$rc"
assert_contains "signal before wait: the runner says it was stopped" "demo: stopped by SIGTERM" "$out"
# About 0.1 s on an idle host; the bound leaves room for a loaded one.
if ((took < 5000)); then pass; else fail "signal before wait: the runner took ${took} ms"; fi
if pgrep -f -- "$DIR/long" >/dev/null; then
  fail "signal before wait: an item still runs"
  pkill -KILL -f -- "$DIR/long"
else
  pass
fi
assert_eq "signal before wait: temp directory removed" "" "$(ls -A "$STOP")"

# A signal after the last wait still ends the runner by that signal (S-1414).
# The print of the last item sends SIGTERM to the runner, so the signal comes
# after the last wait and before the runner removes its traps.
STOP="$DIR/after-wait"
mkdir -p "$STOP"
env TMPDIR="$STOP" RUN_PARALLEL="$RUN_PARALLEL" bash -c '
  source "$RUN_PARALLEL"
  _run_parallel_print() { kill -TERM $$; }
  run_parallel demo bash "$1"
' _ "$DIR/fast" >"$STOP.out" 2>&1 &
runner=$!
set +e
wait "$runner" 2>/dev/null
rc=$?
set -e
out=$(cat "$STOP.out")
assert_exit "signal after the last wait: the runner ends by the signal" "143" "$rc"
assert_contains "signal after the last wait: the runner says it was stopped" "demo: stopped by SIGTERM" "$out"
if [[ "$out" == *summary* ]]; then fail "signal after the last wait: the runner prints its summary"; else pass; fi
assert_eq "signal after the last wait: temp directory removed" "" "$(ls -A "$STOP")"

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
  # The signal to the inner runner's group also ends the `sleep` of its poll.
  if [[ "$out" == *Terminated* ]]; then fail "nested $run: a job line is printed"; else pass; fi
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
rm -f "$DIR"/*.pid "$DIR"/*.child "$DIR/fast.done"
env TMPDIR="$STOP" RUN_PARALLEL="$RUN_PARALLEL" bash -c '
  set -e
  source "$RUN_PARALLEL"
  run_parallel demo bash "$1" "$2"
  echo after-the-runner
' _ "$DIR/fast" "$DIR/slow" >"$STOP.out" 2>&1 &
runner=$!
wait_for "$DIR/slow.pid" "$DIR/slow.child" "$DIR/fast.done"
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
