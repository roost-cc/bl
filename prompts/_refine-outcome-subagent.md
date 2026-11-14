## Outcome

You are one sub-agent of a batch refine. Write no outcome file. After your commit, end your reply
to the orchestrator with this JSON object, and nothing after it:

```json
{ "refined": true, "reason": "<one line: why it is ready>" }
```

- Set `refined` to `true` when an agent can implement the story from your plan, and set `reason`
  to why it can, in one line: what you checked that shows it.
- Set `refined` to `false` when it cannot, and set `reason` to what keeps it from being refined,
  in one line.

The orchestrator puts your object in the batch's outcome, and `bl refine` sets the story's status
from it when the session ends. Do not change the story's status yourself.
