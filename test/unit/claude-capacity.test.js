import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { ClaudeProvider, LocalProvider, claudeCapacity } from '../../src/agents/claude.js';
import { readClaudeToken } from '../../src/agents/claude-capacity.js';
import { capacityTable } from '../../src/capacity.js';

// S-1143. The cases that read a local HTTP server through the helper are in
// test/integration/claude-capacity.test.js.

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/claude-usage/${name}.json`, import.meta.url), 'utf8'));
const PROBE1 = () => fixture('2026-10-29');
const PROBE2 = () => fixture('2026-11-10');

const FIVE_HOUR = new Date('2026-10-29T19:50:00.371677+00:00');
const SEVEN_DAY = new Date('2026-10-30T13:00:00.371705+00:00');

const windowsOf = (r) => r.windows.map((w) => [w.name, w.remainingPercent, w.resetsAt?.toISOString() ?? null]);

test('claudeCapacity maps probe 1: the Fable limit applies only to a Fable model; extra_usage changes nothing', () => {
  const opus = claudeCapacity(PROBE1(), 'opus');
  assert.equal(opus.state, 'available');
  assert.equal(opus.scope, 'model');
  assert.equal(opus.until, null);
  assert.equal(opus.message, '');
  assert.deepEqual(windowsOf(opus), [
    ['claude 5h', 95, FIVE_HOUR.toISOString()],
    ['claude 7d', 30, SEVEN_DAY.toISOString()],
  ]);
  assert.equal(PROBE1().extra_usage.spend_limit_reached, true, 'the fixture has the spend limit reached');
  const fable = claudeCapacity(PROBE1(), 'fable');
  assert.equal(fable.state, 'available');
  assert.deepEqual(windowsOf(fable), [
    ['claude 5h', 95, FIVE_HOUR.toISOString()],
    ['claude 7d', 30, SEVEN_DAY.toISOString()],
    ['claude 7d Fable', 31, SEVEN_DAY.toISOString()],
  ]);
});

test('claudeCapacity maps probe 2: one weekly window; a configuration with no model leaves the Fable limit out', () => {
  const opus = claudeCapacity(PROBE2(), 'opus');
  assert.equal(opus.state, 'available');
  assert.equal(opus.scope, 'model');
  assert.deepEqual(windowsOf(opus), [['claude 7d', 34, '2026-11-13T12:59:59.825Z']]);
  assert.deepEqual(windowsOf(claudeCapacity(PROBE2(), null)), windowsOf(opus));
  assert.equal(claudeCapacity(PROBE2(), 'FABLE').windows.length, 2, 'case-insensitive');
});

test('an exhausted session window makes every model unavailable until its reset; two, until the later one', () => {
  const body = PROBE1();
  body.limits[0].percent = 100;
  for (const model of ['opus', 'sonnet']) {
    const r = claudeCapacity(body, model);
    assert.equal(r.state, 'unavailable', model);
    assert.deepEqual(r.until, FIVE_HOUR, model);
    assert.equal(r.message, 'no quota left in claude 5h', model);
  }
  body.limits[1].percent = 100;
  const both = claudeCapacity(body, 'opus');
  assert.deepEqual(both.until, SEVEN_DAY);
  assert.equal(both.message, 'no quota left in claude 5h, claude 7d');
  // A used-up window with no reset: unavailable with no time.
  body.limits[1].resets_at = null;
  assert.equal(claudeCapacity(body, 'opus').state, 'unavailable');
  assert.equal(claudeCapacity(body, 'opus').until, null);
});

test('an exhausted model-scoped window takes out only the model it names', () => {
  const body = PROBE1();
  body.limits[2].percent = 100;
  for (const model of ['fable', 'claude-fable-5-2']) {
    const r = claudeCapacity(body, model);
    assert.equal(r.state, 'unavailable', model);
    assert.deepEqual(r.until, SEVEN_DAY, model);
    assert.equal(r.message, 'no quota left in claude 7d Fable', model);
  }
  assert.equal(claudeCapacity(body, 'opus').state, 'available');
  // A scope that names the model by id.
  const byId = PROBE1();
  byId.limits[2].percent = 100;
  byId.limits[2].scope.model = { id: 'opus', display_name: null };
  assert.equal(claudeCapacity(byId, 'opus').state, 'unavailable');
  assert.equal(claudeCapacity(byId, 'opus').windows[2].name, 'claude 7d opus');
  assert.equal(claudeCapacity(byId, 'sonnet').state, 'available');
  // A display_name that is not a string does not name the window.
  for (const display_name of [{}, [], 5, true]) {
    byId.limits[2].scope.model.display_name = display_name;
    assert.equal(claudeCapacity(byId, 'opus').windows[2].name, 'claude 7d opus', JSON.stringify(display_name));
  }
  // A limit for a surface, or a scope of another shape, is left out.
  for (const scope of [
    { model: { id: null, display_name: 'Fable' }, surface: 'web' },
    { model: 'Fable', surface: null },
    'Fable',
  ]) {
    const other = PROBE1();
    other.limits[2].percent = 100;
    other.limits[2].scope = scope;
    const r = claudeCapacity(other, 'fable');
    assert.equal(r.state, 'available', JSON.stringify(scope));
    assert.equal(r.windows.length, 2, JSON.stringify(scope));
  }
});

test('with no limits, five_hour and seven_day are the windows, and the reading is account-scoped', () => {
  const { limits: _limits, ...body } = PROBE1();
  const r = claudeCapacity(body, 'opus');
  assert.equal(r.state, 'available');
  assert.equal(r.scope, 'account');
  assert.deepEqual(windowsOf(r), [
    ['claude 5h', 95, FIVE_HOUR.toISOString()],
    ['claude 7d', 30, SEVEN_DAY.toISOString()],
  ]);
  // five_hour null, as in probe 2.
  const { limits: _l2, ...body2 } = PROBE2();
  assert.deepEqual(windowsOf(claudeCapacity(body2, 'opus')), [['claude 7d', 34, '2026-11-13T12:59:59.825Z']]);
  body.five_hour.utilization = 100;
  assert.equal(claudeCapacity(body, 'opus').state, 'unavailable');
});

test('a reset that is not a time, or a body with no windows, is unknown; a percent over 100 leaves 0', () => {
  const bad = PROBE1();
  bad.limits[1].resets_at = 'soon';
  const r = claudeCapacity(bad, 'opus');
  assert.equal(r.state, 'unknown');
  assert.equal(r.until, null);
  assert.equal(r.message, 'the Claude usage endpoint reported a reset that is not a time (claude 7d: soon)');
  for (const body of [null, [], 'x', {}, { limits: [] }, { limits: [null, { kind: 'session', percent: 'x' }] }]) {
    const u = claudeCapacity(body, 'opus');
    assert.equal(u.state, 'unknown', JSON.stringify(body));
    assert.deepEqual(u.windows, [], JSON.stringify(body));
  }
  assert.equal(claudeCapacity(null, 'opus').scope, 'model');
  assert.equal(claudeCapacity({ limits: [] }, 'opus').message, 'the Claude usage endpoint reported no quota windows');
  // A limit of another kind is named by its kind; one with no kind is still a window.
  assert.deepEqual(
    claudeCapacity(
      {
        limits: [
          { kind: 'daily', percent: 40, resets_at: null, scope: null },
          { percent: 100, resets_at: null, scope: null },
        ],
      },
      'opus',
    ),
    {
      state: 'unavailable',
      scope: 'account',
      until: null,
      windows: [
        { name: 'claude daily', remainingPercent: 60, resetsAt: null },
        { name: 'claude', remainingPercent: 0, resetsAt: null },
      ],
      message: 'no quota left in claude',
    },
  );
  const over = PROBE1();
  over.limits[0].percent = 130;
  assert.equal(claudeCapacity(over, 'opus').windows[0].remainingPercent, 0);
  assert.equal(claudeCapacity(over, 'opus').state, 'unavailable');
  const under = PROBE1();
  under.limits[0].percent = -20;
  assert.equal(claudeCapacity(under, 'opus').windows[0].remainingPercent, 100);
});

// The two shapes a limit comes in: an entry of `limits`, and the
// `five_hour` / `seven_day` fallback. `set(field, value)` builds a body whose
// one used-up `claude 5h` limit has `field` = `value`, beside a `claude 7d` at 10%.
const LIMIT_SHAPES = [
  {
    shape: 'limits',
    field: { percent: 'percent', resets_at: 'resets_at' },
    set: (field, value) => ({
      limits: [
        { kind: 'session', percent: 100, resets_at: '2030-01-01T00:00:00Z', scope: null, [field]: value },
        { kind: 'weekly_all', percent: 10, resets_at: '2030-01-01T00:00:00Z', scope: null },
      ],
    }),
  },
  {
    shape: 'five_hour / seven_day',
    field: { percent: 'utilization', resets_at: 'resets_at' },
    set: (field, value) => ({
      five_hour: { utilization: 100, resets_at: '2030-01-01T00:00:00Z', [field]: value },
      seven_day: { utilization: 10, resets_at: '2030-01-01T00:00:00Z' },
    }),
  },
];

test('claudeCapacity: a resets_at that is not a string, null or absent is unknown', () => {
  for (const { shape, field, set } of LIMIT_SHAPES) {
    for (const [value, shown] of [
      [false, 'false'],
      [0, '0'],
      [true, 'true'],
      [1794303620, '1794303620'],
      [[], '[]'],
      [{}, '{}'],
    ]) {
      const r = claudeCapacity(set(field.resets_at, value), 'opus');
      const label = `${shape}: ${JSON.stringify(value)}`;
      assert.equal(r.state, 'unknown', label);
      assert.equal(r.until, null, label);
      assert.deepEqual(r.windows, [], label);
      assert.equal(
        r.message,
        `the Claude usage endpoint reported a reset that is not a time (claude 5h: ${shown})`,
        label,
      );
    }
    // A string, null or absent resets_at is read.
    assert.equal(claudeCapacity(set(field.resets_at, '2030-01-01T00:00:00Z'), 'opus').state, 'unavailable', shape);
    assert.equal(claudeCapacity(set(field.resets_at, null), 'opus').until, null, shape);
    assert.equal(claudeCapacity(set(field.resets_at, undefined), 'opus').state, 'unavailable', shape);
  }
});

test('claudeCapacity: a limit whose percent is not a number is unknown', () => {
  for (const { shape, field, set } of LIMIT_SHAPES) {
    for (const [value, shown] of [
      ['100', '100'],
      [null, 'null'],
      [undefined, 'undefined'],
      [true, 'true'],
      [Number.NaN, 'null'],
      [Number.POSITIVE_INFINITY, 'null'],
      [[], '[]'],
      [{}, '{}'],
    ]) {
      const r = claudeCapacity(set(field.percent, value), 'opus');
      const label = `${shape}: ${String(value)}`;
      assert.equal(r.state, 'unknown', label);
      assert.deepEqual(r.windows, [], label);
      assert.equal(
        r.message,
        `the Claude usage endpoint reported a percent that is not a number (claude 5h: ${shown})`,
        label,
      );
    }
  }
  // A limit that does not apply to the configuration is left out before its percent is read.
  const other = PROBE1();
  other.limits[2].percent = '100';
  assert.equal(claudeCapacity(other, 'opus').state, 'available');
  assert.equal(claudeCapacity(other, 'fable').state, 'unknown');
  // A five_hour that is null, as in probe 2, is no window, not an unreadable one.
  const { limits: _limits, ...probe2 } = PROBE2();
  assert.equal(claudeCapacity(probe2, 'opus').state, 'available');
});

test('readClaudeToken reads claudeAiOauth.accessToken and refuses a missing or expired one', () => {
  const path = '/c/.credentials.json';
  const now = Date.parse('2026-11-10T00:00:00Z');
  const missing = `no Claude OAuth token in ${path}; run claude to log in`;
  for (const text of ['not json', '{}', '{"claudeAiOauth":{}}', '{"claudeAiOauth":{"accessToken":""}}', 'null']) {
    assert.deepEqual(readClaudeToken(text, path, now), { error: missing }, text);
  }
  const creds = (expiresAt) => JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt } });
  assert.deepEqual(readClaudeToken(creds(now - 1000), path, now), {
    error: 'the Claude OAuth token expired at 2026-11-09T23:59:59.000Z; run claude to refresh it',
  });
  assert.deepEqual(readClaudeToken(creds(1794303620163), path, now), { token: 'tok' });
  assert.deepEqual(readClaudeToken(creds(undefined), path, now), { token: 'tok' }, 'no expiresAt keeps the token');
});

test('ClaudeProvider.capacity is unknown when the helper fails, and maps its body otherwise', () => {
  const c = new ClaudeProvider();
  const fake = (r) => () => r;
  const env = { CLAUDE_CONFIG_DIR: '/nowhere' };
  const ask = (run) => c.capacity({ model: 'opus', run, env });
  const spawnError = ask(fake({ error: new Error('spawnSync node ETIMEDOUT') }));
  assert.equal(spawnError.state, 'unknown');
  assert.equal(spawnError.scope, 'model');
  assert.match(spawnError.message, /^claude capacity read failed \(.*ETIMEDOUT\)$/);
  assert.equal(
    ask(fake({ status: null, signal: 'SIGTERM', stdout: '' })).message,
    'claude capacity read failed (signal SIGTERM)',
  );
  assert.equal(ask(fake({ status: 0, stdout: 'not json' })).state, 'unknown');
  assert.deepEqual(ask(fake({ status: 0, stdout: '{"ok":false,"error":"x"}' })), {
    state: 'unknown',
    scope: 'model',
    until: null,
    windows: [],
    message: 'x',
  });
  const ok = ask(fake({ status: 0, stdout: JSON.stringify({ ok: true, body: PROBE2() }) }));
  assert.deepEqual(ok, claudeCapacity(PROBE2(), 'opus'));
  assert.equal(
    ask(() => {
      throw new Error('boom');
    }).state,
    'unknown',
  );
  // The helper is asked for the credentials under the env's CLAUDE_CONFIG_DIR.
  let argv;
  ask((cmd, args) => {
    argv = args;
    return { status: 0, stdout: '{"ok":false,"error":"x"}' };
  });
  assert.deepEqual(argv.slice(1), ['--credentials', '/nowhere/.credentials.json', '--timeout', '10000']);
});

test('bl capacity shows a Claude row in the Codex rows format: each window, its remaining percent and its local reset', () => {
  const out = PROBE1();
  out.limits[0].percent = 100;
  const [, row] = capacityTable([
    { role: 'agent', agent: 'claude', model: 'fable', ...claudeCapacity(out, 'fable') },
  ]).split('\n');
  assert.match(
    row,
    /^agent\s+claude\s+fable\s+unavailable\s+claude 5h 0% left \(resets \d{4}-\d\d-\d\d \d\d:\d\d \S+\); claude 7d 30% left \(resets [^)]+\); claude 7d Fable 31% left \(resets [^)]+\); until \d{4}-\d\d-\d\d \d\d:\d\d \S+; no quota left in claude 5h$/,
  );
});

test('the local adapter keeps its own capacity()', () => {
  assert.notEqual(new LocalProvider().capacity, ClaudeProvider.prototype.capacity);
});
