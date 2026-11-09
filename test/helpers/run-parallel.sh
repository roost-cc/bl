#!/usr/bin/env bash
# run-parallel.sh — the one runner for a list of test commands (F-99 D1).
#
#   run_parallel <label> <runner> <item>...
#
# Starts `<runner> <item>` for every item at the same time. <runner> is a
# command prefix that the shell splits into words (`bash`, `npm run`). Each
# item writes stdout and stderr together to its own file. The runner waits for
# the items in the given order and prints each output whole, under
# `──── <basename of item>`, so the output of two items never mixes (the gate's
# failure excerpt reads it). Then it prints a summary and returns non-zero if
# any item failed.
#
# If the runner gets SIGINT, SIGTERM or SIGHUP, it stops every item that has
# not ended, with all of the item's child processes, and prints the output of
# those items so far. Then it ends by the same signal. A second signal during
# the stop does nothing, and the caller's `set -e` does not end the stop.
#
# RUN_PARALLEL_GRACE is the time in tenths of a second (default 30) that the
# stop waits after SIGTERM before it sends SIGKILL. Each item gets half of the
# runner's value, so a nested runner ends its own items before its parent
# runner sends SIGKILL to it.
#
# Source this file for the function, or execute it to run `run_parallel "$@"`:
#   bash test/helpers/run-parallel.sh test 'npm run' test:unit test:cli
set -uo pipefail

run_parallel() {
  local label="$1" runner="$2"
  shift 2
  local items=("$@") pids=() failed=() pass=0 next=0 dir i traps
  local grace="${RUN_PARALLEL_GRACE:-30}"
  # Without its directory no item can write its output: start none.
  dir=$(mktemp -d) || return 1
  # The function removes $dir itself and sets no EXIT trap: the EXIT trap
  # belongs to the caller, and a sourced runner can run more than once.

  # The caller's signal traps come back when the function ends.
  traps=$(trap -p INT TERM HUP)
  trap '_run_parallel_stop INT' INT
  trap '_run_parallel_stop TERM' TERM
  trap '_run_parallel_stop HUP' HUP

  # Job control puts each item in its own process group, so a stop reaches
  # the item's child processes too (`npm run` starts `node`). Without job
  # control a background item also ignores SIGINT.
  local -
  set -m
  for i in "${!items[@]}"; do
    # shellcheck disable=SC2086 # the runner is split into words on purpose
    RUN_PARALLEL_GRACE=$((grace / 2)) $runner "${items[$i]}" </dev/null >"$dir/$i" 2>&1 &
    pids+=("$!")
  done
  set +m

  for i in "${!items[@]}"; do
    if wait "${pids[$i]}"; then
      pass=$((pass + 1))
    else
      failed+=("$(basename -- "${items[$i]}")")
    fi
    # Item $i has ended: a stop from now on does not print it again.
    next=$((i + 1))
    _run_parallel_print "$i"
  done
  rm -rf -- "$dir"
  trap - INT TERM HUP
  eval "$traps"

  if ((${#failed[@]} > 0)); then
    echo "$label summary: ${#failed[@]} failed, $pass passed" >&2
    echo "  failed: ${failed[*]}" >&2
    return 1
  fi
  echo "$label summary: $pass passed"
}

# Prints the output of item $1 under its line. It reads `items` and `dir` of
# the run_parallel call that runs it.
_run_parallel_print() {
  echo "──── $(basename -- "${items[$1]}")"
  cat "$dir/$1"
  echo
}

# The signal trap of run_parallel: stops the items from `next` on, prints
# their output so far, removes the temp directory, puts back the caller's
# traps and ends by signal $1.
_run_parallel_stop() {
  # A second signal must not end the stop before its cleanup, and a `kill` or
  # `wait` on an item that has already ended must not end it under `set -e`.
  trap '' INT TERM HUP
  set +e
  local sig="$1" i left="$grace"
  for ((i = next; i < ${#pids[@]}; i++)); do
    kill -TERM -- "-${pids[$i]}" 2>/dev/null
  done
  # A process can end some seconds after SIGTERM: a `node --test` file
  # process ends at its next await. A nested runner needs the time to stop
  # its own items, and it has half of this grace time for that. After the
  # grace time, SIGKILL ends what is left of each group.
  for ((i = next; i < ${#pids[@]}; i++)); do
    while kill -0 -- "-${pids[$i]}" 2>/dev/null && ((left > 0)); do
      sleep 0.1
      left=$((left - 1))
    done
    kill -KILL -- "-${pids[$i]}" 2>/dev/null
    wait "${pids[$i]}" 2>/dev/null
    _run_parallel_print "$i"
  done
  rm -rf -- "$dir"
  echo "$label: stopped by SIG$sig" >&2
  trap - INT TERM HUP
  eval "$traps"
  kill -s "$sig" "$BASHPID"
  # The caller's trap for $sig did not end the shell.
  exit $((128 + $(kill -l "$sig")))
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  run_parallel "$@"
fi
