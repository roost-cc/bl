## Outcome

As the last act of the session, after your commit and the walkthrough,
use the {{writeTool}} tool to write this JSON object, and nothing else, to `{{outcomePath}}`:

```json
{ "summary": "<one line: what you planned>", "refined": true }
```

- Set `refined` to `true` when an agent can implement the story from your plan. `bl refine` then
  sets the story's status to refined.
- Set `refined` to `false` when it cannot, and add `"reason": "<why, in one line>"`. `bl refine`
  prints the reason and leaves the status as it is.

`bl refine` reads the file when the session ends. If the file is missing or does not match this
shape, `bl refine` changes no status. Do not change the story's status yourself.
