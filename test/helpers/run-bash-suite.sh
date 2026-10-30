#!/usr/bin/env bash
# run-bash-suite.sh — shared runner for the cli/ and e2e/ bash directories.
#
# Source this from a wrapper that sets SUITE_LABEL and SUITE_DIR:
#   source "$SCRIPT_DIR/../helpers/run-bash-suite.sh"
#   run_bash_suite "cli" "$SCRIPT_DIR"
#
# Loops over $SUITE_DIR/*.sh in alphabetical order (skipping itself), runs
# each, and prints a summary. Exits non-zero if any sub-script fails.
set -uo pipefail

run_bash_suite() {
  local label="$1" dir="$2"
  local pass_files=0 fail_files=0 base
  local failed=()

  for f in "$dir"/*.sh; do
    base=$(basename "$f")
    [[ "$base" == "run-all.sh" ]] && continue
    echo "──── $base"
    if bash "$f"; then
      pass_files=$((pass_files + 1))
    else
      fail_files=$((fail_files + 1))
      failed+=("$base")
    fi
    echo
  done

  if (( fail_files > 0 )); then
    echo "$label summary: $fail_files failed, $pass_files passed" >&2
    echo "  failed: ${failed[*]}" >&2
    return 1
  fi
  echo "$label summary: $pass_files passed"
}
