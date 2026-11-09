import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { loadConfig, parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { findFeature, normalizeFeatureId, resolveFeatureStories, orderStoriesByDeps } from '../../src/feature.js';
import { mkTempBacklog, mkTempDir } from './tempdir.js';
import { parseChange, serializeChange } from '../../src/change-doc.js';
import { storyUnit, storyAsOrdered, unitVars } from '../../src/unit.js';

export const AC_BODY = '## Acceptance Criteria\n\n- [ ] one works\n- [ ] two works\n';

/** What `reviewFeature` returns as `end` for a round-1 `pending` verdict with one Must fix on F-1, cap 2. */
export const PENDING_END = { outcome: '1 open item (1 Must fix)', cap: '', next: 'bl run F-1 --resume' };

function fixture(extra = {}, backlogConfig = null) {
  return mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1', body: AC_BODY },
      {
        id: 'S-2',
        component: 'C00',
        title: 'Second',
        dirSuffix: 'second',
        points: 5,
        feature: 'F-1',
        depends_on: ['S-1'],
        body: AC_BODY,
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1', 'S-2'],
        branch: 'f1-feat',
        ...extra,
      },
    ],
    ...(backlogConfig ? { config: backlogConfig } : {}),
  });
}

/** `backlogConfig` adds top-level keys to the fixture's backlog.json (`{ run: { limit_wait_max_hours: 1 } }`). */
export function setup(extra, backlogConfig = null) {
  const { dir, cleanup } = fixture(extra, backlogConfig);
  const config = loadConfig({ backlogRoot: dir });
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const all = readAllStories(config);
  const ordered = orderStoriesByDeps(resolveFeatureStories(feature, config, all).stories);
  const worktreePath = mkTempDir('bl-wt-');
  const prep = {
    cfg: config,
    parsed: { id: 'F-1', num: '1' },
    worktreePath,
    branchName: 'f1-feat',
    isNewWorktree: false,
    ordered,
    baseVars: {
      featureId: 'F-1',
      storyId: 'F-1',
      title: 'Feat',
      featureRelPath: feature.featureRelPath,
      featureAbsPath: feature.indexPath,
      branchName: 'f1-feat',
      worktreePath,
      prTitle: 'F-1: Feat',
      backlogDir: dir,
      roostDir: config.roostDir,
    },
    reviewPending: false,
    // The lead repo (F-52 D3): the stories' one repo.
    targetRepoName: 'demo-repo',
  };
  return { dir, cleanup, config, feature, prep };
}

/** The unit's change document, beside its index.md. */
export const CH = (unit) => join(dirname(unit.indexPath), 'change.md');

/** Edit a unit file or (by its name) a change document through `fn(fm, body)`. */
export const creates = (runner) => runner.calls.filter((c) => c.type === 'forge' && c.op === 'change.open');

export function editFile(path, fn) {
  if (path.endsWith('change.md')) {
    const doc = parseChange(readFileSync(path, 'utf8'));
    const out = fn(doc.fm, doc.body) ?? doc.body;
    writeFileSync(path, serializeChange({ ...doc, body: out }));
    return;
  }
  const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  const out = fn(fm, body) ?? body;
  writeFileSync(path, serializeFrontmatter(fm) + out);
}

export function checkAll(path) {
  editFile(path, (fm, body) => {
    fm.status = 'in_progress';
    return body.replaceAll('- [ ]', '- [x]');
  });
}

export function writeSession(featurePath, { pending, round }) {
  editFile(featurePath, (fm, body) => {
    fm.review_round = String(round);
    fm.review_status = pending ? 'pending' : 'addressed';
    const block = pending
      ? `### Session 2026-09-24 (PR #7) r${round}\n\n**Must fix**\n\n- [ ] invariant X — Repro: y. Test: z.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n`
      : `### Session 2026-09-24 (PR #7) r${round}\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n`;
    return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
  });
}

/**
 * A fake runner whose `session` simulates the agents by editing files, and
 * whose shell answers git/test commands from a script. Its clock starts at
 * `clock` and advances only through `sleep`, which records each call;
 * `behaviour.limit(o)` returning a refusal object makes the session a
 * usage-limit refusal (`behaviour.onSleep` runs on every sleep slice).
 */
