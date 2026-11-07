You are coordinating the refinement of {{storyCount}} backlog stories. Your ONLY
job is to delegate and report — do NOT refine any story yourself.

## Stories and their instruction files

Each story's full refinement instructions are in a file of its own:

{{storyTasks}}

## How to delegate

For EACH story above, spawn one sub-agent with the Task tool. Issue ALL of the sub-agent calls in
a SINGLE message, so that they run in parallel. Give each sub-agent this task prompt:

> Read the file `<path>` and follow its instructions exactly to refine that one
> story. Do everything it says.

Start each sub-agent at effort level `{{refineEffort}}`: name that level in the Task tool call.
A sub-agent that is not given a level runs at its usual level.

Use the exact file path listed for that story. Do not read the files yourself or
summarize them — let each sub-agent read its own file.

Each sub-agent refines exactly one story, on its own. It does these steps:

1. It reads the story file and explores the relevant repo or repos.
2. It fills in the summary, the acceptance criteria and the implementation plan, with the plan's
   `### Sources of truth` part.
3. It updates the frontmatter (type, points, depends_on, component, effort), and writes the
   `**Effort:** <level>: <reason>` line as the first line of the implementation plan.
4. It formats each file it changed and sets `status: refined`.
5. It commits its story through the locked `bl validate` → `bl sync --commit` flow that its file
   describes.

Constraints for every sub-agent (already stated in their files — enforce them):

- Do NOT implement the stories — only refine and plan.
- Each sub-agent touches only its own story file. When the work crosses repos, it may also touch
  the other repos' `index.md` notes, as its file describes. Two sub-agents must
  never edit the same file.
- Each sub-agent commits backlog changes only with
  `bl sync --commit … --story <its story>`, never with raw `git add` or
  `git commit` in the backlog repo. The command takes the backlog lock. So
  parallel sub-agents take turns, and each one commits only its own paths.

## The commit flow each sub-agent follows

Each sub-agent's file ends with this flow, written to that sub-agent. It is here so that you can
hold the sub-agents to it. You make no backlog commit yourself.

{{validateBeforeSync}}

## The design rules each sub-agent follows

Each sub-agent's file also carries these rules. A plan without a `### Sources of truth` part is
not finished. That part says, for each concept the story touches, where it is defined and how the
code reaches it.

{{selfConsistencyGuide}}

{{simplicityGuide}}

## The side-PR rule each sub-agent follows

Each sub-agent's file also carries this rule. You open no PR yourself.

{{sideChangeGuide}}

## The writing rule each sub-agent follows

Each sub-agent's file also carries this rule, and your summary table follows it too.

{{writingGuide}}

## After all sub-agents finish

Print a summary table with one row per story: the story ID, its final status, its points, and a
one-line note on what was planned. If a sub-agent could not finish, the note says why. Name any
`bl validate` findings that a sub-agent reported on stories it did not touch. Do not commit
anything yourself — each sub-agent already committed its own story.
