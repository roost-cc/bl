---
component:
story_id:
title:
type: chore
points:
status: refined
added:
---

# {{storyId}} · {{title}}

## Summary

Dependency update opened by Renovate in `{{updateRepo}}`: PR {{prLink}}, branch
`{{updateBranch}}`. `bl updates run` rebases the branch onto `main`, runs the repo's gate and
merges it when green, majors included; a red major gets Renovate's release notes below (F-50
Design D5). Created by `bl updates sync` from the per-cycle report, which also updates and
closes this story.
{{securityNote}}

## Upgrades

{{upgradesTable}}

## Acceptance Criteria

- [ ] Gate green on the rebased branch.
- [ ] Merged `--no-ff` into `main`.
- [ ] Remote branch deleted.

## Gate result

## Release notes

## Decision needed
