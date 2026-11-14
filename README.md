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
- `local` (optional) is the local server, today llama-server, that the `local` agent runs
  Claude Code against: `{ "url", "token" }`, two non-empty strings, no defaults. bl needs it
  only when a configuration names `local`. bl reads it from the top level only; a repo's
  `overrides` may not set it.
- `effort` is the effort level (`low`, `medium`, `high`, `xhigh` or `max`) of refine sessions,
  of review sessions, and of a story that sets no `effort:` of its own.
- `plugins`, `language_dispatch` and `forge` wire in formatters, linters, test commands and the
  forge (GitHub through `gh`, for example).
- `session_stack` (optional) points at your own guidance for a per-session stack of services,
  if your tests need one.

`bl agents` prints the full reference.

### Tab titles

Every `bl` command names the terminal tab, from start to exit: the tmux window under tmux, the
terminal's window title elsewhere. The title is rendered from the fields each code path sets
(`feature`, `story`, `status`, and `next`, the step that the operator does next), with the
format in `BL_TAB_TITLE`:

```sh
export BL_TAB_TITLE='{{feature}} : {{story}} : {{status}} {{next}}'   # the default
export BL_TAB_TITLE='{{story}} {{status}}'                            # shorter, no next step
export BL_TAB_TITLE=''                                                # titles off
```

A field that is not set renders as nothing, and the title is trimmed: `: S-210 : implement`
for a story with no feature, `F-123 :  : refine` for a feature.

Before it does anything else, `bl` sets a start title: the status is the command (`merge`,
`list` also for `bl ls`), with its subcommand for `task`, `updates`, `inbox` and `block`
(`updates run`, `inbox done`), or `help` for `bl`, `bl help` and any `--help`. The feature and
story fields are the unit ids the arguments name (`bl run s34` shows `: S-34 : run`), and
several ids of one kind show as `2 features` or `3 stories`. A command that knows more, such as
`bl run` or `bl refine`, then sets its own status. `bl merge` shows its steps: `integrate`,
`test gate`, `pre-push gate + push` (git runs the pre-push gate inside `git push`), `cleanup`,
`sync` and `tag`. A fast command such as `bl list` ends at once with `ended`.

When `bl` exits, the last title stays on the tab until the next `bl` in that window or you
replace it. A command that reaches an end state shows it with the next step, for example
`F-56 :  : clean → bl merge`, `F-56 :  : escalated → fix, --resume` or
`updates :  : 1 decision → approve/drop`. The end state stays even when `bl` then exits
non-zero, for example after an escalation. Any other exit sets the status from the exit code:
`ended` for 0, `interrupted` for Ctrl-C or SIGTERM, `failed (exit N)` otherwise. Under tmux,
`bl` leaves the window's automatic rename off; `tmux set -w automatic-rename on` gives tmux's
own name back.

`bl` sets `BL_TAB_TITLE=''` for every agent session, for the child processes that
`bl review` starts in parallel for several targets, and for every `bl` it starts for data:
the `bl sync` of a merge, the `bl new` of `bl side`, and the view of `bl top`. The shell
completions run `bl inbox --json` with it too. So only the `bl` you started renames the tab.

## Quickstart

```sh
mkdir -p ~/acme/backlog && cd ~/acme/backlog
git init -b main
echo '{ "title": "Acme Backlog" }' > backlog.json
bl init                                   # agent settings, allowed-tools.json, flow.json,
                                          # roadmap.md, priority.yaml
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
together (`bl new --feature`, `bl approve`, `bl run F-1`). `priority.yaml` is your one ranked
list of features and loose stories: `bl rank F-1 --top` stages an edit, `bl rank --commit`
commits the staged edits, `bl next`
prints the most important unit whose dependencies are met, and nothing automated ever writes it.

## Tests

```sh
npm test
```

## License

ISC. See `LICENSE.md`.
