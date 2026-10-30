You are performing cleanup and triage for story {{storyId}} — "{{title}}".

The story has been merged into main, but it had a **## To Do** section with
unresolved items. Your goal is to convert these items into new backlog
stories.

## Context

Component : {{componentEntry}} ({{componentId}})
Backlog repo : {{backlogDir}}
To Do section :
{{todoSection}}

## Steps

1. {{readTool}} the current backlog index files to understand existing stories:
   `{{backlogDir}}/index.md`
   `{{backlogDir}}/components/{{componentEntry}}/index.md`

2. For each distinct `[points: N]` item in the **## To Do** section above
   (the section holds sized follow-up code work only; records live under
   `## Notes` and the operator's work is a task, so neither is here):
   - Create a new story using `bl new`.
   - Pass `--plugins-from {{storyId}}` to every `bl new`. The new story
     then defaults to {{storyId}}'s component (`{{componentId}}`) and
     primary repo, and keeps its test gate (`plugins-test`) and other
     `plugins-*` keys.
   - Name another component (`bl new C<nn> …`), or `--repo <name>` for
     that repo's home component, only when the item belongs in a different
     code boundary from {{storyId}}'s. A component in another repo copies
     no plugins (and `bl new` says so).
   - Use the item's description for the title and body.
   - Assign points from the item's own estimate. Items are written in the
     form `[points: N]` (Fibonacci) by the agent that uncovered them — pass
     that `N` to `bl new --points N`. Do NOT default to 1. If an item has
     no estimate, read enough of the relevant code to make your own
     Fibonacci estimate before creating the story; only fall back to a
     guess when the item is too vague to size, and say so in the body.
   - Order. Before creating anything, read all the items and decide their
     order (with only one item there is nothing to order). Item B goes after
     item A when B names A (or "round N" of the review that produced A),
     names the same function or file A changes, or cannot be done until A
     lands. Create A first, then pass `--depends-on <S-id of A>` to B's
     `bl new` (comma-separated for several). When an item depends on an
     existing backlog story, pass that story's ID the same way, at any item
     count, including one. Items with no such relation get no
     `--depends-on`. Never pass `--required-for` to the earlier item (its
     later item does not exist yet) and never edit
     `depends_on` / `required_for` by hand: `bl fix --story` adds the
     reverse `required_for` edge in the validate step below.

3. Group overlapping stories into a feature. With only one new story, skip
   this step: one story alone never becomes a feature.
   - When two or more of the new stories touch the same functions or files
     (which normally means the same repo), group them in one feature:

     ```
     bl new --feature --title "<what they change together>" --theme <slug> [--epic <E-id>] S-<a> S-<b> …
     ```

     List the stories in run order (each after the ones it depends on). It
     sets `feature:` on each story and lists them in the feature's
     `stories:`. Its last stdout line is the new feature's `index.md` path,
     relative to `{{backlogDir}}`; keep its directory for the commit step.

   - Theme: read the frontmatter of the file `bl which {{storyId}}` prints.
     If it has `feature:`, use that feature's `theme:`, and its `epic:` when
     it has one. Otherwise use the theme under `{{backlogDir}}/themes/`
     (`themes/*/index.md`) whose `repos:` lists the stories' repo, with no
     `--epic`. Do not create a theme or an epic. If no theme's `repos:`
     lists the repo, or more than one does, do not guess: leave the stories
     standalone (their `--depends-on` order stays) and say so in your final
     list.
   - Stories that touch nothing in common with the others stay standalone.
   - If `bl new --feature` refuses (a story is already in a feature, or is
     not `backlog` / `refined`), do not retry: leave the stories standalone
     and say so in your final list.

4. Remove the **## To Do** section from the story file using the
   {{editTool}} tool. The file is the path `bl which {{storyId}}` prints
   (under `{{backlogDir}}/stories/`).

5. Validate, fix and commit your work by following **Backlog commits**
   below. Nothing after this session commits for you (the parent `bl merge`
   already made its own "mark done" commit before spawning you). Use the
   message `chore: triage {{storyId}} To Do into new stories`. Pass
   `--story {{storyId}}` for the `## To Do` removal, plus one `--story` for
   each new story you created and for each story the `bl fix` report
   listed. When step 3 created a feature, also pass
   `--path <feature directory>`: the path `bl new --feature` printed
   without its trailing `/index.md` (for example `features/F68-<slug>`),
   since a feature has no `--story`.

{{validateBeforeSync}}

{{toolGuide}}

## IMPORTANT

- At the end, list the IDs of the new stories you created, the ID of any
  feature you created (or why you left overlapping stories standalone), and each
  dependency edge you added, as `S-b depends on S-a`.
