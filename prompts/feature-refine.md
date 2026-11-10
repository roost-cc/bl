You are refining feature {{featureId}} — "{{title}}".

Feature file : {{featureAbsPath}}
Relative     : {{featureRelPath}} (cwd is the backlog root)
Status       : {{status}}
Repos        : {{storyRepos}} (from its stories' components)
Backlog repo : {{backlogDir}}
Roost dir    : {{roostDir}}

Stories already linked to this feature:
{{storiesList}}

## What a feature is

A feature is the work unit that bl implements, reviews and merges as one: one branch, one pull
request, one review. Its stories are the ordered plan and the checklist, not
separate deliverables. Your job is to make the feature ready for that. It needs four things:

- a premise that the operator can approve in five minutes;
- a design, written once;
- feature-level acceptance;
- a story cut that an agent can carry out in order without asking anyone.

## Before the design: the theme brief and the road map

{{readTool}} these before you write any of the design.

- **The feature's theme brief**, the documents its theme names for any work in it:

{{themeBrief}}

- **The road map**, `{{backlogDir}}/roadmap.md`, holds the future states the project is heading
  for and the directions to them. It also holds the hazards on the way (gates such as go-live)
  and the decisions put off. It is direction, not a commitment. Prefer the generic solution that
  an entry points to. The operator sets its statuses by hand, and they inform; bl never gates on
  them. The feature may go against an entry. Two examples: a production deploy while a go-live
  hazard is not `done`, or a residence-only shape where an entry says the core stays generic. If
  it does, say so to the operator in the Premise's `Challenged:` paragraph and in your reply.
  Let them decide; do not stop on your own.

## Steps

1. {{readTool}} the feature file. Do not search for it.

2. Explore every repo that the work touches (under {{roostDir}}). Go on until you can name the
   files, contracts and tests involved. Also find where the system already defines each concept
   that the work touches (see **Self-consistent designs** below). Ground every claim below in
   something you read.

   A feature's repos come from its stories: a
   story's repo is its component's, and that is what puts the repo in the feature. So work in
   another repo needs a story in a component of that repo (one story per repo).
   bl orders them `bl` first, then by first story in dependency order. The first repo starts the
   session and gives the review its config.
   Neither a story nor a feature names a repo: never add `primary_repo` or `secondary_repos` to a
   frontmatter.

3. Write **## Premise**. State the assumption that makes this feature the right thing to build,
   and cite the code or evidence it rests on. Then try to falsify it. Is the requirement really
   what the feature says? Or is it a derived shape that brought in a stronger claim? Examples are
   one URL where two mounts would do, or one flag where a config already exists. Record the attempt
   as a paragraph that starts with `Challenged:`: what you checked and why the premise holds.

   If the premise does not hold, write that, and stop after step 12, with `"premise_holds": false`
   in the outcome (see **Outcome** below). `bl refine` then puts the feature back to draft. A wrong
   premise costs a revert later, and this paragraph is the cheapest place to catch
   it. A feature that touches authentication, storage contracts or a cross-service boundary always
   gets this paragraph.

4. Write **## Goal**, **## Design** and **## Out of Scope**. You write the Design once, here: the
   decisions, the rejected alternatives, and the contracts that the stories implement. Stories
   point to this section; they never restate it. In the Design, name the behaviour the new work
   shares with existing code or with its sibling stories. Decide whether that behaviour gets
   a shared abstraction (see **Simple, surgical changes** below).

5. Write **## Acceptance**: feature-level outcomes. Each one is observable on the merged result,
   not on one story alone.

6. Cut the stories. Rules:
   - Give each story 2 to 5 points, never 1. Fold small work into a sibling.
   - Give the feature {{pointsMin}} to {{pointsMax}} points in total. Above that, split the
     feature. Below that, ask whether it is a feature at all.
   - Make no check-only stories ("confirm…", "verify…", "re-run…"). A check is an acceptance
     criterion of the story that made the change.
   - Keep each story's Implementation Plan to 40 lines or fewer. It links to the Design section
     instead of repeating it.
   - Write each plan step as `<step> → verify: <check>`, where the check is the test, command
     or observation that shows the step worked.
   - Write every file path in the plan in backticks (`src/x.js`). When several targets run at
     once, `bl run` reads these paths to hold back a target that touches the same file as
     another. `bl run` does not see a path that is not in backticks.
   - Give the plan a `### Sources of truth` part: for each concept the story touches, where it
     is defined and how the code reaches it. The story reads these paths and does not change
     them, so `bl run` does not hold a target back for them.
   - Give each story an effort level by **Effort level** below: put `"effort": "<level>"` on its
     spec entry, and write the `**Effort:** <level>: <reason>` line as the first line of its
     Implementation Plan.
   - Order matters. Declare `depends_on` between stories so that `bl implement` runs them in
     sequence. Declare each edge once, as `depends_on` on the later story. bl derives the
     inverse, and a stored `required_for:` is a `derived-key` error.
   - A dependency outside the feature must already be done, or be pulled into the feature.
     Otherwise `bl approve` warns and `bl implement` refuses.

   Create the stories in one call, so that their IDs and cross-references resolve together:

   ```
   bl new --from <spec.json>
   ```

   Put `"feature": "{{featureId}}"` and the stories' `"component": "C<nn>"` at the top level of
   the spec. A component is a code boundary in one repo, and a story's repo is its component's
   repo. A story that belongs in another component (another code boundary, or another repo) sets
   `"component": "C<nn>"` on its own entry. The stories' repos are the feature's repos. `bl run`
   prepares a worktree for each of them and for nothing else. So every repo that the work changes
   needs a story in one of its components. You can also add one story afterwards with
   `bl new {{featureId}} <C-id> --title … --points …`.

   The spec schema is in `{{roostDir}}/bl/templates/spec.schema.md`. Body files use the
   `story-feature` template (`bl new --print-template story-feature`). `bl new` tags every story
   it creates `feature: {{featureId}}`, and that tag makes it this feature's story. bl derives a
   feature's stories, points and components from its stories; never write them in the feature
   file.

   If stories are already linked (listed above), update or supersede them. Do not duplicate them.

7. Check the feature's value axis in its frontmatter:
   - `theme: <slug>` names the theme it serves (one directory under `themes/`).
   - `epic: E<nn>`, when the feature belongs to one, names an epic under `epics/` in the same
     theme.

   The operator sets both by hand, and `bl sync` derives the epic's feature list.
   `bl list --features --theme <slug>` shows the theme's epics and features to choose from. If no
   epic fits, leave `epic:` out; do not force one. Do not change the feature's status: `bl refine`
   sets it from your outcome.

8. Run `bl validate`, and resolve every finding it reports before you commit. `bl status
   {{featureId}}` lists the feature's stories with the cut.

9. Format the changed markdown with `bl format --no-story <paths>`. Feature files are outside
   story scope, so the `--story` form does not apply to them.

10. Commit to the backlog repo's main branch, by path. When this session ends, `bl` commits and
    pushes what you left uncommitted with `chore: refine {{featureId}}`, but your own commit says
    why. Name every story you created or edited with its own `--story`:

    ```
    bl sync --commit -m "chore: refine {{featureId}}" --path {{featureRelPath}} --story S-<id> [--story S-<id> …]
    ```

    The command takes the backlog lock, commits only the feature file and the story directories,
    and pushes. It never commits what another session has staged.
    Never run `git add` or `git commit` in the backlog repo.

11. Walk the operator through the feature. Give one item at a time, and wait after each:

    1. A short summary of the feature's intended outcome.
    2. For each story, in order: a short summary of what it does and how it moves the feature
       toward the outcome.

    The operator may ask questions or ask for changes. Make each approved change in the backlog
    and commit it as in step 10. Move to the next item only when the operator says so.

12. Write the outcome as the last act of the session, after the walkthrough (see **Outcome**
    below).

## Operator decisions and `## Escalation`

- Record every decision that the operator makes during this refine where it belongs. That is a
  dated bullet in **## Design**, or in **## Premise** when it answers a premise challenge, for
  example `**Decision A1 (operator, YYYY-MM-DD):** …`.
- Put each question that is still undecided in an **## Open Questions** section, with your
  recommendation.
- **## Escalation** is only for a blocker that must stop `bl run` until the operator acts.
  A refine normally leaves it exactly `None.`. Once something is decided,
  never note it as "resolved" in **## Escalation**; set the section back to `None.`.
- Any other text in **## Escalation** blocks `bl run`, and `bl approve` refuses the feature.

{{selfConsistencyGuide}}

{{simplicityGuide}}

{{effortGuide}}

{{sideChangeGuide}}

{{collaborationGuide}}

{{writingGuide}}

{{toolGuide}}

## IMPORTANT

- Do NOT implement anything. Refine and plan only.
- After this session, the operator approves the feature with `bl approve {{featureId}}`. Write
  for that reader.
- The tool guide's `--story {{featureId}}` convention is for stories. For this feature, use
  `bl format --no-story <paths>` and the verbs with `{{featureId}}`.

## Outcome

As the last act of the session, after your commit and the walkthrough, use the {{writeTool}} tool
to write this JSON object, and nothing else, to `{{outcomePath}}`:

```json
{ "summary": "<one line: what you decided and planned>", "premise_holds": true, "refined": true }
```

- Set `premise_holds` to `false` when the premise does not hold (step 3), and add
  `"reason": "<why, in one line>"`. `bl refine` then sets the feature's status to draft.
- Set `refined` to `true` when the feature is ready for `bl approve {{featureId}}`. With
  `premise_holds: true`, `bl refine` then sets the feature's status to refined.
- Set `refined` to `false` when it is not, for example while an open question blocks the story
  cut, and add `"reason"`. `bl refine` prints the reason and leaves the status as it is.

`bl refine` reads the file when the session ends. If the file is missing or does not match this
shape, `bl refine` changes no status.
