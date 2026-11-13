import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCause, describeFailure, localTime } from '../../src/agent-failure.js';

const NOW = Date.parse('2026-10-13T23:59:36Z');
const RESET = new Date(NOW + 2 * 3_600_000);
const out = (kind, until = null) => ({ agent: 'a', model: 'm', scope: 'model', kind, message: 'refused', until });
const reading = (state, { until = null, windows = [], message = '' } = {}) => ({
  state,
  scope: 'model',
  until,
  windows,
  message,
});
const win = (name, remainingPercent, resetsAt = RESET) => ({ name, remainingPercent, resetsAt });

test('classifyCause: each cause, in its order', () => {
  const cases = [
    ['spend via refusal', { out: out('spend'), reading: reading('available') }, 'spend cap reached'],
    [
      'spend via reading',
      { out: out('quota'), reading: reading('unavailable', { windows: [win('5h', 10)] }) },
      'spend cap reached',
    ],
    [
      'window via refusal resetsAt',
      { out: out('session', RESET.toISOString()), reading: reading('unknown') },
      `quota window used up until ${localTime(RESET)}`,
    ],
    [
      'window via reading until, with the windows at 0%',
      { out: out('quota'), reading: reading('unavailable', { until: RESET, windows: [win('5h', 0), win('7d', 50)] }) },
      `quota window used up until ${localTime(RESET)} (5h at 0%)`,
    ],
    [
      'overloaded, reading available',
      { out: out('capacity'), reading: reading('available') },
      'provider overloaded, your quota is fine',
    ],
    [
      'overloaded, reading unknown',
      { out: out('capacity'), reading: reading('unknown') },
      'provider overloaded; quota could not be read',
    ],
    ['other is unknown', { out: out('other'), reading: reading('unknown') }, 'unknown'],
    ['a quota entry the reading no longer confirms', { out: out('quota'), reading: reading('available') }, 'unknown'],
    ['a weekly refusal with no reset', { out: out('weekly'), reading: reading('available') }, 'unknown'],
  ];
  for (const [name, input, line] of cases) assert.equal(classifyCause(input).line, line, name);
  // Spend wins over a used-up window; a window wins over overloaded.
  assert.equal(classifyCause({ out: out('spend'), reading: reading('unavailable', { until: RESET }) }).cause, 'spend');
  assert.equal(
    classifyCause({ out: out('capacity'), reading: reading('unavailable', { until: RESET, windows: [win('5h', 0)] }) })
      .cause,
    'window',
  );
});

test('classifyCause: a window at 0% with no reset time is a used-up window', () => {
  // Invariant: the cause is a used-up window whenever the reading shows a
  // window at 0%, and never when the reading is `available`.
  const noReset = `quota window used up, no reset time`;
  const cases = [
    [
      'reading at 0%, no until',
      { out: out('quota'), reading: reading('unavailable', { windows: [win('5h', 0, null)] }) },
      `${noReset} (5h at 0%)`,
    ],
    [
      'every used-up window without a reset',
      { out: out('session'), reading: reading('unavailable', { windows: [win('5h', 0, null), win('7d', 0, null)] }) },
      `${noReset} (5h, 7d at 0%)`,
    ],
    [
      'a capacity refusal, reading at 0%',
      { out: out('capacity'), reading: reading('unavailable', { windows: [win('5h', 0, null)] }) },
      `${noReset} (5h at 0%)`,
    ],
    ['a session refusal, no reading, no reset', { out: out('session'), reading: null }, noReset],
    [
      'a session refusal with a reset, reading available',
      { out: out('session', RESET.toISOString()), reading: reading('available', { windows: [win('5h', 80)] }) },
      'unknown',
    ],
    [
      'a weekly refusal with a reset, reading available',
      { out: out('weekly', RESET.toISOString()), reading: reading('available', { windows: [win('7d', 5)] }) },
      'unknown',
    ],
    [
      'a session refusal, reading unavailable with no window at 0% and no until',
      { out: out('session'), reading: reading('unavailable', { message: 'spend cap reached (credits)' }) },
      'spend cap reached',
    ],
  ];
  for (const [name, input, line] of cases) {
    const { cause, line: got } = classifyCause(input);
    assert.equal(got, line, name);
    if (input.reading?.windows?.some((w) => w.remainingPercent <= 0)) assert.equal(cause, 'window', name);
    if (input.reading?.state === 'available') assert.notEqual(cause, 'window', name);
  }
});

