```json
{ "summary": "<one line: what you found and corrected>", "ok": true, "changed": false }
```

- Set `changed` to `true` when you committed a correction.
- Set `ok` to `false` only when the branch must not go to the review as it is and you could not
  correct it; say why in `summary`. bl then stops the run for the operator. When you wrote
  **## Escalation**, bl stops the run whatever `ok` says.
