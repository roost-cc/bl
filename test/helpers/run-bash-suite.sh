#!/usr/bin/env bash
# run-bash-suite.sh — shared runner for the cli/ and e2e/ bash directories.
#
# Source this from a wrapper and call run_bash_suite <label> <dir>:
#   source "$SCRIPT_DIR/../helpers/run-bash-suite.sh"
#   run_bash_suite "cli" "$SCRIPT_DIR"
#
# Runs every <dir>/*.sh except run-all.sh at the same time through
# run_parallel (run-parallel.sh), which prints each script's output whole in
# alphabetical order and a summary. Exits non-zero if any script fails.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/run-parallel.sh"

run_bash_suite() {
  local label="$1" dir="$2"
  local scripts=() f
  for f in "$dir"/*.sh; do
    [[ "$(basename -- "$f")" == "run-all.sh" ]] && continue
    scripts+=("$f")
  done
  run_parallel "$label" bash "${scripts[@]}"
}
