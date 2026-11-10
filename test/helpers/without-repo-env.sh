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
# trap can run. Guarded by test/cli/suite-tmpdir.sh.
# shellcheck disable=SC2046 # one variable name per word
unset $(git rev-parse --local-env-vars)
unset TMUX TMUX_PANE BL_TMUX_WINDOW_ID BL_TAB_TITLE
TMPDIR=$(mktemp -d -t bl-test-XXXXXX) || exit 1
export TMPDIR
trap 'rm -rf -- "$TMPDIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
CLAUDE_CONFIG_DIR=$(mktemp -d) || exit 1
export CLAUDE_CONFIG_DIR
"$@"
