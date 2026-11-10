This story has already been refined. The operator is calling `bl refine` again
to update the implementation plan or the acceptance criteria.

You are working on story {{storyId}} — "{{title}}".

Component : {{componentId}}
Primary repo : {{primaryRepo}} ({{primaryRepoPath}})
Story file : {{storyRelPath}}
Workspace : {{roostDir}}
Backlog repo : {{backlogDir}}

## Steps

1. {{readTool}} the story file directly at `{{storyRelPath}}`. Do not search for it.

2. Explore the code in `{{primaryRepoPath}}`. Find out the current state, and why the operator
   asks for a new refinement. Also find where the system already defines each concept that the
   story touches (see **Self-consistent designs** below).

3. From what you found, update the implementation plan, the acceptance criteria or the design
   notes in the story file:
   - Write each plan step as
     `<step> → verify: <check>`, where the check is the test, command or
     observation that shows the step worked.
   - Put each file path in the plan in backticks (`src/x.js`). When several targets run at once,
     `bl run` reads the backticked paths to hold back a target that touches the same file as
     another. `bl run` does not see a path that is not in backticks.
   - Give the plan a `### Sources of truth` part: for each concept the story touches, where it is
     defined and how the code reaches it. The story reads these paths and does not change them,
     so `bl run` does not hold a target back for them.
   - Name the behaviour the story shares with existing code, and whether it gets a shared
     abstraction (see **Simple, surgical changes** below).

4. If the story is too large, use `bl new` to split it into smaller stories.

5. Update the frontmatter to link the story to each other story that it depends on or that
   should be required for it.
   Set `effort:` by **Effort level** below, and write the `**Effort:** <level>: <reason>` line as
   the first line of the Implementation Plan (replace the line if it is there).

6. Format each file you changed with the formatter for its extension. The **Format and lint**
   section below gives the exact command. Use **relative paths** from cwd.

7. Commit your re-refinement by following **Backlog commits** below. When this session ends,
   `bl` commits and pushes what you left uncommitted with `chore: re-refine {{storyId}}`, but your
   own commit says why. Use the message `chore: re-refine {{storyId}}`, and put why the plan changed
   in its body. Pass `--story {{storyId}}`, plus one `--story` for each child story you created
   with `bl new`. The backlog workflow commits to its `main` branch directly; do NOT branch
   first.

8. If this is a top-level refine (you work with the operator directly, not as a sub-agent of a
   batch refine), walk the operator through the story. Give one item at a time, and wait after
   each:

   1. A short summary of the story's intended outcome.
   2. For each acceptance criterion, in order: what it checks and how it shows the outcome is met.
   3. If you split the story into child stories, each child story: a short summary of what it
      does and how it moves the story toward the outcome.

   The operator may ask questions or ask for changes. Make each approved change in the backlog and
   commit it as in step 7. Move to the next item only when the operator says so.

9. Write the outcome as the last act of the session, after the walkthrough (see **Outcome**
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
