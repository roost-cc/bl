## Backlog commits: validate, then a locked sync-and-commit

Every backlog commit you make goes through one command, `bl sync --commit`. Before it, run
`bl validate` until it is clean. Follow these steps in order each time you commit story-file
edits:

1. **Validate.** Run `bl validate`. It is read-only and checks the whole backlog.
2. **Fix what you touched.** Resolve every finding on a story you created or edited in this
   session, including child stories from `bl new`. Fix the story itself. Do not add frontmatter
   keys or story fields to explain a change. A dependency is an edge in `blockers.json`, the one
   place for holds and order, never a `depends_on:` or `required_for:` key in a story file.
   `bl new --depends-on` and `--required-for` write the edge with the new story, and
   `bl block add` writes one for stories that exist; each commits it. There is no reverse edge
   to add.
3. **Surface, do not fix, the rest.** A finding on a story you did not touch is pre-existing.
   Leave that story alone and mention the finding in your final report.
4. **Re-run** `bl validate` until nothing is left on the stories you touched.
5. **Sync and commit in one locked step**, naming each story you created or edited with its own
   `--story` (only the `--story` directories are committed):

   ```
   bl sync --commit -m "<type>: <subject> ({{storyId}})" --story {{storyId}} [--story S-<child> …]
   ```

   This takes the backlog lock, commits exactly each `--story` directory and each `--path`, and
   pushes. Other people's uncommitted edits stay out of your
   commit. It commits on the backlog's `main` branch. If nothing changed, it exits 0 without
   committing.

- Write the why and the how of a change in the commit message (`-m`). As with `git commit`, a
  second `-m` becomes a body paragraph under the first one's subject. Never put them in new
  frontmatter keys or story fields.
- Never run `git add` or `git commit` in the backlog repo (`{{backlogDir}}`). A raw commit races
  with other agents that share its working tree and hold the lock. An edit in a different
  repo (a code or secondary repo) is still committed there with `git -C <that repo>`.
