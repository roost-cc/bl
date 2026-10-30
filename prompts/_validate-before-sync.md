## Backlog commits: validate, then a locked sync-and-commit

Every backlog commit you make goes through one command, `bl sync --commit`. Before it, run
`bl validate` until it is clean. Follow these steps in order each time you commit story-file
edits:

1. **Validate.** Run `bl validate`. It is read-only and checks the whole backlog.
2. **Fix what you touched.** Resolve every finding on a story you created or edited in this
   session, including child stories from `bl new`. Fix the story itself. Do not add frontmatter
   keys or story fields to explain a change. Run `bl fix --story <id>` first, with one `--story`
   per story you touched (`bl fix --dry-run --story <id>` previews), for the findings it can
   repair. It repairs `asymmetric-dep` by adding the missing reverse `depends_on` /
   `required_for` edge on the other story, and its report lists each file it wrote by story
   path; keep that list for step 5. Never run `bl fix` without `--story`: unscoped, it rewrites
   stories you did not touch. `bl new` never adds the reverse edge for you, so a new
   `depends_on` usually needs it. Do not edit those lists by hand.
3. **Surface, do not fix, the rest.** A finding on a story you did not touch is pre-existing.
   Leave that story alone and mention the finding in your final report.
4. **Re-run** `bl validate` until nothing is left on the stories you touched.
5. **Sync and commit in one locked step**, naming each story you created or edited with its own
   `--story`, plus one `--story` for every other story the `bl fix` report listed (the reverse
   edge lands on that story's file, and only the `--story` directories are committed):

   ```
   bl sync --commit -m "<type>: <subject> ({{storyId}})" --story {{storyId}} [--story S-<child> …]
   ```

   This takes the backlog lock, regenerates the index files, and commits exactly the paths the
   sync wrote plus each `--story` directory. Other people's uncommitted edits stay out of your
   commit. It commits on the backlog's `main` branch. If nothing changed, it exits 0 without
   committing.

- Write the why and the how of a change in the commit message (`-m`). As with `git commit`, a
  second `-m` becomes a body paragraph under the first one's subject. Never put them in new
  frontmatter keys or story fields.
- Never run `git add` or `git commit` in the backlog repo (`{{backlogDir}}`). A raw commit races
  with other agents that share its working tree and hold the lock. An edit in a different
  repo (a code or secondary repo) is still committed there with `git -C <that repo>`.