const base = { step: 'implement S-1', failedAt: NOW, roleKey: 'agent', resumeHint: 'bl run F-1 --resume' };

test("classifyCause: a refusal's reset survives an unavailable reading with no until", () => {
  // Invariant: the cause line never has less reset information than the
  // refusal and the reading hold together. The reading's until wins when it
  // is a time; else the refusal's.
  const later = new Date(NOW + 5 * 3_600_000);
  const at = `quota window used up until ${localTime(RESET)}`;
  const cases = [
    ['reading until null', { until: null }, RESET.toISOString(), RESET.getTime()],
    ['reading until not a time', { until: 'garbage' }, RESET.toISOString(), RESET.getTime()],
    ['reading until a time wins', { until: RESET }, later.toISOString(), RESET.getTime()],
    ['neither has a time', { until: null }, null, null],
    ['refusal until not a time', { until: null }, 'garbage', null],
  ];
  for (const [name, r, refusal, until] of cases) {
    for (const kind of ['session', 'weekly', 'quota', 'capacity']) {
      const got = classifyCause({
        out: out(kind, refusal),
        reading: reading('unavailable', { ...r, windows: [win('5h', 0, null)] }),
      });
      assert.equal(got.cause, 'window', `${name} ${kind}`);
      assert.equal(got.until, until, `${name} ${kind}`);
      assert.equal(
        got.line,
        `${until == null ? 'quota window used up, no reset time' : at} (5h at 0%)`,
        `${name} ${kind}`,
      );
    }
  }
  // describeFailure ranks a window by the reset it carries, so the refusal's
  // reset is waited for, not ranked last.
  const { causeLine, text } = describeFailure({
    ...base,
    configurations: [
      { agent: 'a', model: 'm', out: out('quota'), reading: reading('unavailable', { windows: [win('5h', 0, null)] }) },
      {
        agent: 'b',
        model: 'n',
        out: out('session', RESET.toISOString()),
        reading: reading('unavailable', { windows: [win('5h', 0, null)] }),
      },
    ],
  });
  assert.equal(causeLine, `${at} (5h at 0%)`);
  assert.equal(steps(text)[0], `Wait until the reset, ${localTime(RESET)}.`);
});

test('describeFailure: an available reading with no window at 0% is not a used-up window', () => {
  const { cause, causeLine, text } = describeFailure({
    ...base,
    configurations: [
      {
        agent: 'a',
        model: 'm',
        out: out('session', RESET.toISOString()),
        reading: reading('available', { windows: [win('5h', 80)] }),
      },
    ],
  });
  assert.equal(cause, 'unknown');
  assert.equal(causeLine, 'unknown');
  assert.ok(text.includes(`\n  - 5h: 80% left, resets ${localTime(RESET)}\n`), text);
  const s = steps(text);
  assert.match(s[0], /^Run `bl capacity`/);
  assert.equal(s.at(-1), 'Run `bl run F-1 --resume`.');
});

test('describeFailure: a window at 0% with no reset time says to read capacity again, not to wait', () => {
  const { cause, causeLine, text } = describeFailure({
    ...base,
    configurations: [
      {
        agent: 'a',
        model: 'm',
        out: out('quota'),
        reading: reading('unavailable', { windows: [win('5h', 0, null)], message: 'no quota left in 5h' }),
      },
    ],
  });
  assert.equal(cause, 'window');
  assert.equal(causeLine, 'quota window used up, no reset time (5h at 0%)');
  assert.ok(text.includes('\n  - capacity: unavailable — no quota left in 5h\n  - 5h: 0% left, no reset time\n'), text);
  assert.deepEqual(steps(text), [
    "Run `bl capacity` to read the configuration's quota windows again.",
    'Clear `## Escalation` to `None.`.',
    'Run `bl run F-1 --resume`.',
  ]);
  assert.ok(!/Wait until/.test(text), text);
});

