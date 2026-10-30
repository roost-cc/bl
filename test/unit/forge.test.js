/**
 * Unit tests for the forge ops (F-42 D4): `runForgeOp` (S-441), the
 * `FORGE_OPS` set and `findChange`, the shipped `templates/forge-github.json`,
 * `bl validate`'s forge rules, and the forge's (absent) contribution to
 * `generateAllowedTools`.
 *
 * Tests use real fake commands (`echo`, `node -e`, missing binary) rather
 * than mocking spawn, so the contract is exercised end-to-end against
 * `child_process.spawnSync`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runForgeOp, findChange, FORGE_OPS, BODY_READING_OP } from '../../src/config.js';
import { generateAllowedTools } from '../../src/allowed-tools.js';
import { findForgeFindings } from '../../src/validate.js';
import { mkTempDir } from '../helpers/tempdir.js';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'forge-github.json');

function fakeConfig({ forge, plugins } = {}) {
  return {
    raw: {
      ...(forge ? { forge } : {}),
      plugins: plugins ?? {},
    },
    plugins: plugins ?? {},
  };
}

function tmpRepo() {
  return mkTempDir('bl-forge-');
}

// ---------------------------------------------------------------------------
// The op set
// ---------------------------------------------------------------------------

test("FORGE_OPS is the D4 op set with each op's variables", () => {
  assert.deepEqual(FORGE_OPS, {
    'change.open': ['title', 'body'],
    'change.describe': ['number', 'body'],
    'change.find': ['branch'],
    'change.close': ['number', 'comment'],
    'change.ready': ['number'],
    'update.notes': ['number'],
  });
  assert.equal(BODY_READING_OP, 'update.notes');
});

test('templates/forge-github.json holds exactly the D4 ops, each using only its variables', () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  assert.deepEqual(Object.keys(tpl).sort(), Object.keys(FORGE_OPS).sort());
  assert.equal(
    tpl['change.find'],
    'gh pr list --head {{branch}} --state all --json number,url,state,headRefOid,labels --limit 1',
  );
  for (const [op, cmd] of Object.entries(tpl)) {
    const used = [...cmd.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(used, [...FORGE_OPS[op]].sort(), `${op} uses ${used}`);
  }
  // The template passes bl validate's forge rules.
  assert.deepEqual(findForgeFindings({ topLevel: { forge: 'github', plugins: { github: tpl } } }), []);
});

// ---------------------------------------------------------------------------
// runForgeOp
// ---------------------------------------------------------------------------

test('runForgeOp: GitHub config returns { stdout, status } and substitutes vars', () => {
  const cfg = fakeConfig({
    forge: 'github',
    plugins: {
      github: {
        // `echo` is everywhere; assert it interpolates `{{branch}}` and
        // captures stdout we can JSON.parse.
        'change.find': 'echo \'[{"number":42,"head":"{{branch}}"}]\'',
      },
    },
  });
  const result = runForgeOp('change.find', { branch: 's99-foo' }, { config: cfg, repoPath: tmpRepo() });
  assert.equal(result.configured, true);
  assert.equal(result.status, 0);
  const prs = JSON.parse(result.stdout);
  assert.deepEqual(prs, [{ number: 42, head: 's99-foo' }]);
  assert.ok(result.repoName);
  assert.ok(result.repoPath);
});

test('runForgeOp: change.open gets the title and body as single arguments', () => {
  const repoPath = tmpRepo();
  const shimPath = join(repoPath, 'forge-shim.mjs');
  writeFileSync(
    shimPath,
    `import { writeFileSync } from "fs";
writeFileSync(1, JSON.stringify(process.argv.slice(2)));
`,
  );
  const cfg = fakeConfig({
    forge: 'github',
    plugins: { github: { 'change.open': `node ${shimPath} --title {{title}} --body {{body}}` } },
  });
  const body = 'Line one with \'quotes\' and "doubles".\n\nFeature file: features/F1-x/index.md';
  const result = runForgeOp(
    'change.open',
    { title: 'F-1: A title; with $(touch pwned)', body },
    { config: cfg, repoPath },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['--title', 'F-1: A title; with $(touch pwned)', '--body', body]);
});

test("runForgeOp: $' $` $& in a value are passed through literally, still quoted", () => {
  const repoPath = tmpRepo();
  const shimPath = join(repoPath, 'forge-shim.mjs');
  writeFileSync(
    shimPath,
    `import { writeFileSync } from "fs";
writeFileSync(1, JSON.stringify(process.argv.slice(2)));
`,
  );
  const cfg = fakeConfig({
    forge: 'github',
    plugins: {
      github: {
        'change.find': `node ${shimPath} --head {{branch}} --state all`,
      },
    },
  });
  const branch = "a$'b$`c$&d$(touch pwned)";
  const result = runForgeOp('change.find', { branch }, { config: cfg, repoPath });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['--head', branch, '--state', 'all']);
});

test("runForgeOp: no forge key (forge: none) returns 'no-forge' and warns nothing", () => {
  const cfg = fakeConfig({ plugins: { github: { 'change.close': 'echo ok' } } });
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return true;
  };
  let result;
  try {
    for (const op of Object.keys(FORGE_OPS)) {
      result = runForgeOp(op, {}, { config: cfg, repoPath: tmpRepo() });
      assert.equal(result.configured, false);
      assert.equal(result.reason, 'no-forge');
    }
  } finally {
    process.stderr.write = orig;
  }
  assert.deepEqual(writes, [], 'no warning per op');
});

test("runForgeOp: forge name pointing to absent plugin returns 'no-plugin'", () => {
  const cfg = fakeConfig({ forge: 'gitlab', plugins: { github: {} } });
  const result = runForgeOp('change.close', {}, { config: cfg, repoPath: tmpRepo() });
  assert.equal(result.configured, false);
  assert.equal(result.reason, 'no-plugin');
});

test("runForgeOp: an op the plugin lacks returns 'no-op' rather than throwing", () => {
  const cfg = fakeConfig({
    forge: 'github',
    plugins: { github: { 'change.find': 'echo []' } },
  });
  const result = runForgeOp('change.open', {}, { config: cfg, repoPath: tmpRepo() });
  assert.equal(result.configured, false);
  assert.equal(result.reason, 'no-op');
});

test("runForgeOp: declared op with absent binary returns 'missing-binary'", () => {
  const cfg = fakeConfig({
    forge: 'github',
    plugins: {
      github: {
        'change.close': 'definitely-not-a-real-binary-xyz123 --foo',
      },
    },
  });
  const result = runForgeOp('change.close', {}, { config: cfg, repoPath: tmpRepo() });
  assert.equal(result.configured, false);
  assert.equal(result.reason, 'missing-binary');
});

test('runForgeOp: repoPath is required', () => {
  const cfg = fakeConfig({
    forge: 'github',
    plugins: { github: { 'change.close': 'echo ok' } },
  });
  assert.throws(() => runForgeOp('change.close', {}, { config: cfg }), /repoPath is required/);
});

test('runForgeOp: repoName is derived from repoPath', () => {
  const cfg = fakeConfig({
    forge: 'github',
    plugins: { github: { 'change.close': 'echo ok' } },
  });
  const repoPath = tmpRepo();
  const result = runForgeOp('change.close', {}, { config: cfg, repoPath });
  assert.equal(result.repoPath, repoPath);
  // basename of a tmp dir
  assert.ok(result.repoName);
  assert.ok(repoPath.endsWith(result.repoName));
});

// ---------------------------------------------------------------------------
// findChange
// ---------------------------------------------------------------------------

/** A runOp answering `change.find` with `res`, recording each call. */
function stubFind(res) {
  const calls = [];
  const runOp = (op, vars, opts) => {
    calls.push({ op, vars, repoPath: opts.repoPath });
    return res;
  };
  return { calls, runOp };
}

