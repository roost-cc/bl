#!/usr/bin/env bash
# Stream contract for `bl top` (F-87 D1, D3): --json prints one snapshot,
# --stream one per line until stdin closes; only JSON on stdout; with no flag
# it exits 1 until the Go TUI comes (S-1332).
#
# Run from the bl repo root:
#   bash test/cli/top.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../helpers/tempdir.sh"
mk_temp_backlog

TODAY=$(date -u +%F)
mkdir -p "$TMPDIR_ROOT/stories/S1-one"
cat > "$TMPDIR_ROOT/stories/S1-one/index.md" <<MD
---
component: C00
story_id: S-1
title: One
type: feature
points: 3
status: done
added: $TODAY
completed: $TODAY
---

# S-1 · One
MD

export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
printf '.bl/\n' > "$TMPDIR_ROOT/.gitignore"
git -C "$TMPDIR_ROOT" init -q -b main
git -C "$TMPDIR_ROOT" add -A
git -C "$TMPDIR_ROOT" commit -q -m base

# A run state that says running, with a lock whose bl is gone.
mkdir -p "$TMPDIR_ROOT/.bl/run"
NOW=$(date -u +%FT%TZ)
cat > "$TMPDIR_ROOT/.bl/run/F-9.json" <<JSON
{"feature":"F-9","status":"running","step":"implement","startedAt":"$NOW","updatedAt":"$NOW","history":[]}
JSON
true &
DEAD=$!
wait "$DEAD"
printf '%s\n' "$DEAD" > "$TMPDIR_ROOT/.bl/run/F-9.lock"

ERR="$TMPDIR_ROOT/err"

# --json: one object, the schema, every section with an ISO read_at.
set +e
OUT=$("$BL" top --json 2>"$ERR"); CODE=$?
set -e
assert_exit "bl top --json" 0 "$CODE"
assert_eq "--json shape" "bl-top-json/v1 runs,attention,next,capacity,history all-read" "$(printf '%s' "$OUT" | node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const names = Object.keys(s).filter((k) => k !== "schema" && k !== "at");
  const iso = names.every((k) => /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(s[k].read_at ?? "") && !s[k].error);
  console.log(s.schema, names.join(","), iso ? "all-read" : JSON.stringify(s));
')"
assert_eq "--json runs: a running run with a dead lock is stale" "F-9 stale null" "$(printf '%s' "$OUT" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8")).runs.rows[0];
  console.log(r.id, r.status, r.pid);
')"
assert_eq "--json history: 30 days, today holds S-1 and its points" "30 $TODAY S-1 3" "$(printf '%s' "$OUT" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8")).history.days;
  const last = d.at(-1);
  console.log(d.length, last.date, last.stories.join(","), last.points);
')"
assert_eq "--json next: the pick is bl next's" "$("$BL" next 2>/dev/null)" "$(printf '%s' "$OUT" | node -e '
  console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).next.pick?.id ?? "")
')"
assert_empty "bl top --json stderr" "$(cat "$ERR")"

# --stream: one snapshot per line; a capacity line reads capacity again; stdin
# closing ends it with exit 0.
FIFO="$TMPDIR_ROOT/in"
mkfifo "$FIFO"
"$BL" top --stream --interval 500 <"$FIFO" >"$TMPDIR_ROOT/out" 2>"$ERR" &
PID=$!
exec 3>"$FIFO"
lines() { wc -l <"$TMPDIR_ROOT/out"; }
for _ in $(seq 300); do (( $(lines) >= 1 )) && break; sleep 0.1; done
echo capacity >&3
for _ in $(seq 300); do (( $(lines) >= 4 )) && break; sleep 0.1; done
exec 3>&-
set +e
wait "$PID"; CODE=$?
set -e
assert_exit "bl top --stream exits 0 when stdin closes" 0 "$CODE"
assert_eq "--stream: every line a snapshot; capacity read again after the capacity line" "ok" "$(node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const caps = new Set(lines.map((s) => s.capacity.read_at));
  const runs = new Set(lines.map((s) => s.runs.read_at));
  const ok = lines.length >= 4 && lines.every((s) => s.schema === "bl-top-json/v1") && caps.size >= 2 && runs.size === lines.length;
  console.log(ok ? "ok" : `${lines.length} lines, ${caps.size} capacity reads, ${runs.size} runs reads`);
' "$TMPDIR_ROOT/out")"
assert_empty "bl top --stream stderr" "$(cat "$ERR")"

# No flag (until S-1332), or a bad flag: exit 1, nothing on stdout.
for args in "" "--json --stream" "--stream --interval 50" "--json --interval 1000" "--nope"; do
  set +e
  # shellcheck disable=SC2086
  OUT=$("$BL" top $args 2>"$ERR"); CODE=$?
  set -e
  assert_exit "bl top $args" 1 "$CODE"
  assert_empty "bl top $args stdout" "$OUT"
  assert_contains "bl top $args stderr" "bl top: " "$(cat "$ERR")"
done
set +e
"$BL" top 2>"$ERR"
set -e
assert_eq "bl top with no flag" "bl top: the TUI is not built yet; use --json or --stream" "$(cat "$ERR")"

summary_and_exit
