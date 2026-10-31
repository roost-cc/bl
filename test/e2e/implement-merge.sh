#!/usr/bin/env bash
# E2E lifecycle including git worktrees.
#
#   bl new → mark refined → bl implement → edit + commit in worktree →
#   bl merge --keep → assert worktree gone, branch state, story marked done.
#
# `bl implement` launches an agent session via `provider.spawn()`. We
# put a stub agent script first on $PATH that just exits 0, so implement
# returns without an interactive session.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"

if [[ ! -x "$BL" ]]; then
  echo "FAIL: $BL not found or not executable" >&2
  exit 1
fi

PASS=0
FAIL=0
fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }

# ---------------------------------------------------------------------------
# Layout:
#   $ROOT/origin.git  — bare upstream
#   $ROOT/code        — working copy of code repo (the "primary repo")
#   $ROOT/backlog     — backlog tempdir
#   $ROOT/worktrees   — the worktree root: bl stages <root>/<branch>/<repo>
#   $ROOT/stub-bin    — fake agent so implement returns immediately
# ---------------------------------------------------------------------------

ROOT=$(mktemp -d -t bl-e2e-XXXXXX)
trap 'rm -rf "$ROOT"' EXIT

# Hide the developer's global/system git config so the test is hermetic. Without
# this, a user-configured `commit.gpgsign=true` (or a missing user.name/email)
# can make `bl merge`'s merge commit fail or hang in unrelated environments.
# `bl` itself shells out to git, so the export must propagate to children.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

git init -q --bare "$ROOT/origin.git"
git -c init.defaultBranch=main init -q "$ROOT/code"
# Pin identity + disable signing in the local repo config so every git
# invocation (including the merge `bl merge` runs) inherits a working setup.
git -C "$ROOT/code" config user.email t@t
git -C "$ROOT/code" config user.name t
git -C "$ROOT/code" config commit.gpgsign false
git -C "$ROOT/code" config tag.gpgsign false
git -C "$ROOT/code" commit --allow-empty -q -m init
# Rename initial branch to main if Git defaulted to master.
git -C "$ROOT/code" branch -m main 2>/dev/null || true
git -C "$ROOT/code" remote add origin "$ROOT/origin.git"
git -C "$ROOT/code" push -q -u origin main

mkdir -p "$ROOT/backlog"

# bl implement resolves allowed-tools.json from the backlog root before launching
# the agent. Copy the repo template in so the test exercises the
# real path without relying on the interactive `bl init`.
cp "$REPO_ROOT/templates/allowed-tools.json" "$ROOT/backlog/allowed-tools.json"
cp "$REPO_ROOT/templates/flow.json" "$ROOT/backlog/flow.json"

cat > "$ROOT/backlog/backlog.json" <<JSON
{
  "backlog": "backlog",
  "worktrees": "../worktrees",
  "agent": [{ "agent": "claude" }],
  "review_agent": [{ "agent": "claude" }],
  "repos": {
    "code": { "path": "../code", "deployable": false, "update_tests": [] }
  }
}
JSON


mkdir -p "$ROOT/backlog/components/C00-core"
cat > "$ROOT/backlog/components/C00-core/index.md" <<'MD'
---
component_id: C00
title: Core
repo: code
home: true
---

# C00 · Core
MD

# Stub agent — implement will spawn this and it exits 0.
mkdir -p "$ROOT/stub-bin"
cat > "$ROOT/stub-bin/claude" <<'SH'
#!/bin/sh
# stub: do nothing, exit 0
exit 0
SH
chmod +x "$ROOT/stub-bin/claude"
export PATH="$ROOT/stub-bin:$PATH"

export BL_BACKLOG_DIR="$ROOT/backlog"

# ---------------------------------------------------------------------------
# bl new
# ---------------------------------------------------------------------------

INDEX_REL=$("$BL" new C00 --title "E2E Story" --points 1 2>/dev/null)
INDEX_ABS="$ROOT/backlog/$INDEX_REL"
if [[ -f "$INDEX_ABS" ]]; then pass; else fail "bl new did not create $INDEX_ABS"; fi

# Mark the story as refined so implement will proceed.
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const t = fs.readFileSync(p, "utf8").replace(/^status:.*$/m, "status: refined");
  fs.writeFileSync(p, t);
' "$INDEX_ABS"

# ---------------------------------------------------------------------------
# bl implement — should create a worktree and a branch, then exit (agent stub)
# ---------------------------------------------------------------------------

set +e
"$BL" implement S-1 >/dev/null 2>&1
rc=$?
set -e
if (( rc == 0 )); then pass; else fail "bl implement exit $rc"; fi

WT_PATH="$ROOT/worktrees/s1-e2e-story/code"
if [[ -d "$WT_PATH" ]]; then pass; else fail "expected worktree at $WT_PATH"; fi

if git -C "$ROOT/code" rev-parse --verify s1-e2e-story >/dev/null 2>&1; then
  pass
else
  fail "branch s1-e2e-story should exist after implement"
fi

# Make a commit inside the worktree. The worktree shares the parent repo's
# config (set above), so we don't need to repeat -c user.email / commit.gpgsign.
echo "hello" > "$WT_PATH/note.txt"
git -C "$WT_PATH" add note.txt
git -C "$WT_PATH" commit -q -m "S-1: note"

# ---------------------------------------------------------------------------
# bl merge --keep --no-review — merges branch into main, removes the worktree
# (the story has no Review Log: the review gate is waived).
# Stay out of the worktree (it'll be removed) and run from the main repo.
# ---------------------------------------------------------------------------

cd "$ROOT/code"
set +e
"$BL" merge S-1 --keep --no-review >/dev/null 2>&1
rc=$?
set -e
cd "$ROOT"
if (( rc == 0 )); then pass; else fail "bl merge exit $rc"; fi

if [[ ! -d "$WT_PATH" ]]; then pass; else fail "expected worktree to be gone after merge"; fi
if [[ ! -d "$(dirname "$WT_PATH")" ]]; then pass; else fail "expected the emptied unit directory to be gone after merge"; fi

# main should now contain the merge. Match the full subject so this doesn't
# fire on stray commits whose body happens to include the substring "note".
if git -C "$ROOT/code" log --oneline main | grep -q 'S-1: note'; then
  pass
else
  fail "main should contain the merged 'S-1: note' commit"
fi

# Story should be marked done where it is (F-49 D3).
if grep -q '^status: done' "$INDEX_ABS"; then
  pass
else
  fail "expected $INDEX_REL to be status: done after merge"
fi

if (( FAIL > 0 )); then
  echo "FAIL: $FAIL test(s) failed; $PASS passed" >&2
  exit 1
fi
echo "PASS: $PASS test(s) passed"
