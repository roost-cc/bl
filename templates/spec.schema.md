# `bl new --from <spec.json>` — spec format

A spec names the stories' component and lists N stories. JSON only (no
comments). All `body_file` paths are resolved relative to the spec file's
directory, so a spec + body files form a self-contained, reviewable bundle.

A component is a code boundary in one repo (`components/C<nn>-<slug>/`). Every
story names exactly one, and the story's repo is its component's `repo`; a
story names no repo of its own.

## Top-level

```json
{
  "component": "C32",          // required: a C-id, or { ... } to create one
  "feature":   "F-3",          // optional
  "stories":   [ { ... }, ... ] // required, non-empty
}
```

## `component`

Either a string, naming an existing component:

```json
"component": "C32"
```

The id is `C<nn>` and must exist under `components/` with a `repo:`. An `E<nn>`
id is refused with the hint that components are C-ids.

Or an object, creating a new component with the next globally-unique
component number:

| Field       | Type     | Required | Notes                                                            |
| ----------- | -------- | -------- | ---------------------------------------------------------------- |
| `repo`      | string   | yes      | A repo registered in `backlog.json`                              |
| `title`     | string   | yes      | The component's title                                            |
| `paths`     | string[] | no       | Globs relative to the repo root (F-61 D2); not absolute, no `..` |
| `body_file` | string   | yes      | Path to a markdown body, no frontmatter                          |

A spec with an `epic` block is refused: it is the pre-F-49 name of
`component`.

## `feature`

Optional `F-<n>` of a live feature. Every story is tagged `feature: F-<n>`,
which makes it the feature's (its only statement of membership), and written
from the shorter `story-feature` template.

## `stories[i]`

| Field          | Type     | Required | Notes                                                     |
| -------------- | -------- | -------- | --------------------------------------------------------- |
| `id`           | string   | yes      | Placeholder name (`[a-z][a-z0-9-]*`), not `S-<n>`         |
| `title`        | string   | yes      |                                                           |
| `points`       | integer  | yes      | Fibonacci: 1, 2, 3, 5, 8, 13                              |
| `effort`       | string   | no       | `low` `medium` `high` `xhigh` `max`; written as `effort:` |
| `type`         | string   | no       | Default `feature`                                         |
| `body_file`    | string   | yes      | Path to markdown body, no frontmatter                     |
| `component`    | string   | no       | An existing `C<nn>` for this story instead of the spec's  |
| `depends_on`   | string[] | no       | Mix of `@<placeholder>` and bare `S-<n>`; input only      |
| `required_for` | string[] | no       | Same syntax, the other way; input only                    |

A story's `component` override lets one spec cut a feature's stories across
several components (and so several repos); the story's repo is the
override's repo.

### Cross-references

Inside `depends_on` / `required_for`:

- `@<placeholder>` — refers to another story in this same spec by its `id`
  field. Resolved to the assigned `S-<n>` before the story is written.
  Unknown placeholders fail validation (exit 2). The leading `@` is
  required to disambiguate placeholders from real IDs.
- `S-<n>` — bare story ID, passed through unchanged. An unknown bare ID
  warns and gets no edge (as with `bl new --depends-on`).

`blockers.json` is the one place for holds and order (F-111 D5), and both
fields are input only: no story file gets `depends_on:` or `required_for:`.
`bl new` writes each dependency as an edge in `blockers.json`, in the commit
of the batch: an order edge (`gate: order`, until `implemented`) when both
stories are in one feature, else a run edge (`gate: run`, until `done`). A
story's `depends_on` names the stories it waits for; its `required_for` names
the stories that wait for it. Declare each dependency on one side only;
`depends_on` on the later story is the usual way. An edge that `bl block add`
would refuse (one that closes a deadlock) fails the whole batch, and nothing
is written.

Mixed lists are allowed: `["@bootstrap", "S-379"]`.

## Body files

- Path is resolved relative to the spec file's directory (not cwd).
- Must exist and be a regular file.
- Must NOT contain its own YAML frontmatter — `bl` manages the
  frontmatter (component, story_id, etc.) for every story.
- HTML comments outside fenced code blocks are stripped, same as
  `bl new --body-file`.

### Template variables

The variables are filled in body files only; `bl` writes the frontmatter itself, through the
`yaml` package (F-62 D3).

Story body files (`stories[i].body_file`):

- `{{storyId}}`, `{{title}}`, `{{componentId}}`, `{{type}}`, `{{points}}`,
  `{{today}}`

Component body file (`component.body_file`, only when creating a component):

- `{{componentId}}`, `{{title}}`, `{{repo}}`, `{{today}}`

## Errors

- Spec validation errors exit **2** with messages keyed by spec path,
  e.g. `stories[2].depends_on[0]: unknown placeholder '@foo'`.
- I/O / system errors exit **1**.
- Unknown bare `S-<n>` IDs do not block; they print a `warning:` line.

### A note on exit codes for `body_file` frontmatter

A body file containing its own YAML frontmatter is rejected by both
single-story (`bl new --body-file <path>`) and batch (`bl new --from
<spec.json>`) modes. The exit codes differ: single-story exits **1**
(treated as an I/O / CLI error), while batch mode exits **2** (treated
as part of spec validation). Scripts that invoke both modes should
accept either non-zero code as failure rather than depending on the
specific value.

## CLI flags

```
bl new --from <spec.json>            # create stories (+ component), sync, summary
bl new --from <spec.json> --dry-run  # validate, print plan, exit 0
bl new --from <spec.json> --json     # JSON output (schema bl-new-batch-json/v2)
bl new --from <spec.json> --dry-run --json   # composable
```

`--dry-run` writes no component, story, or sync files, but it does briefly
take the backlog lock `<backlogRoot>/.bl-new.lock` (a kernel lock that the
file keeps; the lock is freed on exit) so the
printed IDs match exactly what an apply run would assign at that instant.

`--from` cannot be combined with single-story flags (`--title`,
`--component`, `--depends-on`, `--required-for`, `--body-file`, `--type`,
`--points`, `--repo`, `--feature`, `--plugins-from`) — the spec is the source
of truth.

## JSON output schema (`bl-new-batch-json/v2`)

```json
{
  "schema": "bl-new-batch-json/v2",
  "dry_run": false,
  "component": {
    "id": "C52",
    "path": "components/C52-foo/index.md",
    "created": true
  },
  "feature": null,
  "stories": [
    {
      "placeholder": "bootstrap",
      "id": "S-391",
      "path": "stories/S391-bootstrap-shared-config-repo/index.md",
      "component": "C52",
      "created": true
    },
    {
      "placeholder": "ci",
      "id": "S-392",
      "path": "...",
      "component": "C52",
      "created": true
    }
  ]
}
```

In dry-run mode `created` is `false` for every entry and no files are
written.

## Examples

- `bl/templates/spec.example.json` — a new component in `shared-config` + 3
  stories with `@<placeholder>` cross-references in `depends_on`.
- `bl/templates/spec.example.existing-component.json` — existing component
  (`"component": "C32"`) + 2 stories, one of them in another component
  (`"component": "C31"`): `metrics` states its edge to `dashboard` as
  `required_for`, and `dashboard` its edge to the existing `S-379` as
  `depends_on`; both are written to `blockers.json`.
