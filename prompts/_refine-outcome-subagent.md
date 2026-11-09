## Outcome

You are one sub-agent of a batch refine. Write no outcome file. After your commit, end your reply
to the orchestrator with this JSON object, and nothing after it:

```json
{ "refined": true }
```

- Set `refined` to `true` when an agent can implement the story from your plan.
- Set `refined` to `false` when it cannot, and add `"reason": "<why, in one line>"`.

The orchestrator puts your object in the batch's outcome, and `bl refine` sets the story's status
from it when the session ends. Do not change the story's status yourself.
