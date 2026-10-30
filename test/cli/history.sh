#!/usr/bin/env bash
# Stream contract for `bl history` (F-40 D1): the table or the JSON on stdout,
# diagnostics on stderr, exit 1 with empty stdout for a bad option or scope.
#
# Run from the bl repo root:
#   bash test/cli/history.sh
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
status: backlog
added: 2026-04-20
---

# S-1 · One
MD

export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_AUTHOR_DATE="2026-04-21T09:00:00+00:00" GIT_COMMITTER_DATE="2026-04-21T09:00:00+00:00"
printf '.bl/\n' > "$TMPDIR_ROOT/.gitignore"
git -C "$TMPDIR_ROOT" init -q -b main
git -C "$TMPDIR_ROOT" add -A
git -C "$TMPDIR_ROOT" commit -q -m base

# Table: header, separator and the week, its last snapshot the commit's.
set +e
OUT=$("$BL" history 2>"$TMPDIR_ROOT/err"); CODE=$?
set -e
assert_exit "bl history" 0 "$CODE"
assert_contains "table header" "| Week     | Date" "$OUT"

assert_contains "commit row" "| 2026-W17 | 2026-04-21 " "$OUT"
assert_empty "bl history stderr" "$(cat "$TMPDIR_ROOT/err")"

# JSON: one object with days (the backfilled 2026-04-20 first), groups and
# unreadable.
set +e
OUT=$("$BL" history --json 2>"$TMPDIR_ROOT/err"); CODE=$?
set -e
assert_exit "bl history --json" 0 "$CODE"
assert_eq "json shape" "2026-04-20 true S-1 0" "$(printf '%s' "$OUT" | node -e 'const h = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(h.days[0].date, h.days[0].backfilled, Object.keys(h.groups.stories).join(","), h.unreadable)')"
assert_empty "bl history --json stderr" "$(cat "$TMPDIR_ROOT/err")"

# --since drops the earlier days.
OUT=$("$BL" history --json --since 2026-04-21)
assert_eq "--since" "2026-04-21" "$(printf '%s' "$OUT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).days.map((d) => d.date).join(","))')"

# Errors: exit 1, nothing on stdout, the reason on stderr.
for args in "--scope F-99" "--scope nosuch" "--since yesterday"; do
  set +e
  # shellcheck disable=SC2086
  OUT=$("$BL" history $args 2>"$TMPDIR_ROOT/err"); CODE=$?
  set -e
  assert_exit "bl history $args" 1 "$CODE"
  assert_empty "bl history $args stdout" "$OUT"
  assert_nonempty "bl history $args stderr" "$(cat "$TMPDIR_ROOT/err")"
done
assert_contains "unknown scope named" "unknown scope nosuch" "$(env BL_BACKLOG_DIR="$TMPDIR_ROOT" "$BL" history --scope nosuch 2>&1 || true)"

summary_and_exit
