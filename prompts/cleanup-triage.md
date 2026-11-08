You are performing cleanup and triage for story {{storyId}} — "{{title}}".

The story is merged into main, but its **## Deferred** section still holds deferred work. Your goal
is to turn that work into new backlog stories.

## Context

Component : {{componentEntry}} ({{componentId}})
Backlog repo : {{backlogDir}}
Deferred section :
{{deferredSection}}

## Steps

1. Run `bl list` to learn the existing open stories, and `bl status {{componentId}}` for this
   component's.

2. Each distinct `[points: N]` bullet in the **## Deferred** section above is an item. The
   section holds only sized deferred code work. Records go under `## Notes`, and the operator's
   work is a task, so neither is here. For each item:
   - Create a new story with `bl new`.
   - Pass `--plugins-from {{storyId}}` to every `bl new`. The new story
     then defaults to {{storyId}}'s component (`{{componentId}}`) and
     primary repo, and keeps its test gate (`plugins-test`) and other
     `plugins-*` keys.
   - Name another component (`bl new C<nn> …`), or `--repo <name>` for
     that repo's home component, only when the item belongs in a different
     code boundary from {{storyId}}'s. A component in another repo copies
     no plugins (and `bl new` says so).
   - Use the item's description for the title and the body.
   - Assign points from the item's own estimate. The agent that found the item wrote it in the
     form `[points: N]` (Fibonacci). Pass that `N` to `bl new --points N`. Do NOT default to 1.
     If an item has no estimate, read enough of the relevant code to make your own Fibonacci
     estimate before you create the story. Fall back to a guess only when the item is too vague
     to size, and say so in the body.
   - Order. Before you create anything, read all the items and decide their order. With only
     one item there is nothing to order. Item B goes after item A in any of these cases:
     - B names A, or "round N" of the review that produced A.
     - B names the same function or file that A changes.
     - B cannot be done until A lands.

     Create A first, then pass `--depends-on <S-id of A>` to B's `bl new` (comma-separated for
     several). When an item depends on an
     existing backlog story, pass that story's ID the same way, at any item
     count, including one. Items with no such relation get no
     `--depends-on`. The edge is stated once, on the later item. Never pass `--required-for` to
     the earlier item, because its later item does not exist yet. Never edit `depends_on` by hand.

3. Group overlapping stories into a feature. With only one new story, skip this step:
   one story alone never becomes a feature.
   - Two or more of the new stories may touch the same functions or files (which normally means
     the same repo). If they do, group them in one feature:

     ```
     bl new --feature --title "<what they change together>" --theme <slug> [--epic <E-id>] S-<a> S-<b> …
     ```

     It sets `feature:` on each story, which makes it the feature's story. The feature runs its
     stories in dependency order. The command's last stdout line is the new feature's `index.md`
     path, relative to `{{backlogDir}}`. Keep its directory for the commit step.

   - Theme: read the frontmatter of the file that `bl which {{storyId}}` prints. If it has
     `feature:`, use that feature's `theme:`, and its `epic:` when it has one. Otherwise use the
     theme under `{{backlogDir}}/themes/` (`themes/*/index.md`) whose `repos:` lists the stories'
     repo, with no `--epic`. Do not create a theme or an epic. If no theme's `repos:`
     lists the repo, or more than one does, do not guess. Leave the stories standalone (their
     `--depends-on` order stays), and say so in your final list.
   - Stories that touch nothing in common with the others stay standalone.
   - If `bl new --feature` refuses, do not retry. It refuses when a story is already in a feature,
     or is not `backlog` / `refined`. Leave the stories standalone, and say so in your final list.

4. Remove the **## Deferred** section from the story file with the {{editTool}} tool. The file is
   the path that `bl which {{storyId}}` prints (under `{{backlogDir}}/stories/`).

5. Run `bl validate`, fix its findings and commit your work, by following **Backlog commits**
   below. When this session ends, `bl` commits and pushes what you left uncommitted with
   `chore: triage {{storyId}} Deferred into new stories`. (The parent `bl merge` already made its
   own "mark done" commit before it started you.) Use the message
   `chore: triage {{storyId}} Deferred into new stories`. Pass `--story {{storyId}}` for the
   `## Deferred` removal, plus one `--story` for each new story you created. If step 3 created a
   feature, also pass `--path <feature directory>`, because a feature has no `--story`. The
   feature directory is the path that `bl new --feature` printed, without its trailing `/index.md` (for example `features/F68-<slug>`).

{{validateBeforeSync}}

{{writingGuide}}

{{toolGuide}}

## IMPORTANT

- At the end, list these:
  - the IDs of the new stories you created;
  - the ID of any feature you created, or why you left overlapping stories standalone;
  - each dependency edge you added, as `S-b depends on S-a`.
