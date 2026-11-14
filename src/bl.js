#!/usr/bin/env node
/**
 * bl — unified backlog CLI.
 *
 * Usage:
 *   bl <command> [args...]
 *
 * The backlog repo is discovered by walking up from cwd (or via
 * $BL_BACKLOG_DIR). A story's repo is its component's; list, tree and
 * what-next filter by --theme, --epic, --feature and --component.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { append as logAppend } from './log.js';
import { warn, editorCommand } from './config.js';
import { captureTmuxWindowId, updateTabTitle } from './tab-title.js';
import { flowForHelp } from './flow.js';
import { exitOnSignal } from './signal-exit.js';
import { HELP_WORDS, commandTitle, findCommand } from './command-table.js';

const argv = process.argv.slice(2);

// Grab the window id the moment bl starts, before any async work, so later
// tab titles (tab-title.js) target this window even if the user has switched
// tabs in the meantime.
captureTmuxWindowId();
// Every command names the tab before it does anything else (S-1412): the
// command and the unit ids its arguments name. A command that knows more
// sets its own fields later; the exit sets the end state (`endTabTitle`).
updateTabTitle(commandTitle(argv));
// Ctrl+C and SIGTERM end bl with 130 and 143 through `process.exit`, so its
// `exit` listeners run (signal-exit.js).
exitOnSignal();

const command = argv[0];
const subArgv = argv.slice(1);

function printHelp() {
  const editor = editorCommand();
  const unstarted = flowForHelp().unstartedStatusesOf('story').join('/');
  console.log(`Usage: bl <command> [args...]

Global Options:
  -A, --agent <id>  Specify the agent provider (claude, codex, gemini, local)
  --model <m>       The model of that provider for this command (needs -A)

Commands:
  init       Set up the agent and local files for the backlog repo
  new        Create a new story ([F-id] [C-id] name its feature and component)
               --json         Emit machine-readable JSON to stdout
               --feature      With no F-id: create a feature from S-ids
                              (--theme, --epic: its theme and epic)
               --component    With no C-id: create a component (--repo, --title)
               --theme <slug> On its own: create a theme (--title)
               --epic         With no E-id: create an epic (--theme, --title)
  side       A change to another repo: a story in its component, with its
               worktree and change entry (<repo|C-id> --from <F-n|S-n>
               --title <t> --points <n>); prints S-<n><TAB><worktree>
               --type, --body-file, --json
  attach     Put an existing story in a feature (<S-n> <F-n>, either
               order): sets its feature:, commits
               --no-sync      Write the story, commit nothing
               --json         Print {schema, story, feature, changed}
               Refuses a closed feature, a story in another feature or not
               ${unstarted}, and a repo a started feature does not span
  batch      Build a story batch from refined stories (<S-n> <S-n>…
               --title <t>): approved at once, then one agent session
               checks the stories' file lists and order edges; commits
  move       Move stories to another component (<S-n>… <C-n>, any order):
               sets each story's component:, commits
               --no-sync      Write the stories, commit nothing
               --json         Print {schema, component, moved, unchanged}
               Refuses an unknown id, a story not ${unstarted}, and a
               repo change for a story in a started feature
  task       An action for the operator, with no branch, in tasks/ (F-65)
               <F-n|B-n|S-n> --title <t> --gate <merge|next|none>
                 [--body-file <p>] [--json]  File one; prints T-<n>
               done <T-n> [note]  Close it (operator only)
               list [--open] [<F-n|S-n>]  The tasks
  next-id    Print the next available story, component, epic or task ID
               <story|component|epic|task>  Required positional kind
               --count <n>    Print n consecutive IDs (default 1, max 1000)
  refine     Refine a feature, or stories (a component expands to its backlog
               stories) for implementation
               -P, --prompt <text>  Discuss <text> with the agent first
  approve    Approve a refined feature: the human gate before run
  run        The loop for a feature, a story batch or a story: implement,
               test gate, self-review, PR, review rounds; stops before merge
               --resume, --interactive, --plan, --max-rounds <n>
  implement  Start/resume an interactive session on a story or feature
               worktree: the manual single step
               -P, --prompt <text>  Discuss <text> with the agent first
  review     Review the open PR(s) of a story or feature
               --repo <name>  Feature: restrict the review to one repo's PR
  status     A feature's stories, review state and run state; with no id, the
               open stories by status
  merge      Merge a story or feature: gates, merge, sync, push, remove
               worktrees
               --keep         Keep the branch after merging
  edit       Open a story, component, feature or task file in ${editor}
  view       Open a read-only copy of a story, component, feature or task
               file in ${editor}; the copy is discarded on exit
  change     Open a read-only copy of a story's, feature's or batch's change
               document in ${editor}, as view does
               --open         Print the open items of the latest review session
  which      Print the path to a story, component, feature or task file
  grep       Search story contents, show matches as a table
  list       List backlog stories (-a for all), with a Theme column
               --theme <slug>  Filter to a theme (see Filters below)
               --epic <E-id>   An epic's features, with stories and points done/total
               --feature <F-id>, --component <C-id>  Filter to a feature or component
               --features      List features instead; with a filter, grouped by epic
               --json          The stories with their frontmatter, as JSON
  tree       Show dependency trees from the story edges in blockers.json
               [story-id|component-id]  Limit to trees containing this story, or
                                   trees containing the component's pending stories
               -a, --all       Include trees where every story is done
               --theme, --epic, --feature, --component  Trees containing the
                                   pending stories a filter matches
  history    Daily snapshots of the backlog from git: ISO weeks × points by
               status (backfilled before the first commit)
               --json          Every day's stories and features as JSON
               --since <date>  Only days from YYYY-MM-DD
               --scope <id>    A theme, epic (E<n>), feature (F-<n>) or
                                   component (C<n>)
  report     Write the backlog progress report to reports/ (git-ignored):
               counts, progress tables, charts, throughput, lead and
               cycle time, agent cost and token efficiency
               --out <dir>     Write it there instead
               --since <date>  Only history from YYYY-MM-DD
               --charts <name> The chart adapter (default vega-lite)
               --json          Print data.json and write nothing
  next       Print the next unit (feature or loose story) by priority.yaml,
               hard dependencies first
               --theme <slug>, --epic <E-id>  The first free unit they
                                   match; the matching order goes to stderr
  rank       Change priority.yaml, the one ranked list of units (operator or an
               interactive session only; an edit is refused under BL_HEADLESS)
               <unit> --top|--bottom|--before <unit>|--after <unit>
                                    Place a unit
               <unit> --remove      Take it out of the list
               With no arguments, print the order (the staged order with
               markers while edits are staged)
               Every edit is staged in .bl/priority.staged.yaml
               --commit             Pull, merge the staged edits, take closed
                                    units out, commit and push the file
               --reset              Drop the staged edits
  what-next  Suggest the next story to start by walking the dep graph
               [story-id|component-id]  Story → reference point; component →
                                   pick next startable story inside it
               --theme, --epic, --feature, --component  Pick the next startable
                                   story among those a filter matches
  deps       Ordered work plan for a story's blocking cone, leaf-first
               <story-id>      Required. The story you want to land
  updates    Deprecated (running-man's update job, F-80): Renovate's
               dependency updates as backlog stories
               sync            One story per open Renovate branch, from the
                               per-cycle report (--report <path>, --dry-run)
               run             Rebase, gate and merge the open update
                               stories ([S-id...], --dry-run, --max-merges <n>)
               status          Open update stories by repo and state (--json)
               approve S-<n>   Merge a held story after rerunning the gate
               drop S-<n>      Close the PR and supersede the story (--reason)
  inbox      Everything waiting on you: open escalations, open tasks,
               unmerged work, red updates and the update job's health,
               from its heartbeat (--json)
               done <id>      Closes nothing: names the verb that answers it
  block      Holds between units, in blockers.json (F-66)
               add <blocker> --gate <g> --unit <id|*> --until <status>
               remove <blocker> --gate <g> --unit <id|*>  (operator only)
               list [<id>] [--fix]  Edges on and by a unit, met and unmet
  done       Mark a story as done (a feature is done by merge)
               --superseded   Mark as superseded instead
  force      Move a story, feature or batch to any status (<id> <status>),
               past every transition rule, hold and guard: lists what the
               move skips, then asks for "force <id> to <status>" (operator
               only, in a terminal); commits
  flow       Print each type's transitions from flow.json as a table: from,
               to, verb, guards and gates (bl's template outside a backlog)
  sync       Pull and push the backlog; --commit commits the named paths
  format     Run the configured format plugin per file extension
               --story <id>   Required (or --no-story with explicit paths)
  lint       Run the configured lint plugin per file extension
               --story <id>   Required (or --no-story with explicit paths)
  validate   Run backlog-wide integrity checks
  fix        Apply auto-fixable remediations for validate findings
               --code <code>  Restrict to one finding code
               --theme <slug> Only findings on stories in a theme
               --story <id>   Only findings on this story (repeatable)
               --dry-run      Print planned edits; write nothing
               --json         Emit one JSON object: {fixes, summary}
  log        Show bl activity log
               --all          Logs from all worktrees
  allow      Add permission patterns from agent logs
               --clear        Delete all permission log files
  agents     Print the backlog system reference
  capacity   Whether each agent configuration (agent, review_agent) can take
               work now: state, quota windows, local reset times
               --json         Print {schema: "bl-capacity-json/v1", configurations}
  top        A live view of the runs, the inbox, bl next, capacity and the
               stories done per day: a terminal UI, built with Go on first use
               (--interval <ms>, default 2000)
               --version      Build the view if it needs a build; print its version
               --no-bell, --no-desktop, --no-push
                              The view without the bell, notify-send or the
                              phone push
               --json         Print one snapshot (schema bl-top-json/v1)
               --stream       One snapshot per line until stdin closes
                              (--interval <ms>, default 2000)
  watch      Follow a run's live agent session, step by step
               (<F-id|B-id|S-id>): one line per agent message or tool call
               --from-start   The current session from its beginning
               --json         One JSON object per line
  stop       Stop a running bl run cleanly (<F-id|B-id|S-id>): ends its
               agent session, records "stopped"; bl run <id> --resume
               continues it
  agent      Launch the configured agent with backlog allowed-tools applied
               [args...]      Passthrough args to the agent

refine, approve, run, implement, review, status, merge and done take story
(S-34), feature (F-3) or component (C01) ids and act by the id's kind; run,
implement, review, status and merge also take a story batch (B-2). A story that
belongs to a feature or a batch goes through it. run and implement take one id
(group stories with bl batch); review and merge take several, and merge goes in
dependency order.

Filters (list, tree, what-next): --theme <slug>, --epic <E-id>, --feature <F-id>
and --component <C-id> combine, and every one given must match. A story is in
its feature's theme and epic; a story with no feature is in each theme whose
repos list its component's repo.

Aliases: ls=list, pr=review, s=sync, show=view, claude=agent

Run bl <command> --help for details on a specific command.`);
}

async function run() {
  if (command && command !== 'log' && command !== 'help' && command !== 'next-id' && !command.startsWith('-')) {
    try {
      logAppend(command, subArgv);
    } catch {
      // logging is non-fatal
    }
  }

  // F-80 G3: deprecated, not removed; each subcommand still works. Help
  // keeps stderr empty, as for every verb; its text says it is deprecated.
  if (command === 'updates' && !subArgv.includes('-h') && !subArgv.includes('--help')) {
    warn("bl updates is deprecated: running-man's update job (F-80) does this");
  }

  // Committing commands, `bl inbox` and `bl updates status` rebase the
  // backlog onto origin/main first (F-50 D4), before anything below writes
  // to it; a pull that could not put the checkout back stops the command.
  // `bl init` pulls and settles the directory it writes to, never one the walk finds.
  const initDir = command === 'init' ? (await import('./init.js')).initBacklogDir() : undefined;
  const { commandPullsBacklog } = await import('./backlog-commit.js');
  if (commandPullsBacklog(command, subArgv)) {
    const { loadConfig } = await import('./config.js');
    let config = null;
    try {
      config = initDir ? loadConfig({ backlogRoot: initDir }) : loadConfig();
    } catch {
      // Not in a backlog: the command reports that itself.
    }
    if (config) {
      const { pullBeforeCommand } = await import('./sync.js');
      const pull = await pullBeforeCommand(config);
      if (pull.state === 'unsafe') process.exit(1);
    } else if (initDir) {
      // `bl init` repairs a backlog.json that `loadConfig` rejects (no
      // "repos", no effort levels), so it pulls that backlog first all the
      // same (S-1330). `pullBeforeCommand` skips a backlog with no repo of
      // its own, as for every command.
      if (existsSync(join(initDir, 'backlog.json'))) {
        const { pullBeforeCommand } = await import('./sync.js');
        const pull = await pullBeforeCommand({ backlogRoot: initDir }, { regenerate: false });
        if (pull.state === 'unsafe') process.exit(1);
      }
    }
  }

  // A `bl new --feature` that could not undo its story links left a repair
  // record; settle it before any command reads membership (F-35 Decision K).
  if (command && command !== 'help' && !command.startsWith('-')) {
    const { settlePending } = await import('./feature-links.js');
    await settlePending(initDir);
  }

  if (command === undefined || HELP_WORDS.has(command)) {
    printHelp();
    return;
  }
  const { entry } = findCommand(command);
  if (entry) return entry.run(subArgv);
  console.error(`bl: unknown command '${command}'`);
  console.error("Run 'bl help' for usage.");
  process.exit(1);
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
