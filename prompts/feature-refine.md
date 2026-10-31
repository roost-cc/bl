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

A feature is the unit that gets implemented, reviewed, and merged as one: one
branch, one pull request, one review cycle. Its stories are the ordered plan
and the checklist, not separate deliverables. Your job is to make the feature
ready for that: a premise the operator can approve in five minutes, a design
written once, feature-level acceptance, and a story cut an agent can execute
in order without asking anyone.

## Before the design: the theme brief and the road map

{{readTool}} these before you write any of the design.

- **The feature's theme brief**, the documents its theme names for any work in it:

{{themeBrief}}

- **The road map**, `{{backlogDir}}/roadmap.md`: the future states the project is heading for, the
  directions to them, the hazards on the way (gates such as go-live) and the decisions put off.
  It is direction, not a commitment. Prefer the generic solution an entry points to. Its
  statuses are set by hand and inform; bl never gates on them. When the feature would go against
  an entry (a production deploy while a go-live hazard is not `done`, a residence-only shape where
  an entry says the core stays generic), say so to the operator in the Premise's `Challenged:`
  paragraph and in your reply, and let them decide; do not stop on your own.

## Steps

1. {{readTool}} the feature file. Do not search for it.

2. Explore every repo the work touches (under {{roostDir}}) until you can
   name the files, contracts, and tests involved, and where the system
   already defines each concept the work touches (see **Self-consistent
   designs** below). Ground every claim below in something you read. A
   feature's repos are derived from its stories: a
   story's repo is its component's, and that is what puts the repo in the
   feature, so work in another repo needs a story in a component of that repo
   (one story per repo). bl orders them `bl` first, then by first story in
   dependency order, and the first starts the session and gives the review
   its config. Neither a story nor a feature names a repo: never add
   `primary_repo` or `secondary_repos` to a frontmatter.

3. Write **## Premise**. State the assumption that makes this feature the
   right thing to build and cite the code or evidence it rests on. Then try to
   falsify it: is the requirement really what the feature says, or a derived
   shape that smuggled in a stronger claim (one URL where two mounts would do,
   one flag where a config already exists)? Record the attempt as a paragraph
   starting with `Challenged:` — what you checked and why the premise holds.
   If it does not hold, write that, set `status: draft`, and stop after step
   10; a wrong premise costs a revert later and this paragraph is the cheapest
   place to catch it. Features touching authentication, storage contracts, or a
   cross-service boundary always get this paragraph.

4. Write **## Goal**, **## Design**, and **## Out of Scope**. Design is written
   once, here: decisions, rejected alternatives, and the contracts the stories
   implement. Stories reference this section; they never restate it.

5. Write **## Acceptance**: feature-level outcomes, each observable on the
   merged result rather than on one story in isolation.

6. Cut the stories. Rules:
   - 2 to 5 points each; never 1. Fold small work into a sibling.
   - {{pointsMin}} to {{pointsMax}} points in total. Above that, split the
     feature; below that, ask whether it is a feature at all.
   - No verification-only stories ("confirm…", "verify…", "re-run…").
     Verification is an acceptance criterion of the story that made the change.
   - Each story's Implementation Plan is at most 40 lines and links to the
     Design section instead of repeating it. Write every file path in it in
     backticks (`src/x.js`): when several targets run at once, `bl run` reads
     them to hold back a target that touches the same file as another. A path
     that is not backticked is not seen. It has a `### Sources of truth` part:
     for each concept the story touches, where it is defined and how the code
     reaches it. Paths there are read, not changed, so `bl run` does not hold a
     target back for them.
   - Order matters: declare `depends_on` between stories so `bl implement`
     runs them in sequence. Declare each edge on both sides: `depends_on` on
     the later story and `required_for` on the earlier one. `bl new --from`
     does not add the reverse edge, and `bl validate` reports a one-sided edge
     as `asymmetric-dep`.
   - Dependencies outside the feature must already be done, or be pulled into
     the feature. `bl approve` warns and `bl implement` refuses
     otherwise.

   Create them in one call so IDs and cross-references resolve atomically:

   ```
   bl new --from <spec.json>
   ```

   with `"feature": "{{featureId}}"` and the stories' `"component": "C<nn>"`
   at the top level of the spec. A component is a code boundary in one repo,
   and a story's repo is its component's repo. A story that belongs
   in another component (another code boundary, or another repo) sets
   `"component": "C<nn>"` on its own entry. The stories' repos (each one's
   component's repo) are the feature's repos: `bl run` prepares a worktree
   for each and nothing else, so every repo the work changes needs a story
   in one of its components. One story can also be added
   afterwards with `bl new {{featureId}} <C-id> --title … --points …`.
   The schema is in `{{roostDir}}/bl/templates/spec.schema.md`; body files use
   the `story-feature` template (`bl new --print-template story-feature`).
   Every created story is tagged `feature: {{featureId}}` and appended to this
   feature's `stories:` list automatically.

   If stories are already linked (listed above), update or supersede them
   rather than duplicating them.

