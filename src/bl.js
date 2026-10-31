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

import { append as logAppend } from './log.js';
import { info, captureTmuxWindowId, editorCommand, openTmuxWindow } from './config.js';

// Grab the window id the moment bl starts, before any async work, so later
// `tmux rename-window` calls target this window even if the user has switched
// tabs in the meantime.
captureTmuxWindowId();

const argv = process.argv.slice(2);
const command = argv[0];
const subArgv = argv.slice(1);

function printHelp() {
  const editor = editorCommand();
  console.log(`Usage: bl <command> [args...]

Global Options:
  -A, --agent <id>  Specify the agent provider (claude, codex, gemini)

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
  attach     List an existing story in a feature (<S-n> <F-n>, either
               order): sets its feature:, appends it to stories:, commits
               --no-sync      Write both files, commit nothing
               --json         Print {schema, story, feature, changed}
               Refuses a closed feature, a story in another feature or not
               backlog/refined, and a repo a running feature does not span
  move       Move stories to another component (<S-n>… <C-n>, any order):
               sets each story's component:, commits
               --no-sync      Write the stories, commit nothing
               --json         Print {schema, component, moved, unchanged}
               Refuses an unknown id, a story not backlog/refined, and a
               repo change for a story in a running or escalated feature
  task       An action for the operator, with no branch, in tasks/ (F-65)
               <F-n|S-n> --title <t> --gate <merge|next|none>
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
  run        The loop for a feature: implement, test gate, self-review, PR,
               review rounds; stops before merge
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
  which      Print the path to a story, component, feature or task file
  grep       Search story contents, show matches as a table
  list       List backlog stories (-a for all), with a Theme column
               --theme <slug>  Filter to a theme (see Filters below)
               --epic <E-id>   An epic's features, with stories and points done/total
               --feature <F-id>, --component <C-id>  Filter to a feature or component
               --features      List features instead; with a filter, grouped by epic
  tree       Show dependency trees from depends_on/required_for frontmatter
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
  next       Print the next feature by the feature order (feature-order.md)
               --theme <slug>, --epic <E-id>  The first ranked feature they
                                   match; the matching list goes to stderr
  what-next  Suggest the next story to start by walking the dep graph
               [story-id|component-id]  Story → reference point; component →
                                   pick next startable story inside it
               --theme, --epic, --feature, --component  Pick the next startable
                                   story among those a filter matches
  deps       Ordered work plan for a story's blocking cone, leaf-first
               <story-id>      Required. The story you want to land
  updates    Renovate's dependency updates as backlog stories
               sync            One story per open Renovate branch, from the
                               per-cycle report (--report <path>, --dry-run)
               run             Rebase, gate and merge the open update
                               stories ([S-id...], --dry-run, --max-merges <n>)
               status          Open update stories by repo and state (--json)
               approve S-<n>   Merge a held story after rerunning the gate
               drop S-<n>      Close the PR and supersede the story (--reason)
  inbox      Everything waiting on you: open escalations, operator
               tasks not marked → Done, update stories that need a
               decision (--json)
               done <id> [note]  Mark an operator task done
  block      Holds between units, in blockers.json (F-66)
               add <blocker> --gate <g> --unit <id|*> --until <status>
               remove <blocker> --gate <g> --unit <id|*>  (operator only)
               list [<id>] [--fix]  Edges on and by a unit, met and unmet
  done       Mark a story as done (a feature is done by merge)
               --superseded   Mark as superseded instead
  sync       Regenerate backlog index files (all levels)
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
  agent      Launch the configured agent with backlog allowed-tools applied
               [args...]      Passthrough args to the agent

refine, approve, run, implement, review, status, merge and done take story
(S-34), feature (F-3) or component (C01) ids and act by the id's kind. A story that
belongs to a feature goes through its feature. Given several ids, run and
implement start the independent ones and list the targets that depend on or
overlap another first; merge goes in dependency order.

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

  // Committing commands, `bl inbox` and `bl updates status` rebase the
  // backlog onto origin/main first (F-50 D4), before anything below writes
  // to it; a pull that could not put the checkout back stops the command.
  const { commandPullsBacklog } = await import('./backlog-commit.js');
  if (commandPullsBacklog(command, subArgv)) {
    const { loadConfig } = await import('./config.js');
    let config = null;
    try {
      config = loadConfig();
    } catch {
      // Not in a backlog: the command reports that itself.
    }
    if (config) {
      const { pullBeforeCommand } = await import('./sync.js');
      const pull = await pullBeforeCommand(config);
      if (pull.state === 'unsafe') process.exit(1);
    }
  }

  // A `bl new --feature` that could not undo its story links left a repair
  // record; settle it before any command reads membership (F-35 Decision K).
  if (command && command !== 'help' && !command.startsWith('-')) {
    const { settlePending } = await import('./feature-links.js');
    await settlePending();
  }

  switch (command) {
    case 'init': {
      const { main } = await import('./init.js');
      return main(subArgv);
    }
    case 'new': {
      const { main } = await import('./new.js');
      return main(subArgv);
    }
    case 'next-id': {
      const { main } = await import('./next-id.js');
      return main(subArgv);
    }
    case 'side': {
      const { main } = await import('./side.js');
      return main(subArgv);
    }
    case 'attach': {
      const { main } = await import('./attach.js');
      return main(subArgv);
    }
    case 'move': {
      const { main } = await import('./move.js');
      return main(subArgv);
    }
    case 'task': {
      const { main } = await import('./task.js');
      return main(subArgv);
    }
    case 'run':
    case 'implement':
    case 'merge':
    case 'status':
    case 'approve':
    case 'done': {
      const { dispatch } = await import('./verbs.js');
      return dispatch(command, subArgv);
    }
    case 'refine': {
      const detach = subArgv.includes('-t');
      const filteredArgv = subArgv.filter((a) => a !== '-t');

      if (detach) {
        if (!process.env.TMUX) {
          console.error('bl refine -t requires tmux.');
          process.exit(1);
        }
        const storyArgs = filteredArgv.filter((a) => !a.startsWith('-'));
        const multi = storyArgs.length > 1;
        const windowName = multi ? 'refine batch' : `${storyArgs[0] ?? ''} refine`;
        const target = multi ? storyArgs.join(', ') : (storyArgs[0] ?? '');
        // The detached `bl refine` owns the new window's title.
        openTmuxWindow(windowName, ['refine', ...filteredArgv]);
        info(`Started refine for ${target} in new tmux window.`);
        return;
      }

      const { dispatch } = await import('./verbs.js');
      return dispatch('refine', filteredArgv);
    }
    case 'review':
    case 'pr': {
      const { dispatch } = await import('./verbs.js');
      return dispatch('review', subArgv);
    }
    case 'edit': {
      const { main } = await import('./edit.js');
      return main(subArgv);
    }
    case 'view':
    case 'show': {
      const { main } = await import('./view.js');
      return main(subArgv);
    }
    case 'which': {
      const { main } = await import('./which.js');
      return main(subArgv);
    }
    case 'grep': {
      const { main } = await import('./grep.js');
      return main(subArgv);
    }
    case 'list':
    case 'ls': {
      const { main } = await import('./list.js');
      return main(subArgv);
    }
    case 'tree': {
      const { main } = await import('./tree.js');
      return main(subArgv);
    }
    case 'history': {
      const { main } = await import('./history-cmd.js');
      return main(subArgv);
    }
    case 'report': {
      const { main } = await import('./report-cmd.js');
      return main(subArgv);
    }
    case 'what-next': {
      const { main } = await import('./what-next.js');
      return main(subArgv);
    }
    case 'next': {
      const { main } = await import('./next.js');
      return main(subArgv);
    }
    case 'deps': {
      const { main } = await import('./deps.js');
      return main(subArgv);
    }
    case 'updates': {
      const { main } = await import('./updates.js');
      return main(subArgv);
    }
    case 'inbox': {
      const { main } = await import('./inbox.js');
      return main(subArgv);
    }
    case 'block': {
      const { main } = await import('./block.js');
      return main(subArgv);
    }
    case 'sync':
    case 's': {
      const { main } = await import('./sync.js');
      return main(subArgv);
    }
    case 'format': {
      const { main } = await import('./format.js');
      return main(subArgv);
    }
    case 'lint': {
      const { main } = await import('./lint.js');
      return main(subArgv);
    }
    case 'validate': {
      const { main } = await import('./validate.js');
      return main(subArgv);
    }
    case 'fix': {
      const { main } = await import('./fix.js');
      return main(subArgv);
    }
    case 'log': {
      const { main } = await import('./log.js');
      return main(subArgv);
    }
    case 'allow': {
      const { main } = await import('./allow.js');
      return main(subArgv);
    }
    case 'agents': {
      const { main } = await import('./agents.js');
      return main(subArgv);
    }
    case 'capacity': {
      const { main } = await import('./capacity.js');
      return main(subArgv);
    }
    case 'claude':
    case 'agent': {
      const { main } = await import('./agent-run.js');
      return main(subArgv);
    }
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`bl: unknown command '${command}'`);
      console.error("Run 'bl help' for usage.");
      process.exit(1);
  }
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
