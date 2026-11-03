---
component:
story_id:
title:
type: chore
points: 1
status: refined
added:
plugins-implement: [vulns-fix]
---

# {{storyId}} · {{title}}

## Summary

`{{lockfile}}` in `{{updateRepo}}` has findings on `main` with a fix at least the release age old.
`bl updates run` upgrades exactly these packages in a detached worktree at `origin/main`, runs the
repo's gate and merges the commit when green. Created by `bl updates vulns`, which also updates
and closes this story (F-71 D4).

{{findingsTable}}

## Acceptance Criteria

- [ ] Gate green on the fix commit.
- [ ] Merged `--no-ff` into `main`.

## Gate result