test('describeFailure: a used-up window with a reset is chosen before one without', () => {
  const { causeLine } = describeFailure({
    ...base,
    configurations: [
      { agent: 'a', model: 'm', out: out('quota'), reading: reading('unavailable', { windows: [win('5h', 0, null)] }) },
      { agent: 'b', model: 'n', out: out('quota'), reading: reading('unavailable', { until: RESET }) },
    ],
  });
  assert.equal(causeLine, `quota window used up until ${localTime(RESET)}`);
});

test('describeFailure: a spend cause from a reading shows the reading that says so', () => {
  const { cause, text } = describeFailure({
    ...base,
    configurations: [
      {
        agent: 'a',
        model: 'm',
        out: out('session'),
        reading: reading('unavailable', { message: 'spend cap reached (credits)' }),
      },
    ],
  });
  assert.equal(cause, 'spend');
  assert.ok(text.includes('\n  - capacity: unavailable — spend cap reached (credits)\n'), text);
});

/** The numbered steps of `text`, without their numbers, checked to run 1, 2, 3, … */
function steps(text) {
  const lines = text.split('\n').filter((l) => /^\d+\. /.test(l));
  lines.forEach((l, i) => assert.ok(l.startsWith(`${i + 1}. `), l));
  return lines.map((l) => l.replace(/^\d+\. /, ''));
}

test('describeFailure: the step line, agent default for a null model, window lines, one cause line, ordered steps', () => {
  const { cause, causeLine, text } = describeFailure({
    ...base,
    configurations: [
      {
        agent: 'a',
        model: null,
        out: out('capacity'),
        reading: reading('available', { windows: [win('5h', 40), win('7d', 75, null)] }),
        remediation: null,
      },
      { agent: 'b', model: 'x', out: null, reading: null, remediation: null },
    ],
  });
  assert.equal(cause, 'overloaded');
  assert.equal(causeLine, 'provider overloaded, your quota is fine');
  assert.ok(text.startsWith(`Step: implement S-1, failed at ${localTime(NOW)}.\n`), text);
  assert.ok(text.includes('Configurations (backlog.json "agent", in priority order):'), text);
  assert.ok(text.includes('\n- a (agent default): capacity — refused (this configuration; no reset time)\n'), text);
  assert.ok(text.includes(`\n  - 5h: 40% left, resets ${localTime(RESET)}\n`), text);
  assert.ok(text.includes('\n  - 7d: 75% left, no reset time\n'), text);
  assert.ok(text.includes('\n- b x: not tried\n'), text);
  assert.equal(text.match(/\nCause: /g).length, 1);
  const s = steps(text);
  assert.match(s[0], /^Wait about 30 minutes/);
  assert.match(s[1], /`bl capacity`/);
  assert.equal(s[2], 'Clear `## Escalation` to `None.`.');
  assert.equal(s[3], 'Run `bl run F-1 --resume`.');
  assert.ok(text.endsWith('Alternative: add another configuration to "agent" in backlog.json.'), text);
});

test('describeFailure: an unknown reading shows its message; an adapter reporting no windows shows none', () => {
  const { text } = describeFailure({
    ...base,
    configurations: [
      { agent: 'a', model: 'm', out: out('capacity'), reading: reading('unknown', { message: 'cannot ask' }) },
      { agent: 'b', model: 'n', out: out('capacity'), reading: reading('available') },
    ],
  });
  assert.ok(text.includes('\n  - capacity: unknown — cannot ask\n'), text);
  assert.ok(
    text.includes('\n- b n: capacity — refused (this configuration; no reset time)\n\n'),
    'no window lines for b',
  );
});

