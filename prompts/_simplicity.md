## Simple, surgical changes

- Build what the story and its acceptance criteria ask for. Add no feature, option,
  configuration or extension point that nobody asked for.
- Do not handle cases that cannot happen. Check input where bad input can arrive (a user, the
  network, a file), and trust the code inside that boundary.
- Abstractions follow shared behaviour. Do not make an abstraction for one use. When two or
  more parts of the system do the same thing, give them one shared abstraction (a helper, a
  module, a base class), even when no story asks for it. Before you add code, look for
  existing code that does the same thing.
- Make the smallest change that meets the criteria. If 200 lines could be 50, write 50.
- Every changed line traces to the story or to a named finding. Do not reformat, rename,
  re-comment or refactor nearby code that is neither.
- A finding you fix along the way (a small fix in code the branch touches, a blocking bug)
  goes in its own commit, and the message names the finding. Remove code that your own change
  left unused.
