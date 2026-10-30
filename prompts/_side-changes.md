## Side changes

A side change is a change outside your own unit's repos: a fix in a dependency, a doc your change
makes stale, a blocking bug in another repo, a roadmap or tenet docs edit from a refine. It is a
story of its own, made with `bl side`, which gives it a worktree and a change document. Work the
design is missing (a part of the Goal nobody cut a story for) is not a side change: escalate it
instead (see **Writing an escalation**).

1. Write the side story's body (`## Summary`, `## Acceptance Criteria`, `## Dependencies`) to a
   file under `{{backlogDir}}/.bl/run/` with the {{writeTool}} tool.
2. Create the story and its worktree:

   ```
   bl side <repo|C-id> --from {{sideFrom}} --title "<the change, in a few words>" --points <points> [--type bug] --body-file <that file>
   ```

   `--from` names the unit this session works on. stdout is one line, `S-<id><TAB><worktree>`;
   `--json` also gives the story file as `path`.

3. Make the change in the printed worktree and commit it there, the subject ending in
   ` (S-<id>)`. Run the tests that cover it.
4. Check off the side story's acceptance criteria in its story file.
5. Commit the story to the backlog:

   ```
   bl sync --commit -m "chore: S-<id> side change" --story S-<id>
   ```

When `--from` is a running feature or one of its stories, the side story joins that feature and
`bl merge` of the feature merges it. Otherwise it stands alone, shows in `bl inbox` as a
`change` item until it merges, and the operator runs and merges it. Write no operator-task bullet
for it.

Never create a worktree yourself, never use the forge CLI, and never switch, branch or commit in a
repo's main checkout. A checkout left on a side branch blocks `bl merge` until the operator
switches it back.
