#!/usr/bin/env bash
# Smoke test for `bl new --from <spec.json>`.
# Exits 0 on success; non-zero on the first failed assertion.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BL="$REPO_ROOT/bin/bl"

if [[ ! -x "$BL" ]]; then
  echo "FAIL: $BL not found or not executable" >&2
  exit 1
fi

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# Minimal backlog repo: backlog.json registers demo-repo and shared-config;
# demo-repo has its home component, C00 (F-49 D4).
cat > "$TMPDIR_ROOT/backlog.json" <<'JSON'
{
  "backlog": "backlog",
  "worktrees": "../worktrees",
  "agent": [{ "agent": "claude" }],
  "review_agent": [{ "agent": "claude" }],
  "repos": {
    "demo-repo": { "path": "../demo-repo", "deployable": false, "update_tests": [] },
    "shared-config": { "path": "../shared-config", "deployable": false, "update_tests": [] }
  }
}
JSON

write_components() {
  mkdir -p "$1/components/C00-core"
  cat > "$1/components/C00-core/index.md" <<'MD'
---
component_id: C00
title: Core
repo: demo-repo
home: true
---

# C00 · Core
MD
}
write_components "$TMPDIR_ROOT"

export BL_BACKLOG_DIR="$TMPDIR_ROOT"

PASS=0
FAIL=0
fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass; else fail "$label — expected '$expected', got '$actual'"; fi
}
assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass; else fail "$label — expected exit $expected, got $actual"; fi
}

SPEC_DIR="$TMPDIR_ROOT/spec"
mkdir -p "$SPEC_DIR/stories"

write_bodies() {
  cat > "$SPEC_DIR/component-body.md" <<'MD'
## Boundary

Test component {{componentId}} in {{repo}}.
MD
  cat > "$SPEC_DIR/stories/bootstrap.md" <<'MD'
## Summary

Bootstrap story body.
MD
  cat > "$SPEC_DIR/stories/ci.md" <<'MD'
## Summary

CI story body.
MD
  cat > "$SPEC_DIR/stories/template.md" <<'MD'
## Summary

Template story body.
MD
}
write_bodies

write_good_spec() {
  cat > "$SPEC_DIR/spec.json" <<'JSON'
{
  "component": {
    "repo": "shared-config",
    "title": "Cross-Repo Standards",
    "paths": ["**"],
    "body_file": "component-body.md"
  },
  "stories": [
    {
      "id": "bootstrap",
      "title": "Bootstrap shared-config",
      "points": 3,
      "body_file": "stories/bootstrap.md"
    },
    {
      "id": "ci",
      "title": "Reusable CI workflow",
      "points": 3,
      "body_file": "stories/ci.md"
    },
    {
      "id": "template",
      "title": "Repo template",
      "points": 2,
      "depends_on": ["@bootstrap", "@ci"],
      "body_file": "stories/template.md"
    }
  ]
}
JSON
}
write_good_spec

# ---------------------------------------------------------------------------
# --dry-run --json
# ---------------------------------------------------------------------------

so=$(mktemp); se=$(mktemp)
"$BL" new --from "$SPEC_DIR/spec.json" --dry-run --json >"$so" 2>"$se"
rc=$?
assert_exit "dry-run --json exit" "0" "$rc"

node -e '
const obj = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const errs = [];
if (obj.schema !== "bl-new-batch-json/v2") errs.push("schema");
if (obj.dry_run !== true) errs.push("dry_run flag");
if (obj.component.id !== "C01") errs.push("component.id (got " + obj.component.id + ")");
if (obj.component.created !== false) errs.push("component.created should be false in dry-run");
if ("epic" in obj) errs.push("no epic key in v2");
if (!Array.isArray(obj.stories) || obj.stories.length !== 3) errs.push("stories length");
const ph = obj.stories.map(s => s.placeholder).join(",");
if (ph !== "bootstrap,ci,template") errs.push("placeholders order");
if (obj.stories[0].id !== "S-1") errs.push("first story id");
if (obj.stories[2].id !== "S-3") errs.push("third story id");
if (obj.stories.some(s => s.component !== "C01")) errs.push("stories component");
if (obj.stories.some(s => s.created !== false)) errs.push("stories created should be false");
if (errs.length) { console.error(errs.join(", ")); process.exit(1); }
' "$so"
if [[ $? -eq 0 ]]; then pass; else fail "dry-run --json schema"; fi

