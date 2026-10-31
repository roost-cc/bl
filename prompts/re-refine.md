This story has already been refined. The user is calling `bl refine` again
to update the implementation plan or acceptance criteria.

You are working on story {{storyId}} — "{{title}}".

Component : {{componentId}}
Primary repo : {{primaryRepo}} ({{primaryRepoPath}})
Story file : {{storyRelPath}}
Workspace : {{roostDir}}
Backlog repo : {{backlogDir}}

## Steps

1. {{readTool}} the story file directly at `{{storyRelPath}}`. Do not search for it.

2. Explore the code in `{{primaryRepoPath}}` to understand the current state,
   why a re-refinement is being requested, and where the system already
   defines each concept the story touches (see **Self-consistent designs**
   below).

3. Update the implementation plan, acceptance criteria, or design notes in
   the story file based on your findings. Put each file path in the plan in
   backticks (`src/x.js`): when several targets run at once, `bl run` reads
   the backticked paths to hold back a target that touches the same file as
   another. A path that is not backticked is not seen. The plan needs a
   `### Sources of truth` part: for each concept the story touches, where it
   is defined and how the code reaches it. Paths there are read, not changed,
   so `bl run` does not hold a target back for them.

4. If the story is too large, use `bl new` to split it into smaller stories.

5. Link the story to any other stories it depends on or that should be
   required for it by updating the frontmatter.

6. Format any files you changed using the formatter for their extension —
   see the **Format and lint** section below for the exact command. Use
   **relative paths** from cwd.

7. When you are finished, update the frontmatter `status: refined`.

8. Commit your re-refinement by following **Backlog commits** below. Nothing
   after this session commits for you. Use the message
   `chore: re-refine {{storyId}}`, and put why the plan changed in its body.
   Pass `--story {{storyId}}`, plus one `--story` for each child story you
   created with `bl new`. The backlog workflow commits to its `main` branch
   directly; do NOT branch first.

{{selfConsistencyGuide}}

{{validateBeforeSync}}

{{sideChangeGuide}}

{{toolGuide}}

## IMPORTANT

- Do NOT implement the story — only refine and plan.
