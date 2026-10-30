The test gate for {{unitKind}} {{featureId}} — "{{title}}" failed on branch
`{{branchName}}`. Make it pass without weakening the tests.

Unit dir     : {{unitDir}} (your working directory)
Lead worktree: {{worktreePath}} ({{targetRepo}})
Failing repo : {{testRepo}}, worktree {{testWorktree}}
Unit file    : {{featureAbsPath}} ({{unitKind}})
Backlog repo : {{backlogDir}}
{{fixNote}}
The gate tests every repo of the {{unitKind}} in that repo's own worktree, and the check below
failed in **{{testRepo}}**. Fix it and commit the fix in `{{testWorktree}}`, on `{{branchName}}`.
When that is not the worktree you started in, work there with paths and `git -C {{testWorktree}} …`.

## The failing command

```
{{testCommand}}
```

## Failure excerpt

The lines of the output around every failure marker (runner failure headers,
`Error:` lines, failed-test summaries), from anywhere in the run:

````
{{testExcerpt}}
````

## Full log

`{{testLogPath}}` holds the complete output of this gate attempt.

## Last lines of its output

````
{{testTail}}
````

## Rules

1. Read the failure before touching anything. Start with the excerpt, then
   read the full log at `{{testLogPath}}`: the excerpt and the last lines
   above are only part of the run, and the tail of a stack-backed run is
   usually teardown noise. Do not rerun the suite to see its output; the log
   already has it. Find the assertion or error, the code it exercises, and the
   commit on this branch that changed that code
   (`git log --oneline main..HEAD -- <file>`). When you do run something to
   diagnose (one test, a probe script), redirect its output to a file in
   `{{scratchDir}}` and write any probe there too.
2. Fix the code, not the test, unless the test itself encodes a wrong
   expectation that the {{unitKind}}'s design explicitly changes. Never
   delete, skip, or loosen an assertion to get green; if a test is genuinely
   obsolete, say so in the commit body and reference the Design decision.
3. If a service the tests run against exited during startup, read its log
   first. When the services under test run code other than this worktree's,
   for example a main checkout's, the gate is testing the wrong code: do not
   change code to satisfy it. End with
   `UNRELATED: <which service runs which code, and why>`.
4. A failure this branch did not cause is still a bug, and it is yours to fix.
   That covers a flaky or intermittent failure, a timeout, a race, and a
   failure that is already on `main` (check `main` in a scratch worktree of
   `main`, never by stashing in a worktree). Do not stop at labelling it.
   Find its cause: rerun the failing test many times, rerun it at the worker
   count the gate uses (a page load that times out only under parallel workers
   is contention), and read a Playwright trace (`--trace on`) or the service
   logs. Then fix it in its own commit, even when the code is outside this
   {{unitKind}}'s scope, and record it as **Blocked by a bug** below
   describes. If the failure will not reproduce after a real attempt,
   end with `RERUN: <what you tried>`. Never end with `UNRELATED` for it.
5. If the failing command is `git status`, the gate refused a dirty worktree:
   commit the listed files that belong to the {{unitKind}} (with a message ending in
   ` ({{featureId}})`). Move any that do not belong into `{{scratchDir}}`; if
   your tools cannot move them, leave them and end with
   `UNRELATED: stray files in the worktree: <paths>` so the operator removes
   them. Leave the tree clean.
6. Re-run the failing command until it passes, then run the full command once
   more. Commit with a Conventional Commits message ending in ` ({{featureId}})`
   (an ad-hoc bug fix ends in ` ({{featureId}} S-<id>)`).
7. Anything else you find of about one point in code this branch already
   touches is fixed now, not added to the {{unitKind}} file's follow-up
   section; a nit is fixed or dropped, never deferred.

{{sessionStack}}

## Scratch files

Write diagnostics (probe scripts, redirected test output, scratch configs) under
`{{scratchDir}}`, never in the worktree. The test gate refuses a dirty worktree, and a
headless session cannot remove files.

{{blockedByBug}}

{{escalationGuide}}

{{toolGuide}}

## IMPORTANT

- Do NOT push, open a PR, or run any `bl sync` other than a `bl sync --commit`
  line shown above.
- End your response with exactly one of these lines:
  - `FIXED`: you committed a fix. The loop reruns the gate.
  - `RERUN: <what you tried>`: the failure would not reproduce after a real
    attempt (say which runs you made). The loop reruns the gate once. If it
    fails again, a new session gets the failure to fix.
  - `UNRELATED: <reason>`: use it only when nothing in the repos can make the
    gate pass. There are three cases: the stack runs code other than this
    worktree's (rule 3); stray files your tools cannot move (rule 5); or
    infrastructure outside the repos is down, such as an expired certificate
    or an unreachable registry. `UNRELATED` stops the run and escalates with
    your reason without rerunning the gate. Keep the line itself to a short
    summary. Before you end with it, write the full explanation for the
    operator to `{{scratchDir}}/escalation.md` with the {{writeTool}} tool, in
    the shape **Writing an escalation** describes. The loop copies that file
    into the {{unitKind}} file's **## Escalation** and adds the gate's command, log path
    and excerpt after it, so do not repeat those. "Flaky", "intermittent", "timeout"
    and "not caused by this branch" are never reasons for `UNRELATED`.
