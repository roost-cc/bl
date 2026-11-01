/**
 * scripted-backlog.js — a fixture backlog repo with a scripted git history
 * (F-40 D2), shared by the `bl history` and `bl report` tests: a pre-F-49
 * layout with a legacy-dialect title and an unreadable blob, the move to
 * `stories/`, then add, refine, done, re-estimate, supersede and a feature
 * `stories:` change.
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { GIT_ENV } from './git-backlog.js';
import { mkTempBacklog } from './tempdir.js';

export function git(dir, args, env = {}) {
  const r = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Commit everything at `stamp` (an ISO date-time, UTC); returns the sha. */
export function commitAt(dir, stamp, message) {
  git(dir, ['add', '-A']);
  const at = `${stamp}+00:00`;
  git(dir, ['commit', '-q', '--allow-empty', '-m', message], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  return git(dir, ['rev-parse', 'HEAD']);
}

export function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A story file written as the line reader allowed: `title` left unquoted. */
export function story(
  id,
  { title = `Story ${id}`, status = 'backlog', points, added, completed = '', feature = 'F-1', extra = [] },
) {
  return [
    '---',
    'component: C01',
    `story_id: ${id}`,
    `title: ${title}`,
    'type: feature',
    `points: ${points}`,
    `status: ${status}`,
    `added: ${added}`,
    ...(completed ? [`completed: ${completed}`] : []),
    `feature: ${feature}`,
    ...extra,
    '---',
    '',
    `# ${id}`,
    '',
  ].join('\n');
}

export function feature(stories, status = 'running', extra = []) {
  return [
    '---',
    'feature_id: F-1',
    'title: Feature one',
    'theme: demo',
    'epic: E50',
    `status: ${status}`,
    `stories: ${stories}`,
    ...extra,
    '---',
    '',
    '# F-1 · Feature one',
    '',
  ].join('\n');
}

/**
 * A one-commit fixture repo (2026-04-21) holding `stories`, each `[id, status]`
 * at 2 points, under `flow` (`undefined` for the template).
 */
export function committedBacklog(stories, flow) {
  const { dir } = mkTempBacklog({
    flow,
    repos: { 'demo-repo': '../demo-repo' },
    components: [{ id: 'C01', title: 'Core', repo: 'demo-repo', home: true, dirSuffix: 'core' }],
  });
  writeFileSync(join(dir, '.gitignore'), '.bl/\n');
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [id, status] of stories) {
    put(dir, `stories/${id.replace('-', '')}-x/index.md`, story(id, { status, points: 2, added: '2026-04-01' }));
  }
  commitAt(dir, '2026-04-21T09:00:00', 'day 1');
  return dir;
}

const OLD = 'projects/demo/E01-core';
const S1 = { title: 'A: b', points: 3, added: '2026-04-10' };
const S2 = { points: 2, added: '2026-04-15' };
const S4 = { status: 'done', points: 1, added: '2026-04-12', completed: '2026-04-14', feature: 'F-2' };

/** Token fields (S-819) for the cost report: F-1 ran headless in part; S-4 is stand-alone (F-2 does not exist). */
const F1_TOKENS = [
  'tokens_input: 100',
  'tokens_output: 22000',
  'tokens_cache_creation: 3000',
  'tokens_cache_read: 74900',
  'tokens_headless_input: 50',
  'tokens_headless_output: 11000',
  'tokens_headless_cache_creation: 1500',
  'tokens_headless_cache_read: 37450',
  'tokens_updated: 2026-04-28',
];
const S4_TOKENS = [
  'tokens_input: 10',
  'tokens_output: 5000',
  'tokens_cache_creation: 0',
  'tokens_cache_read: 0',
  'tokens_updated: 2026-04-14',
];

/**
 * The fixture repo: four commit days (2026-04-21, -23, -25, -28, the last
 * with two commits) and `shas`, each day's last commit by date.
 */
export function scriptedBacklog() {
  const { dir } = mkTempBacklog({
    repos: { 'demo-repo': '../demo-repo' },
    components: [{ id: 'C01', title: 'Core', repo: 'demo-repo', home: true, dirSuffix: 'core' }],
    valueEpics: [{ id: 'E50', title: 'Epic', dirSuffix: 'epic' }],
  });
  writeFileSync(join(dir, '.gitignore'), '.bl/\n');
  git(dir, ['init', '-q', '-b', 'main']);
  const shas = {};

  // 2026-04-21: the pre-F-49 layout, S-1's title in the legacy dialect, S-4
  // already done under `.completed/`, an index.md no reader can parse, and
  // the feature's `stories:` as the pre-F-62 string.
  put(dir, `${OLD}/S1-a/index.md`, story('S-1', S1));
  put(dir, `${OLD}/S2-b/index.md`, story('S-2', S2));
  put(dir, `${OLD}/.completed/S4-d/index.md`, story('S-4', S4));
  put(dir, `${OLD}/S9-bad/index.md`, '---\nstory_id: S-9\n{ broken\n---\n');
  put(dir, 'projects/demo/features/F1-one/index.md', feature('S-1, S-2', 'draft'));
  shas['2026-04-21'] = commitAt(dir, '2026-04-21T09:00:00', 'day 1');

  // 2026-04-23: the move to stories/ and features/; S-1 refined.
  rmSync(join(dir, 'projects'), { recursive: true });
  put(dir, 'stories/S1-a/index.md', story('S-1', { ...S1, title: '"A: b"', status: 'refined' }));
  put(dir, 'stories/S2-b/index.md', story('S-2', S2));
  put(dir, 'stories/S4-d/index.md', story('S-4', S4));
  put(dir, 'features/F1-one/index.md', feature('[S-1, S-2]'));
  shas['2026-04-23'] = commitAt(dir, '2026-04-23T09:00:00', 'day 2');

  // 2026-04-25: S-3 added; S-2 re-estimated.
  put(dir, 'stories/S3-c/index.md', story('S-3', { points: 8, added: '2026-04-25' }));
  put(dir, 'stories/S2-b/index.md', story('S-2', { ...S2, points: 5 }));
  shas['2026-04-25'] = commitAt(dir, '2026-04-25T09:00:00', 'day 3');

  // 2026-04-28: S-1 in progress, then done later that day; S-2 superseded;
  // the feature drops S-2 and lists S-3.
  put(dir, 'stories/S1-a/index.md', story('S-1', { ...S1, title: '"A: b"', status: 'in_progress' }));
  commitAt(dir, '2026-04-28T08:00:00', 'day 4, morning');
  put(dir, 'stories/S1-a/index.md', story('S-1', { ...S1, title: '"A: b"', status: 'done', completed: '2026-04-28' }));
  put(dir, 'stories/S2-b/index.md', story('S-2', { ...S2, points: 5, status: 'superseded' }));
  put(dir, 'features/F1-one/index.md', feature('[S-1, S-3]', 'running', F1_TOKENS));
  put(dir, 'stories/S4-d/index.md', story('S-4', { ...S4, extra: S4_TOKENS }));
  shas['2026-04-28'] = commitAt(dir, '2026-04-28T17:00:00', 'day 4, evening');
  return { dir, shas };
}