# Filesystem must be unchanged.
if [[ -d "$TMPDIR_ROOT/components/C01-cross-repo-standards" || -d "$TMPDIR_ROOT/stories" ]]; then
  fail "dry-run wrote a component or story dir"
else
  pass
fi

# ---------------------------------------------------------------------------
# Apply (no flags, human output)
# ---------------------------------------------------------------------------

apply_se=$(mktemp)
"$BL" new --from "$SPEC_DIR/spec.json" >/dev/null 2>"$apply_se"
rc=$?
assert_exit "apply exit" "0" "$rc"

# No spurious warnings for @placeholder refs that resolve to siblings
# being created in this same batch (e.g. @bootstrap → S-1).
if grep -qE 'warning: (depends_on|required_for) S-[0-9]+' "$apply_se"; then
  fail "spurious sibling warning on apply: $(cat "$apply_se")"
else
  pass
fi

COMPONENT_DIR="$TMPDIR_ROOT/components/C01-cross-repo-standards"
STORIES="$TMPDIR_ROOT/stories"
if [[ -f "$COMPONENT_DIR/index.md" ]]; then pass; else fail "component index.md missing"; fi
case $(cat "$COMPONENT_DIR/index.md") in
  *"repo: shared-config"*"Test component C01 in shared-config."*) pass ;;
  *) fail "component frontmatter or body: $(cat "$COMPONENT_DIR/index.md")" ;;
esac
if [[ -f "$STORIES/S1-bootstrap-shared-config/index.md" ]]; then pass; else fail "story S-1 missing"; fi
if [[ -f "$STORIES/S2-reusable-ci-workflow/index.md" ]]; then pass; else fail "story S-2 missing"; fi
if [[ -f "$STORIES/S3-repo-template/index.md" ]]; then pass; else fail "story S-3 missing"; fi

# Placeholder substitution: S-3's frontmatter should list S-1, S-2, and it
# takes the component, whose repo is the story's: no repo field (F-52 D1).
TEMPLATE_FM=$(head -20 "$STORIES/S3-repo-template/index.md")
case "$TEMPLATE_FM" in
  *"depends_on: [S-1, S-2]"*) pass ;;
  *) fail "template story depends_on substitution: $TEMPLATE_FM" ;;
esac
case "$TEMPLATE_FM" in
  *"primary_repo"*) fail "template story writes no primary_repo: $TEMPLATE_FM" ;;
  *"component: C01"*) pass ;;
  *) fail "template story component: $TEMPLATE_FM" ;;
esac

# Body file content survived.
case $(cat "$STORIES/S1-bootstrap-shared-config/index.md") in
  *"Bootstrap story body."*) pass ;;
  *) fail "bootstrap body content missing" ;;
esac

# No stale tempdir left behind.
if compgen -G "$TMPDIR_ROOT/.bl-new-*" >/dev/null; then
  fail "stale tempdir present after apply"
else
  pass
fi

# ---------------------------------------------------------------------------
# Existing-story-dir collision: pre-create one, expect failure
# ---------------------------------------------------------------------------

# Use a fresh backlog dir for this test to avoid polluting later cases.
TMP_COLLIDE=$(mktemp -d)
cp "$TMPDIR_ROOT/backlog.json" "$TMP_COLLIDE/backlog.json"
write_components "$TMP_COLLIDE"

# A story dir with the name the plan will choose, but no story_id: it is
# not a story, so the next id is still S-1.
mkdir -p "$TMP_COLLIDE/stories/S1-clobbered"
echo "stub" > "$TMP_COLLIDE/stories/S1-clobbered/index.md"

cat > "$SPEC_DIR/spec-collide.json" <<'JSON'
{
  "component": "C00",
  "stories": [
    { "id": "x", "title": "Clobbered", "points": 1, "body_file": "stories/bootstrap.md" }
  ]
}
JSON

set +e
err=$(BL_BACKLOG_DIR="$TMP_COLLIDE" "$BL" new --from "$SPEC_DIR/spec-collide.json" 2>&1 >/dev/null); rc=$?
set -e
case "$err" in
  *"already exists"*) pass ;;
  *) fail "collision message expected (got: $err)" ;;
esac
rm -rf "$TMP_COLLIDE"

