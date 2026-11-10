#!/usr/bin/env bash
# Run "$@" without git's repository variables (`git rev-parse --local-env-vars`:
# GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, ...). Git exports GIT_DIR to a
# pre-push hook in a linked worktree, and the pre-push gate runs the suite.
# With it set, every git call a test makes in its temp repo acts on that
# worktree's repo instead (S-1330). Guarded by test/unit/repo-free-env.test.js.
#
# Also run it without tmux's variables and bl's title variables (S-1388). A
# test `bl` that inherited TMUX and BL_TMUX_WINDOW_ID renamed the operator's
# real tmux window and left its title there. BL_TAB_TITLE is
# unset, not emptied, so tests see the default format. Guarded by
# test/unit/tmux-free-env.test.js.
# shellcheck disable=SC2046 # one variable name per word
unset $(git rev-parse --local-env-vars)
unset TMUX TMUX_PANE BL_TMUX_WINDOW_ID BL_TAB_TITLE
exec "$@"
