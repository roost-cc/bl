Your goal is to make this story ready for an autonomous agent to implement.

You are refining story {{storyId}} — "{{title}}".

Component : {{componentId}}
Primary repo : {{primaryRepo}} ({{primaryRepoPath}})
Story file : {{storyRelPath}}
Workspace : {{roostDir}}
Backlog repo : {{backlogDir}}

## Steps

1. {{readTool}} the story file directly at `{{storyRelPath}}` (relative to cwd =
   backlog root). Do not search for it.

2. Explore the codebase in `{{primaryRepoPath}}` to understand the scope and the requirements.
   Also find where the system already defines each concept that the story touches (see
   **Self-consistent designs** below).

3. Fill in the **## Summary**, **## Acceptance Criteria** and **## Implementation Plan** sections
   in the story file.

4. Make the **## Implementation Plan** concrete and actionable. Write each
   step as `<step> → verify: <check>`, where the check is the test, command or
   observation that shows the step worked. The plan should include:
   - The specific files or components to change, each path in backticks (`src/x.js`). When
     several targets run at once, `bl run` reads the backticked paths to hold back a target that
     touches the same file as another. `bl run` does not see a path that is not in backticks.
   - The new tests to add.
   - The edge cases to handle.
   - Any architectural changes that the story needs.
   - The behaviour the story shares with existing code, and whether it gets a
     shared abstraction (see **Simple, surgical changes** below).
   - A `### Sources of truth` part: for each concept the story touches, where it is defined and
     how the code reaches it. The story reads these paths and does not change them, so `bl run`
     does not hold a target back for them.

5. Update the story frontmatter:
   - Check that `component:` names the code boundary of the main work. The story's repo is that
     component's repo. If the main work is in another repo, set `component:` to a component of
     that repo (its home component when no other fits). A story names no repo of its own.
   - Set `type:` (feature, bug, or chore).
   - Estimate `points:` (1, 2, 3, 5, 8, or 13).
   - Add `depends_on:` story IDs if this work needs other stories first.
   - Set `effort:` by **Effort level** below, and write the `**Effort:** <level>: <reason>` line
     as the first line of the Implementation Plan.

6. If the story is too large, use `bl new` to create child stories, and divide the work among
   them.

7. A story works in one repo. The work may also need a change in another repo.
   That change is another story in a component of that repo (`bl new <C-id>`), linked by `depends_on`
   (one story per repo). You may read other repos to plan it.

8. Format each file you changed with the formatter for its extension. The **Format and lint**
   section below gives the exact command. Use **relative paths** from cwd.

9. Commit your refinement by following **Backlog commits** below. When this session ends, `bl`
   commits and pushes what you left uncommitted with `chore: refine {{storyId}}`, but your own
   commit says why. Use the message `chore: refine {{storyId}}`, and put any why or how worth
   keeping in its body. Pass `--story {{storyId}}`, plus one `--story` for each child story you
   created with `bl new`. The backlog workflow commits to its `main` branch directly; do NOT
   branch first.

10. If this is a top-level refine (you work with the operator directly, not as a sub-agent of a
    batch refine), walk the operator through the story. Give one item at a time, and wait after
    each:

    1. A short summary of the story's intended outcome.
    2. For each acceptance criterion, in order: what it checks and how it shows the outcome is met.
    3. If you split the story into child stories, each child story: a short summary of what it
       does and how it moves the story toward the outcome.

    The operator may ask questions or ask for changes. Make each approved change in the backlog and
    commit it as in step 9. Move to the next item only when the operator says so.

11. Write the outcome as the last act of the session, after the walkthrough (see **Outcome**
    below).

{{selfConsistencyGuide}}

{{simplicityGuide}}

{{effortGuide}}

{{validateBeforeSync}}

{{sideChangeGuide}}

{{collaborationGuide}}

{{writingGuide}}

{{toolGuide}}

## IMPORTANT

- Do NOT implement the story — only refine and plan.

{{refineOutcome}}
