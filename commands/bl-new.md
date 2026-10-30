# New Backlog Story

Create a new backlog story with the next available story number.

**Usage:** `/bl-new <C-id> --title <title> --points <n> [--type <type>]`

A component (`C<nn>`) is a code boundary in one repo. The story's repo is its component's
repo; no repo is written on the story or on a feature.

## Arguments

| Arg              | Required | Description                                                              |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `<C-id>`         | Yes\*    | The story's component (e.g. `C10`), positionally or as `--component C10` |
| `--repo`         | No       | With no component: that repo's home component. Another repo is an error  |
| `--title`        | Yes      | Short story title (used in index tables)                                 |
| `--points`       | Yes      | Fibonacci story points: 1, 2, 3, 5, 8, 13                                |
| `--type`         | No       | Story type (default: `feature`). E.g. feature, bug                       |
| `--depends-on`   | No       | Comma-separated story IDs this depends on (repeatable)                   |
| `--required-for` | No       | Comma-separated story IDs this unblocks (repeatable)                     |
| `--json`         | No       | Emit JSON to stdout (schema `bl-new-json/v2`); human output → stderr     |
| `--from`         | No       | Batch mode: read N stories (and optionally a new component) from a spec  |
| `--dry-run`      | No       | With `--from`: validate spec and print the plan, write nothing           |
| `--no-sync`      | No       | Skip the post-create `bl sync` pass (run it yourself afterward)          |

\* Or `--repo` (the repo's home component), or `--plugins-from S-<n>` (that story's component).

## Steps

1. Parse `$ARGUMENTS` for all flags above.

2. Run the script with all fields:

   ```
   bl new <C-id> --title "<title>" --points <n> --type <type> \
          [--depends-on S-379,S-380] [--required-for S-385]
   ```

   To create a new component (a code boundary in a registered repo):

   ```
   bl new --component --repo <repo> --title "<name>" [--home]
   ```

3. Display the path to the newly created story file so the user can open and fill it in.

The script automatically syncs the backlog after creating the story (or component), so the
affected component and root `index.md` files are regenerated in one command. Pass
`--no-sync` for batch flows where you'll run `bl sync` yourself once at the end.

## Batch mode (`--from <spec.json>`)

Pass `--from <spec.json>` to create N stories (and optionally a new component) from a single
JSON spec. See `bl/templates/spec.schema.md` (or `bl agents`) for the schema. The spec names
the stories' component (`"component": "C32"`, or `{ "repo", "title", "body_file" }` to create
one) and one entry per story (placeholder id, title, points, body_file, optional
type/component/depends_on/required_for). Sibling cross-references use `@<placeholder>` and
resolve to the assigned `S-<n>` IDs before any file is written.

```bash
bl new --from plan.json
bl new --from plan.json --dry-run         # validate + print plan, no writes
bl new --from plan.json --dry-run --json  # machine-readable plan
bl new --from plan.json --json            # apply, print JSON summary
```

Single-story flags (`--title`, `--component`, `--depends-on`, etc.) are rejected in batch
mode — the spec is the source of truth.
