   Write `Origin: introduced` in two cases: the defect is in lines this branch added or changed
   (`git diff {{mainRef}}...HEAD`), or the branch makes a pre-existing defect newly reachable or
   worse. Write `Origin: pre-existing` only when neither case applies. `introduced` wins: a defect
   in lines the branch added or changed is `introduced`, even if `{{mainRef}}` shows the same
   behavior. Check with the diff or `git blame`; do not guess.
