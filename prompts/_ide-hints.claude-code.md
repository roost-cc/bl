### IDE-specific hints (Claude Code)

- `/loop <interval> <cmd>` runs a command again at each interval. Without
  the interval, the agent sets its own pace. Use it to watch CI or pull
  requests.
- `/schedule` creates one-off or cron-style remote agent runs.
- `/ultrareview` starts a multi-agent cloud review of the current branch.
  Only the operator can start it, and it is billed. The agent cannot start
  it.
- Fast mode (`/fast`) works only on Opus 4.6/4.7. It turns faster output on
  or off and keeps the same model.
- If the operator must run an interactive shell command, such as
  `gcloud auth login`, suggest that they type `! <command>`. The command
  then runs in this session, and its output shows in the session.
