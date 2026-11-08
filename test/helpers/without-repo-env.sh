#!/usr/bin/env bash
# Run "$@" without git's repository variables (`git rev-parse --local-env-vars`:
# GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, ...). Git exports GIT_DIR to a
# pre-push hook in a linked worktree, and the pre-push gate runs the suite.
# With it set, every git call a test makes in its temp repo acts on that
# worktree's repo instead (S-1330). Guarded by test/unit/repo-free-env.test.js.
# shellcheck disable=SC2046 # one variable name per word
unset $(git rev-parse --local-env-vars)
exec "$@"