# ---------------------------------------------------------------------------
# Existing-component mode + per-story override + bare ID + mixed list
# ---------------------------------------------------------------------------

cat > "$SPEC_DIR/spec2.json" <<'JSON'
{
  "component": "C00",
  "stories": [
    {
      "id": "extra",
      "title": "Extra story",
      "points": 1,
      "body_file": "stories/bootstrap.md",
      "depends_on": ["S-1", "S-9999"]
    },
    {
      "id": "more",
      "title": "More work",
      "points": 1,
      "component": "C01",
      "body_file": "stories/ci.md",
      "depends_on": ["@extra"]
    }
  ]
}
JSON

so=$(mktemp); se=$(mktemp)
"$BL" new --from "$SPEC_DIR/spec2.json" --json >"$so" 2>"$se"
rc=$?
assert_exit "existing-component apply exit" "0" "$rc"

node -e '
const obj = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (obj.component.id !== "C00") { console.error("component.id"); process.exit(1); }
if (obj.component.created !== false) { console.error("component.created should be false"); process.exit(1); }
if (obj.stories[0].id !== "S-4") { console.error("first id " + obj.stories[0].id); process.exit(1); }
if (obj.stories[1].id !== "S-5") { console.error("second id"); process.exit(1); }
if (obj.stories[0].component !== "C00" || obj.stories[1].component !== "C01") { console.error("per-story component"); process.exit(1); }
' "$so"
if [[ $? -eq 0 ]]; then pass; else fail "existing-component JSON schema"; fi

# Stderr should mention warning about S-9999.
case $(cat "$se") in
  *"warning"*"S-9999"*) pass ;;
  *) fail "expected unknown bare-ID warning on stderr (got: $(cat "$se"))" ;;
esac

# Mixed list rendered as a flow sequence.
EXTRA_FM=$(head -20 "$STORIES/S4-extra-story/index.md")
case "$EXTRA_FM" in
  *"depends_on: [S-1, S-9999]"*) pass ;;
  *) fail "extra depends_on render: $EXTRA_FM" ;;
esac
case "$EXTRA_FM" in
  *"primary_repo"*) fail "extra writes no primary_repo: $EXTRA_FM" ;;
  *"component: C00"*) pass ;;
  *) fail "extra takes the spec's component C00: $EXTRA_FM" ;;
esac
MORE_FM=$(head -20 "$STORIES/S5-more-work/index.md")
case "$MORE_FM" in
  *"depends_on: [S-4]"*) pass ;;
  *) fail "more @extra resolved to S-4: $MORE_FM" ;;
esac
case "$MORE_FM" in
  *"primary_repo"*) fail "more writes no primary_repo: $MORE_FM" ;;
  *"component: C01"*) pass ;;
  *) fail "more takes its own component: $MORE_FM" ;;
esac

# ---------------------------------------------------------------------------
# Validation: unknown placeholder
# ---------------------------------------------------------------------------

cat > "$SPEC_DIR/bad1.json" <<'JSON'
{
  "component": "C00",
  "stories": [
    { "id": "a", "title": "A", "points": 1, "body_file": "stories/bootstrap.md",
      "depends_on": ["@nope"] }
  ]
}
JSON
set +e
err=$("$BL" new --from "$SPEC_DIR/bad1.json" 2>&1 >/dev/null); rc=$?
set -e
assert_exit "unknown placeholder exit" "2" "$rc"
case "$err" in
  *"unknown placeholder"*"@nope"*) pass ;;
  *) fail "unknown placeholder message: $err" ;;
esac

# ---------------------------------------------------------------------------
# Validation: non-Fibonacci points
# ---------------------------------------------------------------------------

cat > "$SPEC_DIR/bad2.json" <<'JSON'
{
  "component": "C00",
  "stories": [
    { "id": "a", "title": "A", "points": 4, "body_file": "stories/bootstrap.md" }
  ]
}
JSON
set +e
err=$("$BL" new --from "$SPEC_DIR/bad2.json" 2>&1 >/dev/null); rc=$?
set -e
assert_exit "non-Fibonacci points exit" "2" "$rc"
case "$err" in
  *"Fibonacci"*) pass ;;
  *) fail "Fibonacci message: $err" ;;
esac

# ---------------------------------------------------------------------------
# Validation: body_file missing
# ---------------------------------------------------------------------------

