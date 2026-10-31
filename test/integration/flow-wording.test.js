/**
 * Counts, refusals and help name the statuses they actually accept or exclude:
 * flow.json's, so a custom status shows up, and the shipped wording stands on
 * the template flow.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { storyMoveRefusal } from '../../src/feature.js';
import { Flow, loadFlow, statusWords } from '../../src/flow.js';
import { buildHistory } from '../../src/history.js';
import { moveRefusal } from '../../src/move.js';
import { buildReport, renderMarkdown } from '../../src/report.js';
import { selectStories } from '../../src/updates-run.js';
import { runBl } from '../helpers/run-bl.js';
import { commitAt, committedBacklog, put, story } from '../helpers/scripted-backlog.js';
import { FLOW_TEMPLATE } from '../helpers/tempdir.js';

/** The template with a closed status, a runnable one and an unstarted one. */
function customFlow() {
  const raw = JSON.parse(readFileSync(FLOW_TEMPLATE, 'utf8'));
  const { statuses } = raw.types.story;
  statuses.parked = { implies: ['backlog'] };
  statuses.in_review = { implies: ['in_progress', 'refined', 'backlog'] };
  statuses.closed_early = { implies: ['done', 'in_progress', 'refined', 'backlog'] };
  raw.types.feature.statuses.cancelled = {
    implies: ['done', 'escalated', 'running', 'approved', 'refined', 'draft'],
  };
  return raw;
}

const CLOSED = { shipped: 'done or superseded', custom: 'done, superseded or closed_early' };
const CLOSED_SLASHED = { shipped: 'done/superseded', custom: 'done/superseded/closed_early' };
const CLOSED_FEATURES = { shipped: 'done or superseded', custom: 'done, superseded or cancelled' };
const RUNNABLE = { shipped: 'refined or in_progress', custom: 'refined, in_progress or in_review' };
const UNSTARTED = { shipped: 'backlog or refined', custom: 'backlog, refined or parked' };

const flows = [
  ['shipped', () => undefined],
  ['custom', customFlow],
];

test('statusWords joins one, two and more names', () => {
  assert.equal(statusWords([]), '(none)');
  assert.equal(statusWords(['a']), 'a');
  assert.equal(statusWords(['a', 'b']), 'a or b');
  assert.equal(statusWords(['a', 'b', 'c'], 'and'), 'a, b and c');
});

test('flow_derived_diagnostics_match_decisions', () => {
  for (const [name, raw] of flows) {
    const dir = committedBacklog([['S-1', 'backlog']], raw());
    const flow = loadFlow(dir);
    const config = loadConfig({ backlogRoot: dir });
    const page = renderMarkdown(buildReport(buildHistory(config), config, flow), {}, flow);
    const quoted = RUNNABLE[name].replace(/[a-z_]+(?<!or)\b/g, (s) => `\`${s}\``);
    assert.ok(page.includes(`- Open (not ${CLOSED[name]}): `), `${name}: Summary`);
    assert.ok(page.includes(`first snapshot showing ${quoted}.`), `${name}: cycle time`);
    assert.ok(page.includes(`No story is ${quoted}.`), `${name}: empty ages`);

    const sync = runBl(['sync'], { cwd: dir });
    assert.ok(sync.stderr.includes(`0 ${CLOSED_SLASHED[name]})`) || sync.stdout.includes(`0 ${CLOSED_SLASHED[name]})`));

    const fm = { status: 'done' };
    assert.equal(
      moveRefusal({ id: 'S-2', fm, fromRepo: 'a', to: 'C01', toRepo: 'a', features: [], flow }),
      `S-2 is done; only a ${UNSTARTED[name]} story moves to another component.`,
    );
    assert.equal(
      storyMoveRefusal('S-2', fm, 'F-1', flow),
      `S-2 is done; only a ${UNSTARTED[name]} story moves into a feature.`,
    );
    assert.throws(
      () => selectStories([{ id: 'S-2', fm }], ['S-2'], flow),
      new RegExp(`only a ${RUNNABLE[name]} story runs$`),
    );
  }
});