test("findChange: lists the branch's PRs with the state upper-cased", () => {
  const { calls, runOp } = stubFind({
    configured: true,
    status: 0,
    stdout: JSON.stringify([
      { number: 5, url: 'u5', state: 'merged', headRefOid: 'abc', labels: [{ name: 'security' }] },
    ]),
  });
  const out = findChange('s1-x', { config: {}, repoPath: '/r', runOp });
  assert.deepEqual(calls, [{ op: 'change.find', vars: { branch: 's1-x' }, repoPath: '/r' }]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.prs, [
    { number: 5, url: 'u5', state: 'MERGED', headRefOid: 'abc', labels: [{ name: 'security' }] },
  ]);
});

test('findChange: a PR without a state (a template that lists open PRs only) counts as OPEN', () => {
  const { runOp } = stubFind({ configured: true, status: 0, stdout: '[{"number":3,"url":"u"}]' });
  assert.deepEqual(findChange('b', { config: {}, repoPath: '/r', runOp }).prs, [
    { number: 3, url: 'u', state: 'OPEN' },
  ]);
});

test('findChange: an empty list is success', () => {
  const { runOp } = stubFind({ configured: true, status: 0, stdout: '[]' });
  assert.deepEqual(findChange('b', { config: {}, repoPath: '/r', runOp }), { ok: true, prs: [] });
});

