#!/usr/bin/env bash
# Bash completions for the bl (backlog) CLI.
# Source this file or add to ~/.bashrc:
#   source /path/to/bl/completions/backlog.bash

_roost_repo_root() {
  git rev-parse --show-toplevel 2>/dev/null
}

# Resolve the backlog directory from backlog.json (defaults to "backlog")
_roost_backlog_dir() {
  local root="$1"
  [[ -z "$root" ]] && return
  local rel
  if [[ -f "$root/backlog.json" ]]; then
    rel="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/backlog.json','utf8')).backlog??'backlog')" 2>/dev/null)"
  fi
  echo "$root/${rel:-backlog}"
}

# Collect story IDs (S-01, S-02, ...) from directory names
_roost_story_ids() {
  local root bldir
  root="$(_roost_repo_root)"
  bldir="$(_roost_backlog_dir "$root")"
  [[ -d "$bldir" ]] || return
  find "$bldir" -maxdepth 3 -type d -name 'S*' 2>/dev/null \
    | sed -nE 's|^.*/S([0-9]+)-[^/]+$|S-\1|p' \
    | sort -t- -k2 -n \
    | uniq
}

# Collect story IDs from active worktrees (for merge)
_roost_worktree_story_ids() {
  local root
  root="$(_roost_repo_root)"
  [[ -z "$root" ]] && return
  git -C "$root" worktree list --porcelain 2>/dev/null \
    | sed -nE 's|^branch refs/heads/s([0-9]+)-.+$|S-\1|p' \
    | sort -t- -k2 -n
}

# Collect component IDs (C00, C01, ...) from components/ directory names
_roost_component_ids() {
  local root bldir
  root="$(_roost_repo_root)"
  bldir="$(_roost_backlog_dir "$root")"
  [[ -d "$bldir/components" ]] || return
  find "$bldir/components" -maxdepth 1 -type d -name 'C*' 2>/dev/null \
    | sed -nE 's|^.*/C([0-9]+)-[^/]+$|C\1|p' \
    | sort
}

# Collect feature IDs (F-1, F-2, ...) from features/ directory names
_roost_feature_ids() {
  local root bldir
  root="$(_roost_repo_root)"
  bldir="$(_roost_backlog_dir "$root")"
  [[ -d "$bldir/features" ]] || return
  find "$bldir/features" -maxdepth 1 -type d -name 'F*' 2>/dev/null \
    | sed -nE 's|^.*/F([0-9]+)-[^/]+$|F-\1|p' \
    | sort -t- -k2 -n
}

# Collect theme ids (slugs) from themes/ directory names
_roost_theme_ids() {
  local root bldir
  root="$(_roost_repo_root)"
  bldir="$(_roost_backlog_dir "$root")"
  [[ -d "$bldir/themes" ]] || return
  find "$bldir/themes" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
    | sed -nE 's|^.*/([a-z][a-z0-9-]*)$|\1|p' \
    | sort
}

# Collect epic ids (E50, E51, ...) from epics/ directory names
_roost_epic_ids() {
  local root bldir
  root="$(_roost_repo_root)"
  bldir="$(_roost_backlog_dir "$root")"
  [[ -d "$bldir/epics" ]] || return
  find "$bldir/epics" -maxdepth 1 -type d -name 'E*' 2>/dev/null \
    | sed -nE 's|^.*/E([0-9]+)-[^/]+$|E\1|p' \
    | sort -k1.2 -n
}

# Complete the value of a value-axis filter flag (--theme, --epic, --feature,
# --component); returns 1 when $prev is none of them.
_roost_filter_value() {
  local prev="$1" cur="$2"
  case "$prev" in
    --theme) COMPREPLY=( $(compgen -W "$(_roost_theme_ids)" -- "$cur") ) ;;
    --epic) COMPREPLY=( $(compgen -W "$(_roost_epic_ids)" -- "$cur") ) ;;
    --feature) COMPREPLY=( $(compgen -W "$(_roost_feature_ids)" -- "$cur") ) ;;
    --component) COMPREPLY=( $(compgen -W "$(_roost_component_ids)" -- "$cur") ) ;;
    *) return 1 ;;
  esac
}

# Collect the open task ids (T-7, ...) bl inbox lists
_roost_inbox_task_ids() {
  bl inbox --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{for(const e of JSON.parse(s||"[]"))if(e.kind==="task")console.log(e.id)})' 2>/dev/null
}

# ── bl ───────────────────────────────────────────────────────────────────