test('bl_run_refusal_names_custom_status_keys_exactly', () => {
  const withPlainKey = () => {
    const raw = customFlow();
    raw.types.story.statuses.qa = { implies: ['in_progress', 'refined', 'backlog'] };
    return raw;
  };
  const cases = [
    ['shipped', () => undefined, 'refined or in-progress'],
    ['underscore key', customFlow, 'refined, in-progress or in_review'],
    ['plain key too', withPlainKey, 'refined, in-progress, in_review or qa'],
  ];
  for (const [name, raw, wanted] of cases) {
    const dir = committedBacklog([['S-1', 'done']], raw());
    put(dir, 'stories/S1-x/index.md', story('S-1', { status: 'done', points: 2, added: '2026-04-01', feature: '' }));
    commitAt(dir, '2026-04-22T09:00:00', 'no feature');
    const r = runBl(['run', 'S-1'], { cwd: dir });
    assert.notEqual(r.status, 0, name);
    assert.ok(r.stderr.includes(`Story S-1 is done — only a ${wanted} story runs.\n`), `${name}: ${r.stderr}`);
  }
});

test('help words its status lists from the flow, and from the template outside a backlog', () => {
  const dir = (raw) => committedBacklog([['S-1', 'backlog']], raw);
  const closedQuoted = { shipped: '`done` and\n`superseded`', custom: '`done`, `superseded` and\n`closed_early`' };
  const cases = (name) => [
    [['--help'], `a story not ${UNSTARTED[name].replace(/, | or /g, '/')}, and a`],
    [['tree', '--help'], `every story is ${CLOSED_SLASHED[name]}`],
    [['deps', '--help'], closedQuoted[name]],
    [['next', '--help'], `is not ${CLOSED_FEATURES[name]} and`],
    [['attach', '--help'], `a feature that is ${CLOSED_FEATURES[name]}`],
    [['attach', '--help'], `a story that is not ${UNSTARTED[name]}`],
    [['move', '--help'], `a story that is not ${UNSTARTED[name]}`],
    [['updates', '--help'], `status lists every ${RUNNABLE[name]} update story`],
  ];
  for (const [name, raw] of flows) {
    const cwd = dir(raw());
    for (const [args, wanted] of cases(name)) {
      const r = runBl(args, { cwd });
      assert.equal(r.status, 0, args.join(' '));
      assert.ok(r.stdout.includes(wanted), `${name} ${args.join(' ')}: ${wanted}`);
    }
  }
  // No flow.json to read: help still prints, in the template's words.
  const bare = committedBacklog([], null);
  const r = runBl(['tree', '--help'], { cwd: bare });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('every story is done/superseded'));
});

test('wrapped help keeps its line break on the shipped flow', () => {
  const cwd = committedBacklog([['S-1', 'backlog']]);
  assert.match(runBl(['new', '--help'], { cwd }).stdout, /stories \(backlog or\n {23}refined, in no feature\)/);
  assert.match(
    runBl(['updates', '--help'], { cwd }).stdout,
    /\(else every refined or\n {33}in_progress update story\)/,
  );
});

test('no message in src names a fixed runnable, unstarted or closed set', () => {
  const src = join(import.meta.dirname, '..', '..', 'src');
  for (const file of readdirSync(src).filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(
      readFileSync(join(src, file), 'utf8'),
      /only a (backlog|refined)|.?done.?\/.?superseded|not .?done.? or .?superseded|done and superseded|.?refined.? or\s+.?in.progress|.?backlog.?(\/| or\s+).?refined/,
      file,
    );
  }
});

test('the closed, runnable and unstarted lists agree with the checks, in file order', () => {
  const flow = new Flow('flow.json', customFlow());
  const all = flow.statusesOf('story');
  assert.deepEqual(
    flow.closedStatusesOf('story'),
    all.filter((s) => flow.meets('story', s, 'done')),
  );
  assert.deepEqual(
    flow.runnableStatusesOf('story'),
    all.filter((s) => flow.isRunnable('story', s)),
  );
  assert.deepEqual(
    flow.unstartedStatusesOf('story'),
    all.filter((s) => flow.isUnstarted('story', s)),
  );
});
