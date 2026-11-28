# The uTop files for people: test fixtures

`alerts.yaml`, `agents.yaml` and `templates/en.yaml` are a copy of the uTop sample's
`config/alerts.yaml`, `config/agents.yaml` and `config/templates/en.yaml` in the backlog repo,
`docs/bl-refactor/presentations/tutorial/utop-backlog/config/` (F-140 D1, F-141 D1). The tests
read this copy, not the backlog repo, as they do for `flows/`. When the source changes, copy the
files again.

`prompts/implement.md` and `schemas/implement.json` are a prompt and an outcome schema for the
tests of F-141. The uTop sample has none yet: F-145 seeds them.
