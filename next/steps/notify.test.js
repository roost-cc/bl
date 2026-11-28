// The routing and the texts of notifications (F-140 D9), on the uTop copies of
// config/alerts.yaml and config/templates/en.yaml. The notify step runs with
// the runner in engine/code-steps.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { routeChannels, templateText } from './notify.js';

const fixture = (/** @type {string} */ name) =>
  parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));

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
