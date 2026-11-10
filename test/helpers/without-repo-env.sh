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
#
# Also run it without BL_BACKLOG_DIR, and refuse a temporary directory inside a
# git repository (S-1394). A review session ran the suite with TMPDIR inside
# the backlog's working tree: git in a test's temp dir found the real
# backlog's .git, and the tests took its main sync lock and pushed to its
# origin. A test that does not set BL_BACKLOG_DIR itself would act on the
# backlog it inherited. Guarded by test/unit/repo-free-env.test.js.
# shellcheck disable=SC2046 # one variable name per word
unset $(git rev-parse --local-env-vars)
unset TMUX TMUX_PANE BL_TMUX_WINDOW_ID BL_TAB_TITLE BL_BACKLOG_DIR
# The tests' temporary directory: os.tmpdir(), which test/helpers/tempdir.js
# uses (TMPDIR, else /tmp). mktemp in the bash suites takes the same one.
dir=$(node -p 'os.tmpdir()')
if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
  # Inside a .git directory there is no top level; name the git dir instead.
  repo=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) ||
    repo=$(git -C "$dir" rev-parse --absolute-git-dir)
  {
    echo "Error: the temporary directory $dir is inside the git repository $repo."
    echo "A test that runs git there would act on that repository."
    echo "Unset TMPDIR, or set it to a directory outside every git repository."
  } >&2
  exit 1
fi
exec "$@"
