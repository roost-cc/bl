```json
{ "summary": "<one line: what the fix round did>", "fixed": true, "open": 0 }
```

- `open` counts the **Must fix** and **Should fix** items of the latest session that are still
  unchecked.
- Set `fixed` to `true` when `open` is 0. bl then sets the change document's review status to
  fixed, and the next review checks your fixes. Set it to `false` when an item is still open. bl
  then leaves the review status as it is, and `bl run` stops for the operator.

bl owns the review state in the change document's frontmatter. Do not edit it. Only a review
signs the change off.
