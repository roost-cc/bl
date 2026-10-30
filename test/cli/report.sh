#!/usr/bin/env bash
# Stream contract for `bl report` (F-40 D1): the path of index.md, or the
# JSON, on stdout; diagnostics on stderr; exit 1 with empty stdout for a bad
# option or an output directory that is not a report's.
#
# Run from the bl repo root:
#   bash test/cli/report.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../helpers/tempdir.sh"
mk_temp_backlog

mkdir -p "$TMPDIR_ROOT/stories/S1-one"
cat > "$TMPDIR_ROOT/stories/S1-one/index.md" <<'MD'
---
component: C00
story_id: S-1
title: One
type: feature
points: 3
status: done
added: 2026-04-20
completed: 2026-04-21
---

# S-1 · One
MD

export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_AUTHOR_DATE="2026-04-21T09:00:00+00:00" GIT_COMMITTER_DATE="2026-04-21T09:00:00+00:00"
printf '.bl/\nerr\n' > "$TMPDIR_ROOT/.gitignore"
git -C "$TMPDIR_ROOT" init -q -b main
git -C "$TMPDIR_ROOT" add -A
git -C "$TMPDIR_ROOT" commit -q -m base

# The report: stdout is the page's path, and the tree stays clean.
set +e
OUT=$("$BL" report 2>"$TMPDIR_ROOT/err"); CODE=$?
set -e
assert_exit "bl report" 0 "$CODE"
assert_eq "bl report stdout" "$TMPDIR_ROOT/reports/index.md" "$OUT"
assert_contains "page heading" "# Backlog progress report" "$(cat "$TMPDIR_ROOT/reports/index.md")"
assert_contains "charts as vega-lite blocks" '```vega-lite' "$(cat "$TMPDIR_ROOT/reports/index.md")"
assert_eq "self-ignoring" "*" "$(cat "$TMPDIR_ROOT/reports/.gitignore")"
assert_empty "git status" "$(git -C "$TMPDIR_ROOT" status --porcelain)"

# JSON: one object on stdout, nothing on stderr.
set +e
OUT=$("$BL" report --json 2>"$TMPDIR_ROOT/err"); CODE=$?
set -e
assert_exit "bl report --json" 0 "$CODE"
assert_eq "json shape" "1 3 2026-04-21" "$(printf '%s' "$OUT" | node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(d.summary.stories.total, d.summary.points.byStatus.done, d.snapshot.date)')"
assert_empty "bl report --json stderr" "$(cat "$TMPDIR_ROOT/err")"

# Errors: exit 1, nothing on stdout, the reason on stderr.
mkdir -p "$TMPDIR_ROOT/.bl/mine"
echo keep > "$TMPDIR_ROOT/.bl/mine/notes.md"
for args in "--since yesterday" "--out" "--out $TMPDIR_ROOT/.bl/mine" "--charts" "--charts svg"; do
  set +e
  # shellcheck disable=SC2086
  OUT=$("$BL" report $args 2>"$TMPDIR_ROOT/err"); CODE=$?
  set -e
  assert_exit "bl report $args" 1 "$CODE"
  assert_empty "bl report $args stdout" "$OUT"
  assert_nonempty "bl report $args stderr" "$(cat "$TMPDIR_ROOT/err")"
done
assert_eq "not cleared" "keep" "$(cat "$TMPDIR_ROOT/.bl/mine/notes.md")"
set +e
"$BL" report --charts svg >/dev/null 2>"$TMPDIR_ROOT/err"
set -e
assert_contains "unknown adapter names the registered ones" "registered: vega-lite" "$(cat "$TMPDIR_ROOT/err")"

summary_and_exit
