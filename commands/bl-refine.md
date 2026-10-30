# Refine Story

Refine one or more backlog stories to make them ready for autonomous
implementation.

**Usage:** `/bl-refine <id...>`

## Arguments

| Arg       | Required | Description                                                             |
| --------- | -------- | ----------------------------------------------------------------------- |
| `<id...>` | Yes      | One or more story IDs (S34, S-34, s34) and/or component IDs (C01, c-1). |

A component ID expands to every story in the component whose status is `backlog`. A
story named directly is always refined (only `done`/`superseded` are skipped),
even if it is already `refined` (it is re-refined). IDs are deduped.

## Single vs. batch

- **One resolved story** — one interactive agent session refines it in place.
- **Multiple resolved stories** — one orchestrator session is launched that
  delegates each story to its own sub-agent (Task tool) and refines them in
  parallel, then prints a summary. `--prompt` is single-story only.

## Steps

1. Parse `$ARGUMENTS` for the story ID.

2. Locate the story by reading `backlog.json` (key: `backlog`) to find the backlog directory, then search for the story directory within it. Story IDs follow the pattern `S-{number}` — normalize the input (e.g. `s34` → `S34`, look for directories starting with `S34-`).

3. Read the detailed refinement instructions from the prompt template:

   ```
   <bl checkout>/prompts/refine.md
   ```

   Replace the `{{placeholders}}` with actual values:
   - `{{storyId}}` — normalized story ID (e.g. `S-34`)
   - `{{title}}` — from the story's frontmatter `title` field
   - `{{worktreePath}}` — the current working directory
   - `{{branchName}}` — current git branch (`git rev-parse --abbrev-ref HEAD`)
   - `{{storyRelPath}}` — relative path to the story's `index.md` from the repo root
   - `{{componentId}}` — the story's component (e.g. `C01`)

4. Follow the instructions from the prompt template exactly.

## Important

- Do NOT implement the story — only refine and plan
- Do NOT change the story status to `in_progress`
- Do NOT hand-edit backlog index files. Before finishing, run `bl validate` until it is clean
  on the stories you touched, then commit with
  `bl sync --commit -m "chore: refine S-XXX" --story S-XXX` (plus a `--story` per child story)
- You may use `/bl-new` to create child stories if the story should be split
- You may edit related stories only if they are not currently being worked on (no `.workon.lock` in their worktree)
