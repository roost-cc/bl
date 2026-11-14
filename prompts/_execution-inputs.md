## Execution plan inputs

`bl run` computes an execution plan from the stories: their dependencies, the work order and
the groups of stories that can run in parallel. These rules feed it:

- List every file the story changes in its Implementation Plan, each path in backticks
  (`src/x.js`). `bl run` does not see a path that is not in backticks. A path that the story
  reads and does not change goes under `### Sources of truth`.
- Record each logical dependency between stories as an order or run edge, never as a file
  overlap. `bl run` finds file overlap itself.
- During a run, the plan wins. If the plan proves wrong, change it in `plan.yaml` (beside the
  change document, in the directory of the work unit's `index.md`) and add a `changes` entry
  that says why. Then do the extra work to resolve
  the conflicts. A correct plan is good; working code is a must.
