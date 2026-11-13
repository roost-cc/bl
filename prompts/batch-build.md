You are making the cross-story pass of story batch {{batchId}} — "{{title}}". `bl batch` built
the batch from the stories below and wrote it approved. Each story was refined on its own, so no
agent has looked at the dependencies between them. You look at them together, once, before
`bl run {{batchId}}` computes the execution plan from them.

Batch file   : {{batchAbsPath}}
Backlog repo : {{backlogDir}} (your working directory)

Stories in this batch:
{{storiesPlan}}

## Steps

1. {{readTool}} each story file: its Summary, Acceptance Criteria and Implementation Plan. Read
   the code the plans name where you need it to see what a story changes.
2. Make sure each story lists its files by the planning rules below (**Execution plan
   inputs**). Where a plan does not, correct its Implementation Plan.
3. Find each logical dependency between two of the stories: one story needs what another one
   builds (a function, a schema, a key, a contract between repos). For each one, add an order
   edge, the dependency first:

   ```
   bl block add <S-first> --gate order --unit <S-then> --until implemented
   ```

   `bl block add` checks the edge and commits `blockers.json` itself.

4. Validate the stories you changed with `bl validate`, and correct what it reports on them.

## What you may change

You may change exactly two things:

- the `## Implementation Plan` sections of the stories in this batch;
- order edges between two stories of this batch, added with `bl block add`.

Change nothing else: no other section, no frontmatter, no other story, not the batch file, and
no code. Do not run `git add` or `git commit` in the backlog repo: `bl batch` commits the
stories, the batch and `blockers.json` when you end. If a story cannot be planned without a
change outside these limits, say so in your final message; do not make it.

{{executionInputs}}

{{writingGuide}}

{{toolGuide}}

## Outcome

End with one short paragraph as your final message: the plans you corrected and the edges you
added, or that none were needed.