export function fakeRunner({
  dir,
  feature,
  behaviour = {},
  testResults = [],
  clock = Date.parse('2026-10-13T23:59:36Z'),
}) {
  const calls = [];
  let head = 0;
  // What origin/<branch> holds: a push publishes the current head.
  let pushed = -1;
  let round = 0;
  const b = {
    story: (o) => checkAll(o.vars.storyAbsPath),
    verify: () => {
      round += 1;
      writeSession(CH(feature), { pending: round === 1, round });
    },
    fix: () =>
      editFile(CH(feature), (fm, body) => {
        fm.review_status = 'fixed';
        return body.replaceAll('- [ ] invariant', '- [x] invariant');
      }),
    ...behaviour,
  };
  return {
    calls,
    session(o) {
      calls.push({
        type: 'session',
        prompt: o.promptName,
        story: o.vars.storyId,
        mode: o.mode,
        agent: o.agent,
        model: o.model ?? null,
        effort: o.effort ?? null,
        vars: o.vars,
        unitDir: o.unitDir ?? null,
        worktreePath: o.worktreePath,
      });
      // A usage-limit refusal: the agent did nothing (unless `limit` itself did) and said so.
      const limit = b.limit ? b.limit(o) : null;
      if (limit) return { ok: false, output: limit.message, isError: true, usage: null, denials: [], refusal: limit };
      if (o.promptName === 'feature-story' || o.promptName === 'story-run') b.story(o);
      else if (o.promptName.startsWith('review-') && o.promptName !== 'review-verify') {
        writeFileSync(o.vars.findingsPath, `# ${o.vars.dimension}\n\n## Must fix\n\n- x\n`);
        if (b.review) b.review(o);
      } else if (o.promptName === 'review-verify') b.verify(o);
      else if (o.promptName === 'feature-workon-review') b.fix(o);
      else if (o.promptName === 'feature-fix-tests' && b.fixTests) b.fixTests(o);
      else if (o.promptName === 'feature-self-review' && b.selfReview) b.selfReview(o);
      else if (o.promptName === 'feature-fix-self-review' && b.fixSelfReview) b.fixSelfReview(o);
      return {
        ok: true,
        output: b.output ? b.output(o) : '',
        isError: false,
        usage: { input: 1, output: 1, cache_creation: 0, cache_read: 0 },
      };
    },
    shell(cmd, cwd) {
      calls.push({ type: 'shell', cmd, cwd });
      if (b.shell) {
        const r = b.shell(cmd);
        if (r) return r;
      }
      if (cmd.startsWith('git rev-parse HEAD')) return { status: 0, output: `sha${head}\n` };
      if (cmd.startsWith('git push')) {
        pushed = head;
        return { status: 0, output: '' };
      }
      if (cmd.startsWith('git rev-list --count origin/')) {
        return pushed < 0 ? { status: 128, output: 'unknown revision\n' } : { status: 0, output: `${head - pushed}\n` };
      }
      if (cmd.startsWith('git diff --name-only'))
        return { status: 0, output: cmd.includes(' -z ') ? 'src/a.js\0' : 'src/a.js\n' };
      if (cmd === 'npm test') {
        const r = testResults.shift() ?? 0;
        return { status: r, output: r ? '1) fails\nAssertionError: boom\n' : 'ok\n' };
      }
      return { status: 0, output: '' };
    },
    forge(op, vars) {
      calls.push({ type: 'forge', op, vars });
      return { configured: true, status: 0, stdout: 'https://github.com/x/y/pull/7\n' };
    },
    testPlugins() {
      return { plugins: [{ name: 'node', command: 'npm test' }], unknown: [] };
    },
    notify(label) {
      calls.push({ type: 'notify', label });
    },
    log() {},
    now() {
      return new Date(clock);
    },
    sleep(ms) {
      calls.push({ type: 'sleep', ms });
      clock += ms;
      if (b.onSleep) b.onSleep();
    },
    clock() {
      return clock;
    },
    bumpHead() {
      head += 1;
    },
    /** True when origin/<branch> holds the current head. */
    published() {
      return pushed === head;
    },
  };
}

/** Fake `git status --porcelain -z` that reports whichever of `paths` exist under the worktree. */
export function statusOf(wt, paths) {
  return (cmd) => {
    if (!cmd.startsWith('git status --porcelain')) return null;
    return {
      status: 0,
      output: paths
        .filter((p) => existsSync(join(wt, p)))
        .map((p) => `?? ${p}\0`)
        .join(''),
    };
  };
}

/**
 * Wrap a fake runner with a scripted container table. `during` maps a session
 * prompt name to the containers that session "starts".
 */
export function withContainers(runner, { initial = [], during = {} } = {}) {
  let table = [...initial];
  const removed = [];
  return {
    ...runner,
    session(o) {
      const r = runner.session(o);
      for (const c of during[o.promptName] ?? []) table.push(c);
      return r;
    },
    listContainers() {
      return table.map((c) => ({ ...c }));
    },
    removeContainers(ids) {
      removed.push(...ids);
      table = table.filter((c) => !ids.includes(c.id));
      return { status: 0, output: '' };
    },
    removed,
  };
}

export const STORY_BODY =
  '## Summary\n\nDo it.\n\n## Acceptance Criteria\n\n- [ ] one works\n- [ ] two works\n\n## Deferred\n\nNone.\n';

/** A loose refined story S-5 as a unit, with the prep prepareStoryRun returns. */
export function storySetup({ status = 'refined', body = STORY_BODY, effort = undefined } = {}) {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo' }],
    stories: [{ id: 'S-5', component: 'C00', title: 'Loose', dirSuffix: 'loose', points: 3, status, body, effort }],
  });
  const config = loadConfig({ backlogRoot: dir });
  const record = readAllStories(config).find((s) => s.id === 'S-5');
  const unit = storyUnit(record, config);
  const worktreePath = mkTempDir('bl-wt-');
  const prep = {
    cfg: config,
    parsed: { id: 'S-5', num: '5', dirPrefix: 'S5' },
    worktreePath,
    branchName: 's5-loose',
    isNewWorktree: false,
    ordered: [storyAsOrdered(unit)],
    baseVars: {
      featureId: 'S-5',
      storyId: 'S-5',
      title: 'Loose',
      featureRelPath: unit.featureRelPath,
      featureAbsPath: unit.indexPath,
      branchName: 's5-loose',
      worktreePath,
      prTitle: 'S-5: Loose',
      backlogDir: dir,
      roostDir: config.roostDir,
      ...unitVars(unit),
    },
    reviewPending: false,
    targetRepoName: unit.unitRepo,
  };
  return { dir, cleanup, config, unit, prep };
}

export function captureLog(fn) {
  const orig = console.log;
  let out = '';
  console.log = (...a) => {
    out += `${a.join(' ')}\n`;
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

export const F41_LIMIT =
  "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 6:10pm (America/Los_Angeles)";

/** What `parseLimit` would return for the F-41 message, with the reset `minutes` ahead of the fake clock. */
export function spendLimit(runner, { minutes = 30, reset = true } = {}) {
  return {
    kind: 'spend',
    scope: 'model',
    message: F41_LIMIT,
    resetsAt: reset ? new Date(runner.clock() + minutes * 60_000) : null,
  };
}
