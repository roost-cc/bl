// The routing and the texts of notifications (F-140 D9), on the uTop copies of
// config/alerts.yaml and config/templates/en.yaml. The notify step runs with
// the runner in engine/code-steps.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { record } from '../store/record.js';
import { createItems } from '../test/helpers/engine-backlog.js';
import { fixtureText } from '../test/helpers/config-fixture.js';
import { channel, delivered, notifyBacklog } from '../test/helpers/notify-backlog.js';
import { routeChannels, sendAlert, templateText } from './notify.js';

const fixture = (/** @type {string} */ name) => parse(fixtureText(name));

const ALERTS = fixture('alerts.yaml');
const EN = fixture('templates/en.yaml');

test('routeChannels takes <kind>.<reason> before <kind>, and joins the lists of several reasons with no repeats', () => {
  assert.deepEqual(routeChannels(ALERTS, 'notify', ['escalation']), ['terminal', 'bell']);
  assert.deepEqual(routeChannels(ALERTS, 'notify', ['other']), ['terminal']);
  assert.deepEqual(routeChannels(ALERTS, 'gated', ['expected']), []);
  assert.deepEqual(routeChannels(ALERTS, 'gated', ['needs_operator_action', 'should_always_be_true']), [
    'terminal',
    'bell',
  ]);
  // A reason with no key of its own adds the kind's list; with no reason, the kind's list.
  assert.deepEqual(routeChannels(ALERTS, 'gated', ['expected', 'other']), ['terminal']);
  // An undefined reason, a gate entry with no class, adds the kind's list too.
  assert.deepEqual(routeChannels(ALERTS, 'gated', ['expected', undefined]), ['terminal']);
  assert.deepEqual(routeChannels({ ...ALERTS, 'gated.undefined': ['bell'] }, 'gated', [undefined]), ['terminal']);
  assert.deepEqual(routeChannels(ALERTS, 'ended'), []);
});

/** A configuration with the language `language` and the language files `files`, name → texts. */
const config = (/** @type {string} */ language, /** @type {Record<string, any>} */ files = { 'en.yaml': EN }) =>
  /** @type {any} */ ({
    scope: (/** @type {string|null} */ repo) => (repo === null ? { language } : undefined),
    file: (/** @type {string} */ kind, /** @type {string} */ name) => (kind === 'templates' ? files[name] : undefined),
  });

test('templateText takes <kind>.<reason> before <kind> from the language file', () => {
  const en = config('en');
  assert.equal(templateText(en, 'ended', 'crash'), EN['ended.crash']);
  assert.equal(templateText(en, 'ended', 'normal'), EN.ended);
  assert.equal(templateText(en, 'escalation_waiting'), EN.escalation_waiting);
});

test('templateText throws an error that names a language with no file, and a missing template name', () => {
  assert.throws(() => templateText(config('de'), 'ended'), {
    message: "the language 'de' has no template file templates/de.yaml",
  });
  assert.throws(() => templateText(config('en'), 'no_such_text'), {
    message: "templates/en.yaml has no template named 'no_such_text'",
  });
  assert.throws(() => templateText(config('en'), 'missing', 'why'), {
    message: "templates/en.yaml has no template named 'missing.why' or 'missing'",
  });
});

/**
 * The step context of one task at the box `review/check`, in a backlog with
 * the channels `terminal` and `bell` (exit `codes`), `alerts` as
 * config/alerts.yaml (by default uTop's), and `texts` as the English texts
 * (by default uTop's; null for none).
 * @param {string} [alerts]
 * @param {Record<string, number>} [codes]
 * @param {string|null} [texts]
 */
async function alertContext(alerts, codes = { terminal: 0, bell: 0 }, texts) {
  const channels = Object.fromEntries(Object.entries(codes).map(([name, code]) => [name, channel(name, code)]));
  const ctx = notifyBacklog({ channels, alerts, texts });
  const [id] = await createItems(ctx, [{ type: 'task', state: { status: 'draft', run: 'idle' } }]);
  return { ...ctx, id, type: 'task', box: 'review/check', record: record(ctx, id) };
}

test('sendAlert routes a gated alert by every class, and its text gets the first condition, its class and box.name', async () => {
  const ctx = await alertContext();
  const extras = { box: 'review/check', condition: 'attributes.ok', class: 'needs_operator_action' };
  await sendAlert(ctx, 'gated', ['needs_operator_action', 'expected'], extras);
  const text = `${ctx.id} is held before check: attributes.ok [needs_operator_action]\n`;
  assert.equal(delivered(ctx, 'terminal'), text);
  assert.equal(delivered(ctx, 'bell'), text);
});

test('sendAlert cuts a condition longer than 120 characters at 120 with …, and an empty class adds nothing', async () => {
  const ctx = await alertContext();
  const long = `attributes.a == "${'x'.repeat(130)}"`;
  await sendAlert(ctx, 'gated', [], { condition: long, class: '' });
  assert.equal(delivered(ctx, 'terminal'), `${ctx.id} is held: ${long.slice(0, 120)}…\n`);
  assert.equal(delivered(ctx, 'bell'), null);
  const exact = await alertContext();
  await sendAlert(exact, 'gated', [], { condition: long.slice(0, 120), class: '' });
  assert.equal(delivered(exact, 'terminal'), `${exact.id} is held: ${long.slice(0, 120)}\n`);
});

test("sendAlert gives the text the first reason as reason, and an ended.crash text the box's path and error", async () => {
  const ctx = await alertContext('gated: []\nended: [terminal]\nended.crash: [bell]\nnotify: []\n');
  await sendAlert(ctx, 'ended', ['normal'], { box: 'review/check' });
  assert.equal(delivered(ctx, 'terminal'), `${ctx.id}: bl ended (normal)\n`);
  await sendAlert(ctx, 'ended', ['crash'], { box: 'review/check', error: 'review/check: boom' });
  assert.equal(delivered(ctx, 'bell'), `${ctx.id} crashed at review/check: review/check: boom\n`);
});

test('sendAlert with a route of [] runs no channel and reads no text', async (t) => {
  // The uTop routing sends ended.normal to []; with no language file, a read of its text would throw.
  const ctx = await alertContext(undefined, undefined, null);
  const printed = /** @type {string[]} */ ([]);
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
  await sendAlert(ctx, 'ended', ['normal'], { box: 'review/check' });
  assert.equal(delivered(ctx, 'terminal'), null);
  assert.deepEqual(printed, []);
});

test('sendAlert prints one line that names an alert no channel delivers, after the lines of send', async (t) => {
  // 127 is a crash code of a plugin, which send prints as a line of its own (D-101).
  const ctx = await alertContext(undefined, { terminal: 1, bell: 127 });
  const printed = /** @type {string[]} */ ([]);
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
  await sendAlert(ctx, 'ended', ['crash'], { box: 'review/check', error: 'boom' });
  assert.notEqual(delivered(ctx, 'bell'), null);
  const lines = printed.join('').split('\n').filter(Boolean);
  assert.match(lines[0], /^bl\.notify bell: .*exited 127/);
  assert.deepEqual(lines.slice(1), [`${ctx.id}: the ended.crash alert reached no channel`]);
});
