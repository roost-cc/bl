## Effort level

Each story carries an `effort:` key in its frontmatter: the effort level (how hard the agent
session thinks) that `bl` passes to every session that implements it. Pick the lowest level whose
description fits the whole story:

- `low`: a mechanical change, every step named, no design choice (a rename, a config value, a doc
  edit).
- `medium`: follows an existing pattern in the same repo, the plan names every file, 3 points or
  fewer, and none of the `high` triggers.
- `high`: any of these: it changes a stored data shape, permissions, auth, a platform service API,
  locks or concurrency, or a migration; the plan leaves a design choice to the implementer; 5
  points or more; or the code it changes has weak tests.
- `xhigh`: only with a written reason, for example an earlier run of this work escalated.
- `max`: refine never picks it. Only the operator sets it.

Write the reason as the first line of the story's **## Implementation Plan**:
`**Effort:** <level>: <reason>`.
