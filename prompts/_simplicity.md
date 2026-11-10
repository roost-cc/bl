## Simple, surgical changes

- Build what the story and its acceptance criteria ask for. Add no feature, option,
  configuration or extension point that nobody asked for.
- Do not handle cases that cannot happen. Check input where bad input can arrive (a user, the
  network, a file), and trust the code inside that boundary.
- **DRY (Don't Repeat Yourself).** Each behaviour lives in one place: one helper, one module,
  one wrapper. Call sites use it and never copy it. Before you add code, look for existing
  code that does the same thing, and use it.
  - When two or more parts of the system do the same thing, give them one shared abstraction
    (a helper, a module, a base class), even when no story asks for it. Do not make an
    abstraction for one use.
  - If your change touches a repeated pattern, merge the copies into the shared abstraction.
    Never add one more copy, and never fix one copy and leave the others. This merge traces to
    the story.
  - If the merge reaches far beyond the story's scope, do not copy the pattern either. Name the
    missing shared abstraction and flag it to the operator as a design question.
- Make the smallest change that meets the criteria. If 200 lines could be 50, write 50.
  "Smallest" never means one more copy of a repeated pattern: DRY comes first.
- Every changed line traces to the story, to a named finding or to a DRY merge. Do not
  reformat, rename, re-comment or refactor nearby code that is none of these.
- A finding you fix along the way (a small fix in code the branch touches, a blocking bug)
  goes in its own commit, and the message names the finding. Remove code that your own change
  left unused.