7. Check the feature's value axis in its frontmatter: `theme: <slug>` names
   the theme it serves (one directory under `themes/`), and `epic: E<nn>`, when
   it belongs to one, an epic under `epics/` in the same theme. Both are set by
   hand; `bl sync` derives the epic's feature list. `bl list --features --theme
   <slug>` shows the theme's epics and features to choose from; when no epic
   fits, leave `epic:` out rather than forcing one. Then set
   `status: refined` in the feature frontmatter.

8. Run `bl validate` and resolve every finding it reports before committing.
   Run `bl fix --story <id>` first for the findings it can repair, with one
   `--story` per story you created or edited (`bl fix --dry-run --story <id>`
   previews). Today that is `asymmetric-dep`: `bl fix` adds each missing
   `depends_on` / `required_for` reverse edge on the other story and lists
   the files it wrote; commit those too in step 10. Never run `bl fix`
   without `--story`: unscoped, it rewrites stories you did not touch. Do not
   edit those lists by hand with `sed` or Edit. Then run `bl sync` so the
   feature's Stories table and the indexes reflect the cut.

9. Format changed markdown with `bl format --no-story <paths>`. Feature files
   are outside story scope, so the `--story` form does not apply to them.

10. Commit to the backlog repo's main branch, by path — nothing after this
    session commits for you. Name every story you created or edited, and every
    story `bl fix` wrote, with its own `--story`:

    ```
    bl sync --commit -m "chore: refine {{featureId}}" --path {{featureRelPath}} --story S-<id> [--story S-<id> …]
    ```

    It takes the backlog lock, regenerates the index files and commits only
    them, the feature file and the story directories, never what another
    session has staged. Never run `git add` or `git commit` in the backlog repo.

## Operator decisions and `## Escalation`

- Record every decision the operator makes during this refine where it
  belongs: a dated bullet in **## Design**, or in **## Premise** when it
  answers a premise challenge, for example
  `**Decision A1 (operator, YYYY-MM-DD):** …`.
- A question that is still undecided goes in an **## Open Questions** section,
  each with your recommendation.
- **## Escalation** is only for a blocker that must stop `bl run`
  until the operator acts. A refine normally leaves it exactly `None.`. Once
  something is decided, never note it as "resolved" in **## Escalation**; set
  the section back to `None.`.
- Any other text in **## Escalation** blocks `bl run`, and
  `bl approve` refuses the feature.

{{selfConsistencyGuide}}

{{sideChangeGuide}}

{{toolGuide}}

## IMPORTANT

- Do NOT implement anything. Refine and plan only.
- The operator approves the feature after this session with
  `bl approve {{featureId}}`. Write for that reader.
- The tool guide's `--story {{featureId}}` convention is for stories; for this
  feature use `bl format --no-story <paths>` and the verbs with `{{featureId}}`.