cat > "$SPEC_DIR/bad3.json" <<'JSON'
{
  "component": "C00",
  "stories": [
    { "id": "a", "title": "A", "points": 1, "body_file": "stories/missing.md" }
  ]
}
JSON
set +e
err=$("$BL" new --from "$SPEC_DIR/bad3.json" 2>&1 >/dev/null); rc=$?
set -e
assert_exit "missing body_file exit" "2" "$rc"
case "$err" in
  *"file not found"*) pass ;;
  *) fail "missing body_file message: $err" ;;
esac

# ---------------------------------------------------------------------------
# Validation: body file with frontmatter
# ---------------------------------------------------------------------------

cat > "$SPEC_DIR/has-fm.md" <<'MD'
---
foo: bar
---

Body
MD
cat > "$SPEC_DIR/bad4.json" <<'JSON'
{
  "component": "C00",
  "stories": [
    { "id": "a", "title": "A", "points": 1, "body_file": "has-fm.md" }
  ]
}
JSON
set +e
err=$("$BL" new --from "$SPEC_DIR/bad4.json" 2>&1 >/dev/null); rc=$?
set -e
assert_exit "frontmatter-in-body exit" "2" "$rc"
case "$err" in
  *"frontmatter"*) pass ;;
  *) fail "frontmatter-in-body message: $err" ;;
esac

# ---------------------------------------------------------------------------
# Validation: dry-run also catches body-file frontmatter (end-to-end)
# ---------------------------------------------------------------------------

set +e
err=$("$BL" new --from "$SPEC_DIR/bad4.json" --dry-run 2>&1 >/dev/null); rc=$?
set -e
assert_exit "dry-run frontmatter exit" "2" "$rc"
case "$err" in
  *"frontmatter"*) pass ;;
  *) fail "dry-run frontmatter detection: $err" ;;
esac

# ---------------------------------------------------------------------------
# Validation: spec is not a JSON object
# ---------------------------------------------------------------------------

echo '["not an object"]' > "$SPEC_DIR/bad-array.json"
set +e
err=$("$BL" new --from "$SPEC_DIR/bad-array.json" 2>&1 >/dev/null); rc=$?
set -e
assert_exit "non-object spec exit" "2" "$rc"
case "$err" in
  *"must be a JSON object"*) pass ;;
  *) fail "non-object spec message: $err" ;;
esac

# ---------------------------------------------------------------------------
# Validation: nonexistent component, an E-id, a pre-F-49 epic block
# ---------------------------------------------------------------------------

cat > "$SPEC_DIR/bad-component.json" <<'JSON'
{
  "component": "C99",
  "stories": [
    { "id": "a", "title": "A", "points": 1, "body_file": "stories/bootstrap.md" }
  ]
}
JSON
set +e
err=$("$BL" new --from "$SPEC_DIR/bad-component.json" 2>&1 >/dev/null); rc=$?
set -e
assert_exit "nonexistent component exit" "2" "$rc"
case "$err" in
  *"component 'C99' not found"*) pass ;;
  *) fail "nonexistent component message: $err" ;;
esac

cat > "$SPEC_DIR/bad-eid.json" <<'JSON'
{
  "component": "E00",
  "stories": [
    { "id": "a", "title": "A", "points": 1, "body_file": "stories/bootstrap.md" }
  ]
}
JSON
set +e
err=$("$BL" new --from "$SPEC_DIR/bad-eid.json" 2>&1 >/dev/null); rc=$?
set -e
assert_exit "E-id component exit" "2" "$rc"
case "$err" in
  *"E00 is not a component id: components are C-ids (C00)."*) pass ;;
  *) fail "E-id component message: $err" ;;
esac

cat > "$SPEC_DIR/bad-epic.json" <<'JSON'
{
  "epic": { "id": "E00", "project": "demo" },
  "stories": [
    { "id": "a", "title": "A", "points": 1, "body_file": "stories/bootstrap.md" }
  ]
}
JSON
set +e
err=$("$BL" new --from "$SPEC_DIR/bad-epic.json" 2>&1 >/dev/null); rc=$?
set -e
assert_exit "epic block exit" "2" "$rc"
case "$err" in
  *"the epic block is gone"*) pass ;;
  *) fail "epic block message: $err" ;;
esac

# ---------------------------------------------------------------------------
# Validation: component id normalization (C0 → C00)
# ---------------------------------------------------------------------------

