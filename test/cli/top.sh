#!/usr/bin/env bash
# Stream contract for `bl top` (F-87 D1, D3): --json prints one snapshot,
# --stream one per line until stdin closes; only JSON on stdout. With neither,
# bl top builds the Go TUI when it needs a build (D2) and runs it.
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
assert_eq "--json shape" "bl-top-json/v1 runs,attention,next,capacity,history,activity,tokens all-read" "$(printf '%s' "$OUT" | node -e '
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

# A bad flag: exit 1, nothing on stdout.
for args in "--json --stream" "--stream --interval 50" "--interval 50" "--json --interval 1000" "--json --version" "--json --no-bell" "--stream --no-desktop" "--json --no-push" "--nope"; do
  set +e
  # shellcheck disable=SC2086
  OUT=$("$BL" top $args 2>"$ERR"); CODE=$?
  set -e
  assert_exit "bl top $args" 1 "$CODE"
  assert_empty "bl top $args stdout" "$OUT"
  assert_contains "bl top $args stderr" "bl top: " "$(cat "$ERR")"
done

# The view's build (D2). With no top/bin/, a bl top with no go on PATH exits 1 and names the Go
# version that top/go.mod needs; with go on PATH, bl top --version builds top/bin/bl-top and runs
# it. bin/bl needs more than node on PATH, so this runs src/bl.js.
BL_ROOT="$(cd "$(dirname "$BL")/.." && pwd)"
GO_VERSION=$(sed -n 's/^go //p' "$BL_ROOT/top/go.mod")
NOGO="$TMPDIR_ROOT/nogo"
mkdir -p "$NOGO"
ln -s "$(command -v node)" "$NOGO/node"
rm -rf "$BL_ROOT/top/bin"
set +e
OUT=$(env PATH="$NOGO" node "$BL_ROOT/src/bl.js" top --version 2>"$ERR"); CODE=$?
set -e
assert_exit "bl top with no go on PATH" 1 "$CODE"
assert_empty "bl top with no go on PATH: stdout" "$OUT"
assert_contains "bl top with no go on PATH names the Go version" "go is not on PATH; install Go $GO_VERSION (top/go.mod)" "$(cat "$ERR")"
set +e
OUT=$("$BL" top --version 2>"$ERR"); CODE=$?
set -e
assert_exit "bl top --version builds the view" 0 "$CODE"
assert_contains "bl top --version prints the view's version" "bl-top go" "$OUT"
assert_eq "bl top --version leaves the binary built" "yes" "$([[ -x "$BL_ROOT/top/bin/bl-top" ]] && echo yes || echo no)"
set +e
"$BL" top --version >/dev/null 2>"$ERR"
set -e
assert_empty "a second bl top --version does not build again" "$(cat "$ERR")"
set +e
OUT=$("$BL" top --version --no-bell --no-desktop 2>"$ERR"); CODE=$?
set -e
assert_exit "bl top passes --no-bell and --no-desktop to the view" 0 "$CODE"
assert_contains "bl top --no-bell --no-desktop --version" "bl-top go" "$OUT"

# The phone push (D8a). bl top reads backlog.json's "top" block before it starts the view: a bad
# block exits 1 and names the key; --json and --stream do not read it. A good block reaches the
# view as --push-argv; here a fake view, newer than every file under top/, prints its arguments
# and its BL_TAB_TITLE.
CFG="$TMPDIR_ROOT/backlog.json"
cp "$CFG" "$TMPDIR_ROOT/backlog.json.good"
set_top() {
  node -e '
    const f = process.argv[1], c = JSON.parse(require("fs").readFileSync(f, "utf8"));
    c.top = JSON.parse(process.argv[2]);
    require("fs").writeFileSync(f, JSON.stringify(c));
  ' "$CFG" "$1"
}
set_top '{"push": []}'
set +e
OUT=$("$BL" top </dev/null 2>"$ERR"); CODE=$?
set -e
assert_exit "bl top with a bad top block" 1 "$CODE"
assert_empty "bl top with a bad top block: stdout" "$OUT"
assert_contains "bl top with a bad top block names the key" 'backlog.json "top" needs a non-empty array of non-empty strings for "push"' "$(cat "$ERR")"
set +e
"$BL" top --json >/dev/null 2>"$ERR"; CODE=$?
set -e
assert_exit "bl top --json does not read the top block" 0 "$CODE"
set +e
"$BL" top --version >/dev/null 2>"$ERR"; CODE=$?
set -e
assert_exit "bl top --version does not read the top block" 0 "$CODE"
set_top '{"push": ["phone-push", "--topic", "bl top"]}'
mv "$BL_ROOT/top/bin/bl-top" "$BL_ROOT/top/bin/bl-top.real"
printf '#!/bin/sh\nprintf "%%s\\n" "$@"\nprintf "title=[%%s]\\n" "${BL_TAB_TITLE-unset}"\n' > "$BL_ROOT/top/bin/bl-top"
chmod +x "$BL_ROOT/top/bin/bl-top"
set +e
OUT=$(env -u BL_TAB_TITLE "$BL" top 2>"$ERR")
NO_PUSH=$("$BL" top --no-push 2>"$ERR")
INTERVAL=$("$BL" top --interval 1e3 --version 2>"$ERR")
# A view that cannot start (not executable): exit 1, and stderr says why.
chmod -x "$BL_ROOT/top/bin/bl-top"
"$BL" top 2>"$ERR"; NOT_RUN=$?
NOT_RUN_ERR=$(cat "$ERR")
set -e
# The real view goes back first, so a failed assert leaves no fake behind.
mv "$BL_ROOT/top/bin/bl-top.real" "$BL_ROOT/top/bin/bl-top"
assert_contains "bl top passes the push argv to the view" "$(printf -- '--push-argv\n["phone-push","--topic","bl top"]')" "$OUT"
# The view and every bl it runs in this window run with tab titles off (S-1412).
assert_contains "bl top starts the view with BL_TAB_TITLE empty" "title=[]" "$OUT"
assert_contains "bl top --no-push passes --no-push to the view" "--no-push" "$NO_PUSH"
assert_contains "bl top --interval 1e3 passes the checked number to the view" "$(printf -- '--interval\n1000\n')" "$INTERVAL"
assert_exit "bl top with a view that cannot start" 1 "$NOT_RUN"
assert_contains "bl top says why the view did not start" "bl top: cannot run $BL_ROOT/top/bin/bl-top: " "$NOT_RUN_ERR"
mv "$TMPDIR_ROOT/backlog.json.good" "$CFG"

# With no backlog, bl top exits 1 before it starts the view, and says how to name one;
# bl top --version reads no backlog.
NOWHERE=$(mktemp -d)
set +e
(cd "$NOWHERE" && env -u BL_BACKLOG_DIR "$BL" top </dev/null >/dev/null 2>"$ERR")
CODE=$?
VERSION=$(cd "$NOWHERE" && env -u BL_BACKLOG_DIR "$BL" top --version 2>/dev/null)
VERSION_CODE=$?
set -e
rm -rf "$NOWHERE"
assert_exit "bl top --version with no backlog" 0 "$VERSION_CODE"
assert_contains "bl top --version with no backlog prints the version" "bl-top go" "$VERSION"
assert_exit "bl top with no backlog" 1 "$CODE"
assert_contains "bl top with no backlog says how to name one" "set BL_BACKLOG_DIR" "$(cat "$ERR")"

summary_and_exit
