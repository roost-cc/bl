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

# A signal to the wrapper's pid alone, as `kill <pid>` sends it. The wrapper
# sends it on to the child and ends within seconds, not when the child would
# have ended. The child execs sleep, so the signal reaches sleep itself.
for sig in TERM INT HUP; do
  CASE="$DIR/pid-$sig"
  mkdir -p "$CASE"
  set -m
  env --default-signal=INT TMPDIR="$CASE" bash "$WRAPPER" bash -c 'echo "$TMPDIR" >"$1"; exec sleep 30' _ "$CASE.started" 2>/dev/null &
  pid=$!
  set +m
  wait_for "$CASE.started"
  kill -s "$sig" "$pid"
  start=$SECONDS
  while kill -0 "$pid" 2>/dev/null && ((SECONDS - start < 5)); do sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then
    fail "SIG$sig to the pid: the wrapper still runs 5 s after the signal"
    kill -s KILL -- "-$pid" 2>/dev/null || true
  else
    pass
  fi
  set +e
  wait "$pid" 2>/dev/null
  rc=$?
  set -e
  assert_exit "SIG$sig to the pid: the wrapper ends by the signal" "$((128 + $(kill -l "$sig")))" "$rc"
  assert_eq "SIG$sig to the pid: temp directory removed" "" "$(ls -A "$CASE")"
done

# A signal to the wrapper's pid while it starts the child: before it records
# the child's pid, or before the child has run exec. The case waits until
# CLAUDE_CONFIG_DIR exists (the wrapper's last step before the child), then
# sends SIGTERM after a delay that grows each round. The wrapper must stop
# the child at once: it ends within 5 s, and no child of a case survives.
marker="suite-tmpdir-early-$$"
orphans=0
slow=0
for i in $(seq 100); do
  CASE="$DIR/early-$i"
  mkdir -p "$CASE"
  # exec -a names the sleep "$marker-$i", so its command line is "$marker-$i 30".
  env TMPDIR="$CASE" bash "$WRAPPER" bash -c 'exec -a "$1" sleep 30' _ "$marker-$i" 2>/dev/null &
  pid=$!
  until compgen -G "$CASE/bl-test-*/*" >/dev/null || ! kill -0 "$pid" 2>/dev/null; do :; done
  for ((j = 0; j < (i % 20) * 20; j++)); do :; done
  kill -s TERM "$pid" 2>/dev/null || true
  start=$SECONDS
  while kill -0 "$pid" 2>/dev/null && ((SECONDS - start < 5)); do sleep 0.01; done
  if kill -0 "$pid" 2>/dev/null; then
    slow=$((slow + 1))
    pkill -f "$marker-$i 30" || true
  fi
  wait "$pid" 2>/dev/null || true
  if pgrep -f "$marker-$i 30" >/dev/null; then
    orphans=$((orphans + 1))
    pkill -f "$marker-$i 30" || true
  fi
done
assert_eq "early SIGTERM: the wrapper ends within 5 s" "0" "$slow"
assert_eq "early SIGTERM: no child survives the wrapper" "0" "$orphans"

summary_and_exit
