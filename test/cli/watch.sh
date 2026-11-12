#!/usr/bin/env bash
# `bl watch <id>` (S-1272): it follows the run state's session, moves to the
# next step's session, prints the end line when the run ends and exits 0;
# with no run state it exits 1. stdout carries only the event lines and
# headers, and diagnostics go to stderr.
#
# Run from the bl repo root:
#   bash test/cli/watch.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../helpers/tempdir.sh"
mk_temp_backlog
FIXTURES="$SCRIPT_DIR/../fixtures/watch"
BL_ROOT="$(cd "$(dirname "$BL")/.." && pwd)"
# bl appends to the activity log of the git checkout it runs in: run it in the temp backlog.
cd "$TMPDIR_ROOT"

RUN="$TMPDIR_ROOT/.bl/run"
mkdir -p "$RUN"
OUT="$TMPDIR_ROOT/out"
ERR="$TMPDIR_ROOT/err"

# set_state <status> <agent> <path> <step> <story>: write F-9's run state with that session.
set_state() {
  node -e '
    const [file, status, agent, path, step, story] = process.argv.slice(1);
    const session = { step, story: story || null, agent, model: null, id: agent === "claude" ? "sid-1" : null, path, startedAt: step };
    require("fs").writeFileSync(file, JSON.stringify({ feature: "F-9", status, step, history: [], session }));
  ' "$RUN/F-9.json" "$@"
}

# No run state: exit 1, stdout empty, the reason on stderr.
set +e
"$BL" watch F-9 >"$OUT" 2>"$ERR"; CODE=$?
set -e
assert_exit "bl watch with no run state" 1 "$CODE"
assert_empty "bl watch with no run state: stdout" "$(cat "$OUT")"
assert_contains "bl watch with no run state: stderr" "bl watch: no run state for F-9" "$(cat "$ERR")"

# Bad arguments: exit 1, stdout empty.
for args in "" "nope" "F-9 F-10" "F-9 --nope"; do
  set +e
  # shellcheck disable=SC2086
  "$BL" watch $args >"$OUT" 2>"$ERR"; CODE=$?
  set -e
  assert_exit "bl watch $args" 1 "$CODE"
  assert_empty "bl watch $args: stdout" "$(cat "$OUT")"
  assert_contains "bl watch $args: stderr" "bl watch: " "$(cat "$ERR")"
done

# A running run: a bl holds its run lock while watch follows a Claude step, then a Codex step.
cp "$FIXTURES/claude-transcript.jsonl" "$TMPDIR_ROOT/claude.jsonl"
set_state running claude "$TMPDIR_ROOT/claude.jsonl" implement S-1
node -e '
  import(process.argv[1]).then((m) => {
    m.tryLock(process.argv[2]);
    setInterval(() => {}, 1000);
  });
' "$BL_ROOT/src/kernel-lock.js" "$RUN/F-9.lock" &
HOLDER=$!
trap 'kill "$HOLDER" 2>/dev/null || true; rm -rf "${CLEANUP_PATHS[@]}"' EXIT
for _ in $(seq 100); do [[ -s "$RUN/F-9.lock" ]] && break; sleep 0.1; done

"$BL" watch F-9 --json >"$OUT" 2>"$ERR" &
WATCH=$!
lines() { wc -l <"$OUT"; }
for _ in $(seq 100); do (( $(lines) >= 6 )) && break; sleep 0.1; done
set_state running codex "$TMPDIR_ROOT/codex.jsonl" review:correctness ""
for _ in $(seq 100); do (( $(lines) >= 7 )) && break; sleep 0.1; done
cp "$FIXTURES/codex-events.jsonl" "$TMPDIR_ROOT/codex.jsonl"
for _ in $(seq 100); do (( $(lines) >= 13 )) && break; sleep 0.1; done
set_state escalated codex "$TMPDIR_ROOT/codex.jsonl" review:correctness ""
# The run's bl lets the run go after it saves its end; watch ends when no bl holds the run.
kill "$HOLDER" 2>/dev/null || true
wait "$HOLDER" 2>/dev/null || true
set +e
wait "$WATCH"; CODE=$?
set -e
assert_exit "bl watch exits 0 when the run ends" 0 "$CODE"
assert_eq "--json: the Claude step, its events, the Codex step, its events, the end" \
  "step:implement:S-1:claude:sid-1 text tool tool tool text step:review:correctness::codex: tool text tool tool tool text end:escalated" \
  "$(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
    console.log(lines.map((o) => o.kind === "step" ? `step:${o.step}:${o.story ?? ""}:${o.agent}:${o.session ?? ""}` : o.kind === "end" ? `end:${o.status}` : o.kind).join(" "));
  ' "$OUT")"
assert_empty "bl watch --json stderr" "$(cat "$ERR")"

# A run that has ended, in text: the session from its start, then the end line.
set_state clean claude "$TMPDIR_ROOT/claude.jsonl" self-review ""
set +e
"$BL" watch F-9 --from-start >"$OUT" 2>"$ERR"; CODE=$?
set -e
assert_exit "bl watch on an ended run" 0 "$CODE"
assert_eq "text: a header, one line per event, the end line" "$(printf '%s\n' \
  '── self-review · claude · sid-1 ──' \
  "💬 I'll read the story first." \
  '🔧 Read  /w/backlog/stories/S1-first/index.md' \
  '🔧 Grep  followSession' \
  '🔧 Bash  Run the unit tests' \
  '💬 Done. All unit tests pass.' \
  '── F-9 · clean ──')" "$(cat "$OUT")"
assert_empty "bl watch text stderr" "$(cat "$ERR")"

summary_and_exit
