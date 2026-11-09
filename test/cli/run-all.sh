#!/usr/bin/env bash
# Run every test/cli/*.sh at the same time, print each output in alphabetical
# order, and report a summary.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../helpers/run-bash-suite.sh"
run_bash_suite "cli" "$SCRIPT_DIR"