_roost_bl() {
  local cur prev subcmd
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  # First arg: subcommand
  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "init new side attach move next-id run implement approve status refine review pr edit view show which grep list ls tree history report next what-next done inbox block task sync s merge log allow agents capacity help" -- "$cur") )
    return
  fi

  subcmd="${COMP_WORDS[1]}"

  case "$subcmd" in
    implement|run)
      COMPREPLY=( $(compgen -W "$(_roost_story_ids) $(_roost_feature_ids)" -- "$cur") )
      ;;
    status)
      COMPREPLY=( $(compgen -W "$(_roost_story_ids) $(_roost_feature_ids) $(_roost_component_ids)" -- "$cur") )
      ;;
    approve)
      COMPREPLY=( $(compgen -W "$(_roost_feature_ids)" -- "$cur") )
      ;;
    refine)
      COMPREPLY=( $(compgen -W "$(_roost_story_ids)" -- "$cur") )
      ;;
    edit)
      COMPREPLY=( $(compgen -W "$(_roost_story_ids)" -- "$cur") )
      ;;
    view)
      COMPREPLY=( $(compgen -W "$(_roost_story_ids)" -- "$cur") )
      ;;
    review|pr)
      COMPREPLY=( $(compgen -W "$(_roost_worktree_story_ids)" -- "$cur") )
      ;;
    merge)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--keep" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "$(_roost_worktree_story_ids) $(_roost_feature_ids)" -- "$cur") )
      fi
      ;;
    sync|s)
      if [[ "$prev" == "--story" ]]; then
        COMPREPLY=( $(compgen -W "$(_roost_story_ids)" -- "$cur") )
      elif [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--commit -m --message --story" -- "$cur") )
      fi
      ;;
    task)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--title --gate --body-file --json --open" -- "$cur") )
      elif [[ ${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "done list $(_roost_feature_ids) $(_roost_story_ids)" -- "$cur") )
      elif [[ "$prev" == "--gate" ]]; then
        COMPREPLY=( $(compgen -W "merge next none" -- "$cur") )
      elif [[ "${COMP_WORDS[2]}" == "list" ]]; then
        COMPREPLY=( $(compgen -W "$(_roost_feature_ids) $(_roost_story_ids)" -- "$cur") )
      elif [[ "${COMP_WORDS[2]}" == "done" && ${COMP_CWORD} -eq 3 ]]; then
        COMPREPLY=( $(compgen -W "$(_roost_inbox_task_ids)" -- "$cur") )
      fi
      ;;
    capacity)
      COMPREPLY=( $(compgen -W "--json --help" -- "$cur") )
      ;;
    inbox)
      if [[ ${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "done --json" -- "$cur") )
      elif [[ "${COMP_WORDS[2]}" == "done" && ${COMP_CWORD} -eq 3 ]]; then
        COMPREPLY=( $(compgen -W "$(_roost_inbox_task_ids)" -- "$cur") )
      fi
      ;;
    done)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--superseded" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "$(_roost_story_ids) $(_roost_component_ids)" -- "$cur") )
      fi
      ;;
    list|ls)
      _roost_filter_value "$prev" "$cur" && return
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--all --features --theme --epic --feature --component" -- "$cur") )
      fi
      ;;
    tree)
      _roost_filter_value "$prev" "$cur" && return
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--all --theme --epic --feature --component" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "$(_roost_story_ids)" -- "$cur") )
      fi
      ;;
    history)
      if [[ "$prev" == --scope ]]; then
        COMPREPLY=( $(compgen -W "$(_roost_theme_ids) $(_roost_epic_ids) $(_roost_feature_ids) $(_roost_component_ids)" -- "$cur") )
        return
      fi
      COMPREPLY=( $(compgen -W "--json --since --scope" -- "$cur") )
      ;;
    report)
      if [[ "$prev" == --out ]]; then
        COMPREPLY=( $(compgen -d -- "$cur") )
        return
      fi
      if [[ "$prev" == --charts ]]; then
        COMPREPLY=( $(compgen -W "vega-lite" -- "$cur") )
        return
      fi
      COMPREPLY=( $(compgen -W "--out --since --charts --json" -- "$cur") )
      ;;
    what-next)
      _roost_filter_value "$prev" "$cur" && return
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--theme --epic --feature --component" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "$(_roost_story_ids) $(_roost_component_ids)" -- "$cur") )
      fi
      ;;
    next)
      _roost_filter_value "$prev" "$cur" && return
      COMPREPLY=( $(compgen -W "--theme --epic" -- "$cur") )
      ;;
    side)
      case "$prev" in
        --from)
          COMPREPLY=( $(compgen -W "$(_roost_feature_ids) $(_roost_story_ids)" -- "$cur") )
          return
          ;;
        --type)
          COMPREPLY=( $(compgen -W "chore bug feature" -- "$cur") )
          return
          ;;
        --points)
          COMPREPLY=( $(compgen -W "1 2 3 5 8 13" -- "$cur") )
          return
          ;;
        --title)
          return
          ;;
        --body-file)
          COMPREPLY=( $(compgen -f -- "$cur") )
          return
          ;;
      esac
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--from --title --points --type --body-file --json" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "$(_roost_component_ids)" -- "$cur") )
      fi
      ;;
    attach)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--no-sync --json --help" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "$(_roost_story_ids) $(_roost_feature_ids)" -- "$cur") )
      fi
      ;;
    move)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--no-sync --json --help" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "$(_roost_story_ids) $(_roost_component_ids)" -- "$cur") )
      fi
      ;;
    new)
      case "$prev" in
        --component)
          COMPREPLY=( $(compgen -W "$(_roost_component_ids)" -- "$cur") )
          return
          ;;
        --type)
          COMPREPLY=( $(compgen -W "feature bug chore" -- "$cur") )
          return
          ;;
        --points)
          COMPREPLY=( $(compgen -W "1 2 3 5 8 13" -- "$cur") )
          return
          ;;
        --title|--repo|--theme)
          return
          ;;
        --depends-on|--required-for)
          return
          ;;
      esac
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--component --repo --home --title --points --type --depends-on --required-for --theme --epic --json" -- "$cur") )
      fi
      ;;
    next-id)
      case "$prev" in
        --count)
          return
          ;;
      esac
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--count --help" -- "$cur") )
      else
        # First positional: kind
        local pos=0
        local i
        for ((i=2; i<COMP_CWORD; i++)); do
          [[ "${COMP_WORDS[i]}" != -* ]] && [[ "${COMP_WORDS[i-1]}" != "--count" ]] && pos=$((pos+1))
        done
        if (( pos == 0 )); then
          COMPREPLY=( $(compgen -W "story component epic" -- "$cur") )
        fi
      fi
      ;;
  esac
}

# ── Register completions ─────────────────────────────────────────────────

complete -F _roost_bl bl
