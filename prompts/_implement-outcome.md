```json
{ "summary": "<one line: what you did>", "done": true, "blocked": null }
```

- Set `done` to `true` when every acceptance criterion of {{storyId}} is checked off.
- Set `done` to `false` when a criterion is still unchecked. Then set `blocked` to one line that
  says what stopped you; otherwise `blocked` is `null`.
- bl decides from the story file and the **## Escalation** section, not from `done`: a criterion
  left unchecked gets one more session, and an escalation stops the run.