cat > "$SPEC_DIR/component-norm.json" <<'JSON'
{
  "component": "c0",
  "stories": [
    { "id": "a", "title": "A", "points": 1, "body_file": "stories/bootstrap.md" }
  ]
}
JSON
set +e
"$BL" new --from "$SPEC_DIR/component-norm.json" --dry-run >/dev/null 2>&1
rc=$?
set -e
assert_exit "component c0 normalizes to C00 (dry-run exit)" "0" "$rc"

# ---------------------------------------------------------------------------
# Validation: missing --from value (e.g. `bl new --from --json`)
# ---------------------------------------------------------------------------

set +e
err=$("$BL" new --from --json 2>&1 >/dev/null); rc=$?
set -e
assert_exit "missing --from value exit" "1" "$rc"
case "$err" in
  *"--from requires a path"*) pass ;;
  *) fail "missing --from value message: $err" ;;
esac

# ---------------------------------------------------------------------------
# Disallowed flags
# ---------------------------------------------------------------------------

set +e
err=$("$BL" new --from "$SPEC_DIR/spec.json" --title foo 2>&1 >/dev/null); rc=$?
set -e
assert_exit "disallowed --title exit" "1" "$rc"
case "$err" in
  *"--title is not allowed"*) pass ;;
  *) fail "disallowed --title message: $err" ;;
esac

# ---------------------------------------------------------------------------
# Non-.json extension
# ---------------------------------------------------------------------------

cp "$SPEC_DIR/spec.json" "$SPEC_DIR/spec.txt"
set +e
err=$("$BL" new --from "$SPEC_DIR/spec.txt" 2>&1 >/dev/null); rc=$?
set -e
assert_exit "non-json extension exit" "1" "$rc"
case "$err" in
  *"must end in .json"*) pass ;;
  *) fail "extension message: $err" ;;
esac

# ---------------------------------------------------------------------------
# Atomicity: BL_INTERNAL_TEST_FAIL_ON_STORY mid-write — no partial files
# ---------------------------------------------------------------------------

# Reset by re-creating backlog dirs on a fresh tmp.
TMPDIR_2=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT" "$TMPDIR_2"' EXIT
cp "$TMPDIR_ROOT/backlog.json" "$TMPDIR_2/backlog.json"
write_components "$TMPDIR_2"

# Spec under the new tmp.
SPEC2_DIR="$TMPDIR_2/spec"
mkdir -p "$SPEC2_DIR/stories"
cp "$SPEC_DIR/component-body.md" "$SPEC2_DIR/"
cp "$SPEC_DIR/stories/bootstrap.md" "$SPEC2_DIR/stories/"
cp "$SPEC_DIR/stories/ci.md" "$SPEC2_DIR/stories/"
cp "$SPEC_DIR/stories/template.md" "$SPEC2_DIR/stories/"
cp "$SPEC_DIR/spec.json" "$SPEC2_DIR/spec.json"

set +e
BL_BACKLOG_DIR="$TMPDIR_2" BL_INTERNAL_TEST_FAIL_ON_STORY=S-3 \
  "$BL" new --from "$SPEC2_DIR/spec.json" 2>/dev/null
rc=$?
set -e
assert_exit "injected failure exit" "1" "$rc"

# No component dir, no story dirs, no stale tempdir.
if [[ -d "$TMPDIR_2/components/C01-cross-repo-standards" ]]; then
  fail "atomicity: component dir present after failure"
else
  pass
fi
if [[ -d "$TMPDIR_2/stories" ]] && compgen -G "$TMPDIR_2/stories/S*" >/dev/null; then
  fail "atomicity: story dirs present after failure"
else
  pass
fi
if compgen -G "$TMPDIR_2/.bl-new-*" >/dev/null; then
  fail "atomicity: stale tempdir present"
else
  pass
fi

# ---------------------------------------------------------------------------
# bl new --help mentions --from
# ---------------------------------------------------------------------------

helptxt=$("$BL" new --help)
case "$helptxt" in
  *"--from"*) pass ;;
  *) fail "bl new --help missing --from" ;;
esac
case "$helptxt" in
  *"--dry-run"*) pass ;;
  *) fail "bl new --help missing --dry-run" ;;
esac

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if (( FAIL > 0 )); then
  echo "FAIL: $FAIL test(s) failed; $PASS passed" >&2
  exit 1
fi
echo "PASS: $PASS test(s) passed"
