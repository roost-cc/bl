# `flow.json`: the workflow format

`flow.json`, at the backlog root, is the backlog's workflow (F-66 D1, F-69 D1, F-119). A backlog
admin owns it and changes it by hand; no command writes it, except `bl init`, which copies bl's
template (`bl/templates/flow.json`) into a backlog that has none. After an edit:

1. Run `bl validate`. Each `flow-json` finding names the fault and ends with a pointer to this
   document.
2. Run `bl flow` to see the transitions bl derives from the file, one table per type. `bl report`
   has the same tables under `## Workflow`.

The file is plain JSON, one object:

```json
{
  "schema": "bl-flow/v2",
  "types": {
    "feature": {
      "statuses": [
        "draft",
        "in_refinement",
        "refined",
        "approved",
        "in_progress",
        "in_review",
        "fixing",
        "ready_for_merge",
        "escalated",
        "done",
        "superseded"
      ],
      "terminal": ["done", "superseded"],
      "verbs": {
        "refine": {
          "from": ["draft", "in_refinement", "refined", "approved"],
          "during": "in_refinement",
          "via": ["refine"],
          "success": [{ "to": "refined" }],
          "failure": [{ "to": "draft" }]
        },
        "run": {
          "from": ["approved", "in_progress", "escalated"],
          "when": ["escalation_cleared"],
          "during": "in_progress",
          "via": ["implement", "test", "self_review", "open_pr"],
          "success": [{ "to": "in_review", "then": "review" }],
          "failure": [{ "to": "escalated" }]
        },
        "review": {
          "from": ["in_progress", "in_review", "ready_for_merge", "escalated"],
          "during": "in_review",
          "via": ["review"],
          "success": [{ "to": "ready_for_merge" }],
          "failure": [{ "when": ["round_within_cap"], "to": "fixing", "then": "fix" }, { "to": "escalated" }]
        },
        "supersede": { "from": "*", "success": [{ "to": "superseded" }] }
      }
    }
  }
}
```

## `schema`

`"bl-flow/v2"`. A `bl-flow/v1` file (statuses with `implies`, no verbs) still loads until
`node bl/scripts/migrate-transitions.js` rewrites it (F-69 D4): bl reads it as its template, and
`bl validate` gives one `flow-json` warning. A `v1` status word maps to its current word: story
`backlog` is `draft`, feature `running` is `in_progress`, task `open` is `draft`.

## Types

`types` holds one workflow per work unit type. Every file has `story`, `feature` and `task`; bl's
template also has `batch` (a story batch). Each type is `{ statuses, terminal, verbs }`, and each
type's workflow is its own: a verb row of one type says nothing about another type.

## Statuses

`statuses` is the type's statuses in lifecycle order; bl reads the first as the status a unit
starts in. A status names a process that works on the unit (`in_refinement`,
`in_review`) or a wait (`refined`, `ready_for_merge`).

**Meets.** A status meets `X` when it is `X` or comes after `X` in `statuses`. bl uses it to ask
"is this unit at least refined?" or "is this unit closed?" (meets `done`). The order decides,
not which statuses a verb can reach: `refine`'s failure branch goes back from `in_refinement` to
`draft`, and a draft unit must not meet `refined`. Terminal statuses come last, so `superseded`
meets `done`, and `escalated` meets `in_progress` but not `done`. A hold's `until` status (see
**Holds** below) is met in the same way.

Every status must be some branch's `to` or some verb's `during`, so that a verb can reach it.

## `terminal`

`terminal` lists the statuses a unit does not leave: `done` and `superseded` in the template.
They come after every open status in `statuses`. Only a `supersede` row may start from one, and
`from: "*"` leaves them out. `bl force` can still move a unit out of one (reopen it).

## Verb rows

`verbs` maps a verb name to its row. A verb is a `bl` command (`bl refine`, `bl run`), or a step
that one chains to (`review`, `fix`). Each row is
`{ from, when?, during?, via?, success?, failure? }`:

- **`from`**: the statuses the verb starts from, or `"*"` for every status that is not terminal.
  `[]` means the verb makes a new unit (`new`). When a row has a `during`, its `from` lists that
  status too, so the verb run again resumes it.
- **`when`**: guards that must hold before the verb starts (see **Guards**).
- **`during`**: the status bl records when the verb starts, while its process works on the unit
  (`refine`: `in_refinement`; `run`: `in_progress`). With no `during`, the unit stays where it is
  until a branch moves it.
- **`via`**: the capabilities the verb runs, in order: the steps in `bl/src/capabilities.js`
  (`VIA_CAPABILITIES`). A verb with no `via` is a move that runs no step (`approve`, `done`).
- **`success`** and **`failure`**: the branches for each outcome.

bl also has verbs of its own that the file does not list: `force` moves a unit from any status
to any status (F-119 D2), and `status` only reads a unit. `bl validate` reports a verb that bl
dispatches for a type when the type's table lacks it.

## Branches

A branch is `{ when?, to, then? }`. bl tries a verb's branches for its outcome in order and takes
the first whose `when` guards all hold:

- **`to`**: the status the unit goes to.
- **`when`**: guards for this branch. The last branch of a list has no `when`, so some branch
  always holds.
- **`then`**: a verb to chain to. It must be a verb of the type that starts from the branch's
  `to`; `run` goes on to `review`, and `review`'s failure goes on to `fix`.

## Transitions

A transition changes a unit from one status to another. bl derives the transitions from the verb
rows (`bl flow` prints them):

1. From each `from` status to the `during` status, unless they are the same.
2. To each branch's `to`: from the `during` status when the verb has one, else from each `from`
   status. A `new` row's transitions have no from status.

A unit moves only along a transition of its type, and the transition log records the verb as
`by`. `bl force` is the one way past them (F-119 D1, D2).

## Guards

A guard is the name of a check in `bl/src/guards.js` (`GUARDS`), with an optional argument after
a colon:

- `escalation_cleared`: the unit's `## Escalation` is `None.`.
- `round_within_cap`: the review round is not over the unit's cap.
- `gate_free:<status>`: no hold keeps the unit out of the status. The old gate names `run` and
  `merge` read as `in_progress` and `done`. bl's template names it nowhere, because every verb
  checks its holds when it starts (see **Holds and the nominal path**); a file from before
  F-119 that names it still loads.

`bl validate` reports a guard name that bl does not register.

## Holds and the nominal path

Every status of a type can be held. A hold is an edge in `blockers.json` (`bl block add`): a unit
cannot enter status A until another unit meets status B (F-119 D4). The file has no gates of its
own; a `gates` table from before F-119 still loads, bl does not read it, and `bl validate` warns
on it.

A verb checks its holds when it starts (F-119 D6), on the statuses of its **nominal path**: its
`during`, each `success` branch's `to`, and the same for each verb that a success branch chains
to with `then`, each once. `run`'s nominal path is `in_progress`, `in_review`,
`ready_for_merge`; `refine`'s is `in_refinement`, `refined`. A failure branch is no part of it.
If a hold applies to any of those statuses, the verb refuses to start and names the hold. A hold
added while the verb runs does not stop it. `new` and `side` make a new unit, which no edge can
name yet, so they check no hold.
`bl flow` shows each verb's nominal path in the Gates column.

## The `task` type

A task (F-65 D1) uses `draft` and `done`. A task can block a unit, and a hold can keep a task out
of `done`.