test('findChange: forge sentinels, failures and bad output never throw', () => {
  const cases = [
    [
      { configured: false, reason: 'no-forge' },
      { ok: false, configured: false, reason: 'no-forge' },
    ],
    [
      { configured: false, reason: 'no-op' },
      { ok: false, configured: false, reason: 'no-op' },
    ],
    [
      { configured: true, status: 1, stderr: 'HTTP 502\n' },
      { ok: false, configured: true, reason: 'failed', error: 'HTTP 502' },
    ],
    [
      { configured: true, status: 0, stdout: 'not json' },
      { ok: false, configured: true, reason: 'unparseable' },
    ],
    [
      { configured: true, status: 0, stdout: '{"number":1}' },
      { ok: false, configured: true, reason: 'unparseable' },
    ],
  ];
  for (const [res, want] of cases) {
    assert.deepEqual(
      findChange('b', { config: {}, repoPath: '/r', runOp: stubFind(res).runOp }),
      want,
      JSON.stringify(res),
    );
  }
  const throwing = () => {
    throw new Error('boom');
  };
  assert.deepEqual(findChange('b', { config: {}, repoPath: '/r', runOp: throwing }), {
    ok: false,
    configured: false,
    reason: 'spawn-error',
    error: 'boom',
  });
});

test('findChange: runs the configured change.find for real, entries without a number dropped', () => {
  const cfg = fakeConfig({
    forge: 'github',
    plugins: {
      github: { 'change.find': `test {{branch}} = f1-x && echo '[{"number":8,"state":"CLOSED"},{"url":"x"},null]'` },
    },
  });
  assert.deepEqual(findChange('f1-x', { config: cfg, repoPath: tmpRepo() }), {
    ok: true,
    prs: [{ number: 8, state: 'CLOSED' }],
  });
});

// ---------------------------------------------------------------------------
// bl validate: the forge plugin
// ---------------------------------------------------------------------------

const codes = (findings) => findings.map((f) => f.code);

test('validate: no forge key (forge: none) has nothing to check', () => {
  assert.deepEqual(findForgeFindings({ topLevel: { plugins: { github: { 'pr.create': 'gh pr create' } } } }), []);
});

test('validate: a forge op outside the D4 set fails', () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const out = findForgeFindings({
    topLevel: {
      forge: 'github',
      plugins: { github: { ...tpl, 'pr.create': 'gh pr create', 'run.list': 'gh run list' } },
    },
  });
  assert.deepEqual(codes(out), ['forge-op', 'forge-op']);
  assert.ok(out.every((f) => f.severity === 'error' && f.location === 'backlog.json'));
  assert.match(out[0].message, /"pr\.create" is not a forge op/);
  assert.match(out[1].message, /"run\.list" is not a forge op/);
});

