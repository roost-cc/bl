#!/usr/bin/env bash
# Run "$@" without git's repository variables (`git rev-parse --local-env-vars`:
# GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, ...). Git exports GIT_DIR to a
# pre-push hook in a linked worktree, and the pre-push gate runs the suite.
# With it set, every git call a test makes in its temp repo acts on that
# worktree's repo instead (S-1330). Guarded by test/unit/repo-free-env.test.js.
#
# Also run it without tmux's variables and bl's title variables (S-1388). A
# test `bl` that inherited TMUX and BL_TMUX_WINDOW_ID renamed the operator's
# real tmux window and turned its automatic-rename back on. BL_TAB_TITLE is
# unset, not emptied, so tests see the default format. Guarded by
# test/unit/tmux-free-env.test.js.
#
# Also run it in a temp directory of its own (S-1392). TMPDIR names a new
# bl-test-XXXXXX directory, so every mktemp, os.tmpdir() and bl process of the
# suite writes inside it, and the wrapper removes it when "$@" ends, also on
# SIGINT, SIGTERM or SIGHUP. A suite run then leaves /tmp as it found it.
# CLAUDE_CONFIG_DIR, where the claude provider writes its settings, is a
# directory inside it. "$@" runs as a child, not by exec, so that the EXIT
# trap can run. The child runs in the background and the wrapper waits for
# it, so a signal to the wrapper's pid alone runs its trap at once. The trap
# sends the signal on to the child and waits for it before the EXIT trap
# removes the directory. bash makes a background child ignore SIGINT and
# SIGQUIT, and `env --default-signal=INT,QUIT` gives them back; `<&0` keeps its stdin, which bash
# would set to /dev/null. Guarded by test/cli/suite-tmpdir.sh.
#
# Requires GNU env (coreutils 8.31 or later) for --default-signal. BSD and
# macOS env lack it, so there every suite fails at once; install coreutils
# and put its env first on PATH.
# shellcheck disable=SC2046 # one variable name per word
unset $(git rev-parse --local-env-vars)
unset TMUX TMUX_PANE BL_TMUX_WINDOW_ID BL_TAB_TITLE
TMPDIR=$(mktemp -d -t bl-test-XXXXXX) || exit 1
export TMPDIR
child=
pending=()
trap 'rm -rf -- "$TMPDIR"' EXIT
# stop SIG STATUS: send SIG to the child, wait for it, and exit with STATUS.
# Before `child` is set, only record the signal: the child may already run,
# and the line after `child=$!` stops it.
stop() {
  if [[ -z "$child" ]]; then
    pending=("$1" "$2")
    return
  fi
  # Until the child runs exec, it is a copy of this shell: it still has these
  # traps (or ignores SIGINT), and it can lose the signal. While its command
  # line is still the wrapper's own (Linux /proc), wait for the exec, and give
  # env time to restore SIGINT, before the signal goes out.
  if cmp -s "/proc/$$/cmdline" "/proc/$child/cmdline"; then
    while cmp -s "/proc/$$/cmdline" "/proc/$child/cmdline"; do sleep 0.01; done
    sleep 0.01
  fi
  kill -s "$1" "$child" 2>/dev/null
  wait "$child"
  exit "$2"
}
trap 'stop INT 130' INT
trap 'stop TERM 143' TERM
trap 'stop HUP 129' HUP
CLAUDE_CONFIG_DIR=$(mktemp -d) || exit 1
export CLAUDE_CONFIG_DIR
env --default-signal=INT,QUIT "$@" <&0 &
child=$!
if ((${#pending[@]})); then stop "${pending[@]}"; fi
wait "$child"
