Your goal is to make this story ready for implementation by an autonomous
agent.

You are refining story {{storyId}} — "{{title}}".

Component : {{componentId}}
Primary repo : {{primaryRepo}} ({{primaryRepoPath}})
Story file : {{storyRelPath}}
Workspace : {{roostDir}}
Backlog repo : {{backlogDir}}

## Steps

1. {{readTool}} the story file directly at `{{storyRelPath}}` (relative to cwd =
   backlog root). Do not search for it.

2. Explore the codebase in `{{primaryRepoPath}}` to understand the scope and
   requirements.

3. Fill in the **## Summary**, **## Acceptance Criteria**, and
   **## Implementation Plan** sections in the story file.

4. The **## Implementation Plan** must be concrete and actionable. It should
   include:
   - Specific files or components to modify, each path in backticks
     (`src/x.js`): when several targets run at once, `bl run` reads the
     backticked paths to hold back a target that touches the same file as
     another. A path that is not backticked is not seen.
   - New tests to add
   - Edge cases to handle
   - Any architectural changes required

5. Update the story frontmatter:
   - Check `component:` names the code boundary of the main work. The story's repo is that
     component's repo; if the main work is in another repo, set `component:` to a component of
     that repo (its home component when no other fits). A story names no repo of its own
   - Set `type:` (feature, bug, or chore)
   - Estimate `points:` (1, 2, 3, 5, 8, or 13)
   - Add `depends_on:` story IDs if this work requires other stories first

6. If the story is too large, use `bl new` to create child stories and
   distribute the work.

7. A story works in one repo. When the work also needs a change in another
   repo, that change is another story in a component of that repo
   (`bl new <C-id>`), linked by `depends_on` (one story per repo). You may
   read other repos to plan it.

8. Format any files you changed using the formatter for their extension —
   see the **Format and lint** section below for the exact command. Use
   **relative paths** from cwd.

9. When you are finished, update the frontmatter `status: refined`.

10. Commit your refinement by following **Backlog commits** below. Nothing after
    this session commits for you. Use the message `chore: refine {{storyId}}`,
    and put any why/how worth keeping in its body. Pass `--story {{storyId}}`,
    plus one `--story` for each child story you created with `bl new`. The
    backlog workflow commits to its `main` branch directly; do NOT branch
    first.

{{validateBeforeSync}}

{{sideChangeGuide}}

{{toolGuide}}

## IMPORTANT

- Do NOT implement the story — only refine and plan.