test('findForgeFindings rejects each missing required forge op', () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const check = (github) => findForgeFindings({ topLevel: { forge: 'github', plugins: { github } } });
  for (const op of Object.keys(FORGE_OPS)) {
    const { [op]: _, ...rest } = tpl;
    const out = check(rest);
    assert.deepEqual(codes(out), ['forge-op'], op);
    assert.match(out[0].message, new RegExp(`"${op.replace('.', '\\.')}" is missing`));
    // Not a command string: a number, an object, null, an empty string.
    for (const bad of [1, { cmd: 'gh' }, null, ' ']) {
      const o = check({ ...tpl, [op]: bad });
      assert.deepEqual(codes(o), ['forge-op'], `${op}=${JSON.stringify(bad)}`);
      assert.match(o[0].message, /must be a command string/);
    }
  }
  // Only change.open: the other five are each reported.
  assert.deepEqual(codes(check({ 'change.open': tpl['change.open'] })), Array(5).fill('forge-op'));
  assert.deepEqual(codes(check({})), Array(6).fill('forge-op'));
});

test('validate: only update.notes may read a PR body or comments', () => {
  const readers = {
    'change.find': 'gh pr list --head {{branch}} --json number,body',
    'change.describe': 'gh pr view {{number}} && gh pr edit {{number}} --body {{body}}',
    'change.close': 'gh pr view {{number}} --comments; gh pr close {{number}}',
    'change.ready': 'gh pr ready {{number}}',
    'change.open': 'gh pr create --title {{title}} --body {{body}} --json=comments',
    'update.notes': 'gh pr view {{number}} --json body --jq .body',
  };
  const out = findForgeFindings({ topLevel: { forge: 'github', plugins: { github: readers } } });
  assert.deepEqual(codes(out), Array(4).fill('forge-op-reads-body'));
  assert.ok(!out.some((f) => f.message.includes('"update.notes"')));
  // Writing a body is not reading one.
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  assert.deepEqual(
    findForgeFindings({
      topLevel: {
        forge: 'github',
        plugins: { github: { ...tpl, 'change.describe': 'gh pr edit {{number}} --body {{body}}' } },
      },
    }),
    [],
  );
});

test('validate: forge naming no plugin, or not a string, fails', () => {
  assert.deepEqual(codes(findForgeFindings({ topLevel: { forge: 'gitlab', plugins: {} } })), ['forge-plugin']);
  assert.deepEqual(codes(findForgeFindings({ topLevel: { forge: { name: 'github' } } })), ['forge-plugin']);
});

// ---------------------------------------------------------------------------
// generateAllowedTools: the forge contributes nothing (F-42 D4)
// ---------------------------------------------------------------------------

test('generateAllowedTools: the forge plugin grants no mode a forge command', () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const cfg = { raw: { forge: 'github', plugins: { github: tpl } }, plugins: {} };
  const out = generateAllowedTools(cfg);
  for (const mode of ['workon', 'review', 'refine', 'triage']) {
    assert.ok(!out[mode].some((t) => t.startsWith('gh ')), `${mode}: ${out[mode]}`);
  }
  assert.deepEqual(out.workon, []);
  assert.deepEqual(out.review, []);
  // The review denials stay.
  assert.deepEqual(out.deny.review, ['bl block remove:*', 'bl task done:*', 'gh pr merge:*', 'git push:*']);
});

test("generateAllowedTools: a non-forge plugin still contributes its leader; the forge plugin's does not", () => {
  const cfg = {
    raw: {
      forge: 'glab',
      plugins: {
        glab: { 'change.find': 'glab mr list --source-branch {{branch}}' },
        lint: { lint: 'shellcheck {{path}}' },
      },
    },
    plugins: {},
  };
  const out = generateAllowedTools(cfg);
  assert.ok(out.base.includes('shellcheck:*'));
  assert.ok(!out.base.includes('glab:*'));
});

test('generateAllowedTools: review mode carries no gh api:* even without forge config', () => {
  const cfg = { raw: {}, plugins: {} };
  const out = generateAllowedTools(cfg);
  assert.ok(!out.review.includes('gh api:*'), 'MODE_DEFAULTS.review must not include gh api:* anymore');
});
