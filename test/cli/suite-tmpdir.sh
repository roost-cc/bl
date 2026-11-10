#!/usr/bin/env bash
# The contract of test/helpers/without-repo-env.sh (S-1392): every suite runs
# in a bl-test-XXXXXX TMPDIR of its own, with CLAUDE_CONFIG_DIR inside it, and
# the wrapper removes that directory when the suite ends, also on a signal.
set -euo pipefail
source "$(dirname "$0")/../helpers/tempdir.sh"
WRAPPER="$(dirname "$0")/../helpers/without-repo-env.sh"

CLEANUP_PATHS=()
trap 'rm -rf "${CLEANUP_PATHS[@]}"' EXIT
DIR=$(mktemp -d) && CLEANUP_PATHS+=("$DIR")

# Normal exit: the child sees both directories, and the exit status passes
# through.
CASE="$DIR/normal"
mkdir -p "$CASE"
set +e
out=$(env TMPDIR="$CASE" bash "$WRAPPER" bash -c 'echo "$TMPDIR"; echo "$CLAUDE_CONFIG_DIR"; mktemp >/dev/null; exit 3')
rc=$?
set -e
suite_tmp=$(sed -n 1p <<<"$out")
claude_dir=$(sed -n 2p <<<"$out")
assert_exit "normal exit: exit status of the child" "3" "$rc"
if [[ "$(dirname "$suite_tmp")" == "$CASE" && "$(basename "$suite_tmp")" == bl-test-* ]]; then pass; else fail "normal exit: TMPDIR is not a bl-test- directory in $CASE: '$suite_tmp'"; fi
if [[ "$(dirname "$claude_dir")" == "$suite_tmp" ]]; then pass; else fail "normal exit: CLAUDE_CONFIG_DIR is not in TMPDIR: '$claude_dir'"; fi
assert_eq "normal exit: temp directory removed" "" "$(ls -A "$CASE")"

# A signal to the wrapper's process group, as run-parallel.sh sends it. `set -m`
# starts the wrapper in a process group of its own; the background wrapper would
# ignore SIGINT, and `env --default-signal` gives it back.
for sig in TERM INT HUP; do
  CASE="$DIR/sig-$sig"
  mkdir -p "$CASE"
  set -m
  env --default-signal=INT TMPDIR="$CASE" bash "$WRAPPER" bash -c 'echo "$TMPDIR" >"$1"; sleep 30' _ "$CASE.started" 2>/dev/null &
  pid=$!
  set +m
  wait_for "$CASE.started"
  kill -s "$sig" -- "-$pid"
  set +e
  wait "$pid" 2>/dev/null
  rc=$?
  set -e
  assert_exit "SIG$sig: the wrapper ends by the signal" "$((128 + $(kill -l "$sig")))" "$rc"
  assert_eq "SIG$sig: temp directory removed" "" "$(ls -A "$CASE")"
done

summary_and_exit
