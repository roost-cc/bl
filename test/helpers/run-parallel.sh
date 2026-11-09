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
# Source this file for the function, or execute it to run `run_parallel "$@"`:
#   bash test/helpers/run-parallel.sh test 'npm run' test:unit test:cli
set -uo pipefail

run_parallel() {
  local label="$1" runner="$2"
  shift 2
  local items=("$@") pids=() failed=() pass=0 dir i
  dir=$(mktemp -d)
  # Expanded now: $dir is local and is gone when the EXIT trap runs.
  # shellcheck disable=SC2064
  trap "rm -rf '$dir'" EXIT

  for i in "${!items[@]}"; do
    # shellcheck disable=SC2086 # the runner is split into words on purpose
    $runner "${items[$i]}" >"$dir/$i" 2>&1 &
    pids+=("$!")
  done

  for i in "${!items[@]}"; do
    if wait "${pids[$i]}"; then
      pass=$((pass + 1))
    else
      failed+=("$(basename "${items[$i]}")")
    fi
    echo "──── $(basename "${items[$i]}")"
    cat "$dir/$i"
    echo
  done

  if ((${#failed[@]} > 0)); then
    echo "$label summary: ${#failed[@]} failed, $pass passed" >&2
    echo "  failed: ${failed[*]}" >&2
    return 1
  fi
  echo "$label summary: $pass passed"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  run_parallel "$@"
fi
