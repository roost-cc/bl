## Tools

### File and search operations

{{toolUsageHint}}

### Working directories

{{workingDirectory}}

### Shell

Headless sessions cannot answer a permission prompt, so a command outside the
allowlist is simply denied. Most denials come from a handful of habits:

- **zsh `noclobber` is on.** `>` refuses to overwrite an existing file ("file
  exists"). Overwrite with `>|`, append with `>>`; `setopt | grep -i clobber`
  shows the setting.
- **Write files with the {{writeTool}} tool, not heredocs.** `cat > f <<'EOF'`
  trips noclobber on an existing file and is often denied as a compound
  command; the write tool is always permitted.
- **Compare versions with git, not copies.** `git diff <sha> -- <path>` or
  `git show <sha>:<path>` instead of `cp <file> /tmp/…` and diffing the copies.

Every part of a compound command must be allowlisted on its own, and a hook
denies these shapes with a message naming the fix:

| Denied                                                              | Use instead                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `cd <path> && <cmd>`                                                | a path argument: `git -C <path>`, `pnpm --dir <path>`, `rg … <path>`            |
| `VAR=val cmd`                                                       | `env VAR=val cmd`                                                               |
| loops, `W=…; … $W`, `$(…)`, backticks                               | a script in your scratch dir, run with `node <f>.mjs` / `python3 <f>.py`        |
| `git -C <backlog> commit` without `-- <paths>`, or with `-a` / `-i` | `bl sync --commit -m "<msg>" --story <id> [--path <p>]`                         |

A literal `$(` or backtick goes in single quotes; a commit message goes in a
file (`git commit -F <file>`).

{{sessionStackTools}}

### Story-explicit invocation (REQUIRED)

You are working on `{{storyId}}`. **Every `bl` subcommand that operates on
story scope must be invoked with `--story {{storyId}}`** — `bl format`,
`bl lint`, `bl merge`, `bl review`, and any future story-aware tool.
Do not rely on a "current worktree" default; there isn't one. The story
ID lets `bl` find every repo the work spans (its stories' repos:
{{storyRepos}}) and operate on all of them, not just the worktree your
shell happens to be in. Skipping `--story` will error.

### Format and lint

{{formatExamples}}
{{lintExamples}}
Always invoke as `bl format --story {{storyId}}` /
`bl lint --story {{storyId}}` so the story's backlog markdown is covered.
Files edited via your agent's {{editTool}}/{{writeTool}} tools may be
auto-formatted if an edit hook is configured for that agent; files written
via Bash need an explicit format pass regardless.

### Tests

{{testExamples}}
When the table above lists a test runner for the file extensions you
touched, invoke it directly. When the section reports nothing configured,
the project doesn't have a registered test runner for `bl` — fall back to
the project's documented test command.

### Pull requests

{{prOps}}

### Available on PATH

{{toolsOnPath}}

{{ideHints}}
