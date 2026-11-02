---
component:
story_id:
title:
type: chore
points: 2
status: refined
added:
---

# {{storyId}} · {{title}}

## Summary

`{{lockfile}}` in `{{updateRepo}}` has an advisory on `main`, `{{advisory}}`, with no fixed version
past the release age, so no upgrade can close it. Created by `bl updates vulns`, which also updates
this story and supersedes it when every package the advisory reaches has a fix (F-71 D4).
`bl updates run` does not take it; run it with `bl run`.

{{findingsTable}}

## Outcomes

Reach one of these two:

- **Pivot:** replace or remove the dependency, so the finding leaves the lock file.
- **Stronger evaluation:** write what leaving the dependency implies: whether the vulnerable code
  is reachable, what is exposed, and what would change the answer. It reaches the operator as a
  `bl task`. Once the operator approves it, record it as an `[[IgnoredVulns]]` entry in
  `osv-scanner.toml` with an `ignoreUntil` expiry and the reason, so the question comes back.

## Acceptance Criteria

- [ ] One of the two outcomes is reached, and `## Notes` says which and why.
- [ ] `bin/ci vulns` on the branch no longer lists the finding, through the pivot or the operator's
      approved, expiring `[[IgnoredVulns]]` entry.

## Implementation Plan

1. Find what pulls the package in and what uses the vulnerable code.
2. Take the pivot if it is affordable. Otherwise write the evaluation and file the `bl task`.

## Dependencies

None.

## Notes
