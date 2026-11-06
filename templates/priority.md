---
ranked: []
---

# Priority

The order the operator prefers work to run in: one list of units, features and loose stories
alike, each mapping under `ranked:` naming a `unit` (`F-<n>` or `S-<n>`) and `why`. It is a
preference: hard dependencies override it. Units not ranked here follow the list, oldest
`added:` first. Only the operator or an interactive session ranks; bl never writes this file.
