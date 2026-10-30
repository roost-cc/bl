#!/usr/bin/env bash
# The ID collectors in the three shell completion files emit only canonical
# IDs backed by well-formed directory (or branch) names. A malformed name
# (`Foops`, `F2bad`, `F7`, `F3-`, a branch `side-bl-verbs`) is ignored: never
# converted to an ID and never emitted as a raw path. Archived features under
# `.completed/` and a missing backlog yield nothing.
#
# Table-driven over {bash, zsh, _bl} x {feature, story, component, worktree}.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPLETIONS="$REPO_ROOT/completions"

TMP=$(mktemp -d -t bl-completions-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass; else fail "$label — expected '$expected', got '$actual'"; fi
}

# ── Fixtures ───────────────────────────────────────────────────────────────
# Valid: F1-good, C1-good, S1-good, branch s1-good. Everything else is
# malformed (nonnumeric, numeric prefix without the dash, no slug, a dash with
# an empty slug), archived, or not a directory.
REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
mkdir -p "$REPO/backlog/features"/{F1-good,Foops,F2bad,F7,F3-,.completed/F4-archived}
touch "$REPO/backlog/features/F9-file"
mkdir -p "$REPO/backlog/components"/{C1-good,Coops,C2bad,C7,C3-}
mkdir -p "$REPO/backlog/stories"/{S1-good,Soops,S2bad,S7,S3-}
for b in s1-good side-bl-verbs s2bad s3-; do
  git -C "$REPO" worktree add -q -b "$b" "$TMP/wt-$b" >/dev/null 2>&1
done

# Only empty-slug names (`F1-`, `C1-`, `S1-`, branch `s1-`): every
# collector must yield nothing.
SLUGLESS="$TMP/slugless"
mkdir -p "$SLUGLESS/backlog/features/F1-" "$SLUGLESS/backlog/components/C1-" "$SLUGLESS/backlog/stories/S1-"
git -C "$SLUGLESS" init -q
git -C "$SLUGLESS" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$SLUGLESS" worktree add -q -b s1- "$TMP/wt-slugless" >/dev/null 2>&1

EMPTY="$TMP/empty"
mkdir -p "$EMPTY"
git -C "$EMPTY" init -q

# run_collector <shell> <file> <fn> <cwd>: source the completion file in a
# fresh shell and print one collector's output. `_bl` ends by calling `_bl`,
# so the zsh runner stubs `_describe` and sets CURRENT=2 to return early;
# `backlog.zsh` ends with `compdef`, which fails outside an interactive
# shell, so the collector runs regardless of the source's exit status.
run_collector() {
  local shell="$1" file="$2" fn="$3" cwd="$4"
  case "$shell" in
    bash) bash -c 'cd "$3" && { source "$1"; "$2"; }' _ "$file" "$fn" "$cwd" 2>/dev/null || true ;;
    zsh) zsh -c '_describe() { :; }; CURRENT=2; cd "$3" && { source "$1"; "$2"; }' _ "$file" "$fn" "$cwd" 2>/dev/null || true ;;
  esac
}

# ── Table ──────────────────────────────────────────────────────────────────
VARIANTS=(
  "bash $COMPLETIONS/backlog.bash"
  "zsh $COMPLETIONS/backlog.zsh"
  "zsh $COMPLETIONS/_bl"
)
COLLECTORS=(
  "_roost_feature_ids F-1"
  "_roost_story_ids S-1"
  "_roost_component_ids C1"
  "_roost_worktree_story_ids S-1"
)

for variant in "${VARIANTS[@]}"; do
  read -r shell file <<<"$variant"
  if ! command -v "$shell" >/dev/null 2>&1; then
    echo "SKIP: $shell not installed; $(basename "$file") not tested" >&2
    continue
  fi
  for row in "${COLLECTORS[@]}"; do
    read -r fn expected <<<"$row"
    actual=$(run_collector "$shell" "$file" "$fn" "$REPO")
    assert_eq "$(basename "$file") $fn ignores malformed names" "$expected" "$actual"
    actual=$(run_collector "$shell" "$file" "$fn" "$EMPTY")
    assert_eq "$(basename "$file") $fn with no backlog" "" "$actual"
    actual=$(run_collector "$shell" "$file" "$fn" "$SLUGLESS")
    assert_eq "$(basename "$file") $fn: completion collectors ignore empty-slug directory and branch names" "" "$actual"
  done
done

# The bash completer itself: `bl approve F<TAB>` offers only the valid
# feature; `bl implement <TAB>` offers the valid story and feature.
complete_bash() {
  bash -c '
    cd "$1" && source "$2"
    COMP_WORDS=(bl "$3" "$4"); COMP_CWORD=2
    _roost_bl 2>/dev/null || true
    printf "%s\n" "${COMPREPLY[*]:-}"
  ' _ "$REPO" "$COMPLETIONS/backlog.bash" "$@"
}
assert_eq "feature completions ignore malformed directory names" "F-1" "$(complete_bash approve F)"
assert_eq "bl implement completes story and feature ids" "S-1 F-1" "$(complete_bash implement "")"
assert_eq "bl inbox completes its subcommand and flag" "done --json" "$(complete_bash inbox "")"
assert_eq "bl capacity completes its flags" "--json --help" "$(complete_bash capacity "")"
first_word=$(bash -c '
  source "$1"
  COMP_WORDS=(bl cap); COMP_CWORD=1
  _roost_bl 2>/dev/null || true
  printf "%s\n" "${COMPREPLY[*]:-}"
' _ "$COMPLETIONS/backlog.bash")
assert_eq "bl cap<TAB> completes to capacity" "capacity" "$first_word"
for file in "$COMPLETIONS/_bl" "$COMPLETIONS/backlog.zsh"; do
  if grep -q "'capacity:" "$file"; then pass; else fail "$(basename "$file") lists the capacity verb"; fi
done

if (( FAIL > 0 )); then
  echo "FAIL: $FAIL test(s) failed; $PASS passed" >&2
  exit 1
fi
echo "PASS: $PASS test(s) passed"
