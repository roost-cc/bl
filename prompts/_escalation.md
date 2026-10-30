## Writing an escalation

An escalation stops the loop until the operator decides. The operator is busy and has not read
the code, so write for someone who should understand the problem and the choice in one read.
Write it where your instructions say, which is usually the {{unitKind}} file's **## Escalation**
section, in this shape and with these bold headings:

1. **The rule at stake:** the rule or promise that is at risk, in one plain sentence.
2. **How it works:** what the code does today, as a few numbered steps in plain words.
3. **The problem:** a concrete scenario. When order or timing matters, use a short timeline
   table with named people (Alice, Bob, Chad). Otherwise give a concrete example. Then state
   the bad result in one sentence.
4. **Why the agents can't fix it:** what stands in the way, such as a missing mechanism, a
   design decision, or a business rule only the operator can set, and why another attempt
   would not help.
5. **The decision:** lettered options (A, B, ...). Give each its cost and what follows from it.
   Mark one as recommended and say why. End with the exact question the operator must answer.
6. **Details:** a short list at the end for repro commands, test names, file paths, commit
   SHAs and review items. Keep them out of 1 to 5.

- Use no unexplained jargon. Words like "non-atomic", "compensation" or "read/write boundary"
  mean nothing to someone who has not seen the code, so say what actually happens instead.
- Name a code identifier only when the operator needs it, and explain it in passing, for
  example "the membership index (the lookup storage uses to decide who gets group
  permissions)".
- Keep it short, about one screen. When there are several separate decisions, give each one
  its own block in the same shape.
- When the operator decides (in this session or later), never mark the escalation "resolved"
  in place. Record the outcome where it belongs, in the Review Log or as a dated decision in
  the Design, and set **## Escalation** back to exactly `None.`. Any other text there blocks
  `bl run`.

Example:

> **The rule at stake:** once a group is closed, nobody can be removed from it.
>
> **How it works:** a removal takes three separate steps:
>
> 1. check the group isn't closed;
> 2. take Bob off the member list;
> 3. remove Bob's entry from the membership index (the lookup storage uses to decide whether
>    Bob gets group permissions).
>
> **The problem:** someone can close the group in the middle of those steps:
>
> | Time | Alice (removing Bob)          | Chad (closing the group) |
> | ---- | ----------------------------- | ------------------------ |
> | 1    | checks: group is open ✓       |                          |
> | 2    | takes Bob off the member list |                          |
> | 3    |                               | closes the group         |
> | 4    | removes Bob's index entry     |                          |
>
> Result: the group is closed and Bob is out, which the rule says can't happen.
>
> **Why the agents can't fix it:** each step writes a different object, and storage has no
> all-or-nothing transaction across objects. Rechecking only moves the gap.
>
> **The decision:**
>
> - A. Accept it (recommended): a removal that started before the close may finish. The window
>   is milliseconds and the outcome is harmless.
> - B. Enforce it: add a mechanism that makes a close wait for, or undo, removals in progress.
>   That is more code and more ways to fail.
>
> Should a removal that started before the close be allowed to finish (A), or must the close
> stop it (B)?
>
> **Details:**
>
> - Repro: `node /b/.bl/run/F-22.r3.verify.scratch/close-race.mjs`
> - Test: `groups.int.test.js` › "remove racing close"
> - Code: `remove()` and `_reconcile()` in `src/groups/membership.js`
