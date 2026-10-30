### IDE-specific hints (Claude Code)

- `/loop <interval> <cmd>` schedules a recurring task; omit the interval
  for self-paced. Useful for watching CI or babysitting PRs.
- `/schedule` creates one-off or cron-style remote agent runs.
- `/ultrareview` starts a multi-agent cloud review of the current branch.
  It is user-triggered, billed, and cannot be invoked by the agent.
- Fast mode (`/fast`) is Opus 4.6/4.7-only and toggles faster output
  without downgrading the model.
- If you need the user to run an interactive shell command, such as
  `gcloud auth login`, suggest they type `! <command>` so the command
  runs in this session and output lands in the conversation.
