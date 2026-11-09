# bl

`bl` is a file-based backlog CLI. Themes, epics, features, components and stories are markdown
files with YAML frontmatter in one shared git repository, the **backlog**, kept beside the code
repositories it plans work for. `bl` creates and indexes them, checks them, and drives agent
sessions (Claude Code, Codex, Gemini, and `local`: Claude Code against a local model server) that
refine, implement, review and merge the work, each in its own git worktree.

## Install

`bl` needs Node.js 26 or later and git. It is not published to npm: install it from a clone.

```sh
git clone https://github.com/roost-cc/bl.git ~/src/bl
npm --prefix ~/src/bl ci
export PATH="$HOME/src/bl/bin:$PATH"
bl --help
```

Shell completions are in `completions/` (`_bl` for zsh, `backlog.bash` for bash).

## The layout

A workspace is one directory holding the backlog and the code repositories:

```
acme/
  backlog/          the backlog repo: backlog.json, stories/, components/, features/, themes/ …
  acme-web/         a code repo, registered in backlog.json "repos"
  worktrees/        where bl puts each unit's worktrees (backlog.json "worktrees")
```

`bl` finds the backlog by walking up from the current directory, checking each ancestor and
its `backlog/` child for a `backlog.json`. Set `BL_BACKLOG_DIR` to the backlog directory to use
it from anywhere else.

## `backlog.json`

The backlog's configuration. A minimal one:

```json
{
  "title": "Acme Backlog",
  "worktrees": "../worktrees",
  "agent": [{ "agent": "claude" }],
  "review_agent": [{ "agent": "codex" }],
  "effort": { "refine": "high", "review": "high", "default": "high" },
  "repos": {
    "acme-web": { "path": "../acme-web", "deployable": true, "update_tests": [] }
  }
}
```

- `title` names the backlog in the `index.md` that `bl sync` writes (default `Backlog`).
- `repos` registers each code repo, with its path relative to the backlog.
- `agent` and `review_agent` are the agent configurations, in order of preference, for
  implementing and for reviewing.
- `effort` is the effort level (`low`, `medium`, `high`, `xhigh` or `max`) of refine sessions,
  of review sessions, and of a story that sets no `effort:` of its own.
- `plugins`, `language_dispatch` and `forge` wire in formatters, linters, test commands and the
  forge (GitHub through `gh`, for example).
- `session_stack` (optional) points at your own guidance for a per-session stack of services,
  if your tests need one.

`bl agents` prints the full reference.

### Tab titles

While `bl` runs a session or a loop, it names the terminal tab after the work: the tmux window
under tmux, the terminal's window title elsewhere. The title is rendered from the fields each
code path sets (`feature`, `story`, `status`), with the format in `BL_TAB_TITLE`:

```sh
export BL_TAB_TITLE='{{feature}} : {{story}} : {{status}}'   # the default
export BL_TAB_TITLE='{{story}} {{status}}'                   # shorter
export BL_TAB_TITLE=''                                       # titles off
```

A field that is not set renders as nothing: `: S-210 : implement` for a story with no
feature, `F-123 :  : refine` for a feature. When `bl` exits it gives the title back to the
terminal (tmux's automatic rename, or the title the terminal had before), so no tab keeps a
title for work that is over; a run's end rings the bell.

`bl` sets `BL_TAB_TITLE=''` for every agent session and for the child processes that `bl run`
and `bl review` start in parallel for several targets.

## Quickstart

```sh
mkdir -p ~/acme/backlog && cd ~/acme/backlog
git init -b main
echo '{ "title": "Acme Backlog" }' > backlog.json
bl init                                   # agent settings, allowed-tools.json, flow.json,
                                          # roadmap.md, priority.md
# register the code repo in backlog.json:
#   "repos": { "acme-web": { "path": "../acme-web", "deployable": true, "update_tests": [] } }
git add -A && git commit -m "chore: new backlog"

bl new --theme web --title "Web app" --brief acme-web/README.md
bl new --component --repo acme-web --title "Web app" --home
bl new C00 --title "Sign-in page" --points 3
bl list
bl sync
bl validate
```

From there: `bl refine S-1` makes a story ready, `bl run S-1` implements it on its own branch
and opens a pull request, and `bl merge S-1` merges it. Features group stories that ship
together (`bl new --feature`, `bl approve`, `bl run F-1`). `priority.md` is your one ranked
list of features and loose stories: `bl rank F-1 --top --why "<reason>"` edits it, `bl next`
prints the most important unit whose dependencies are met, and nothing automated ever writes it.

## Tests

```sh
npm test
```

## License

ISC. See `LICENSE.md`.