test('describeFailure: the billing page and check command when the adapter names them, else its own usage page', () => {
  const spend = (remediation) =>
    describeFailure({
      ...base,
      configurations: [{ agent: 'a', model: 'm', out: out('spend'), reading: null, remediation }],
    });
  assert.equal(
    steps(spend({ checkCommand: null, billingUrl: 'https://example.test/billing' }).text)[0],
    'Raise the spend limit or buy credits on https://example.test/billing.',
  );
  assert.equal(steps(spend(null).text)[0], "Raise the spend limit or buy credits on a's own usage page.");
  assert.match(steps(spend(null).text)[1], /`bl capacity`/);

  const unknown = (remediation) =>
    describeFailure({
      ...base,
      configurations: [{ agent: 'a', model: 'm', out: out('other'), reading: null, remediation }],
    });
  assert.equal(
    steps(unknown({ checkCommand: 'a usage', billingUrl: null }).text)[0],
    'Run `bl capacity`, and `a usage`.',
  );
  assert.equal(steps(unknown(null).text)[0], "Run `bl capacity`, and check a's own usage page.");
  assert.deepEqual(steps(unknown(null).text).slice(1), [
    'Fix what that shows.',
    'Clear `## Escalation` to `None.`.',
    'Run `bl run F-1 --resume`.',
  ]);
});

test('describeFailure: a used-up window waits for the earliest reset, or says it has passed', () => {
  const later = new Date(NOW + 5 * 3_600_000);
  const windowed = (failedAt) =>
    describeFailure({
      ...base,
      failedAt,
      configurations: [
        { agent: 'a', model: 'm', out: out('quota'), reading: reading('unavailable', { until: later }) },
        { agent: 'b', model: 'n', out: out('quota'), reading: reading('unavailable', { until: RESET }) },
      ],
    });
  const { causeLine, text } = windowed(NOW);
  assert.equal(causeLine, `quota window used up until ${localTime(RESET)}`);
  assert.equal(steps(text)[0], `Wait until the reset, ${localTime(RESET)}.`);
  assert.match(text, /Alternative: add a configuration of another agent to "agent" in backlog\.json\./);
  const passed = windowed(later.getTime() + 1);
  assert.equal(passed.causeLine, `quota window used up until ${localTime(RESET)}`);
  assert.deepEqual(steps(passed.text).slice(0, 2), [
    'The reset has passed; check with `bl capacity`.',
    'Clear `## Escalation` to `None.`.',
  ]);
});

test('describeFailure: a session failure with no refusal is unknown, shows the raw error, and reads no capacity', () => {
  const { cause, causeLine, text } = describeFailure({
    ...base,
    step: 'review round 1 failure-paths',
    roleKey: 'review_agent',
    configurations: [{ agent: 'a', model: 'm', out: null, reading: null, remediation: null }],
    error: 'provider crashed',
  });
  assert.equal(cause, 'unknown');
  assert.equal(causeLine, 'unknown — not a capacity refusal bl recognised');
  assert.ok(text.includes('\n- a m\n\nError: provider crashed\n'), text);
  assert.ok(!text.includes('capacity:'), 'no reading');
  assert.match(steps(text)[0], /^Run `bl capacity`/);
});

test('describeFailure: a caller that writes no ## Escalation gets no step that clears it', () => {
  // Invariant: a numbered step names only an action that applies to what bl wrote.
  const configurations = [{ agent: 'a', model: 'm', out: null, reading: null, remediation: null }];
  for (const escalates of [true, false]) {
    const { text } = describeFailure({ ...base, configurations, error: 'provider crashed', escalates });
    assert.equal(steps(text).includes('Clear `## Escalation` to `None.`.'), escalates, String(escalates));
    assert.equal(steps(text).at(-1), 'Run `bl run F-1 --resume`.');
  }
});

test('describeFailure: an excluded implementer keeps the F-64 D4 alternative', () => {
  const { text } = describeFailure({
    ...base,
    roleKey: 'review_agent',
    configurations: [{ agent: 'a', model: 'm', out: null, reading: null, excluded: ['implement', 'self-review'] }],
  });
  assert.ok(
    text.includes(
      '\n- a m: excluded — it ran implement, self-review in this run, and the reviewer is never the implementer\n',
    ),
    text,
  );
  assert.ok(text.endsWith('Alternative: add a "review_agent" configuration that did not implement this run.'), text);
});
