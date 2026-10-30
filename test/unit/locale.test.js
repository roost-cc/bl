/**
 * Unit tests for `resolveLocale` / `normalizeLocale` / `fragmentCandidates`.
 *
 * These pin the precedence and normalization rules that `loadPrompt`
 * (`session.js`) and `readFragment` (`tool-guide.js`) both depend on —
 * a regression here changes which prompt file every launched agent
 * reads, so the surface is worth nailing down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocale, normalizeLocale, fragmentCandidates } from '../../src/locale.js';

// Save & restore the env keys we mutate so tests stay order-independent.
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ['BL_LOCALE', 'LC_ALL', 'LANG']) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// normalizeLocale
// ---------------------------------------------------------------------------

test('normalizeLocale returns null for empty / non-string / C / POSIX inputs', () => {
  assert.equal(normalizeLocale(undefined), null);
  assert.equal(normalizeLocale(null), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale('   '), null);
  assert.equal(normalizeLocale('C'), null);
  assert.equal(normalizeLocale('POSIX'), null);
});

test('normalizeLocale lowercases the language and preserves region', () => {
  assert.equal(normalizeLocale('fr'), 'fr');
  assert.equal(normalizeLocale('FR'), 'fr');
  assert.equal(normalizeLocale('fr_FR'), 'fr-FR');
  assert.equal(normalizeLocale('fr-FR'), 'fr-FR');
});

test('normalizeLocale strips .UTF-8-style codeset and @modifier suffixes', () => {
  assert.equal(normalizeLocale('fr_FR.UTF-8'), 'fr-FR');
  assert.equal(normalizeLocale('fr_FR@euro'), 'fr-FR');
  assert.equal(normalizeLocale('fr_FR.UTF-8@euro'), 'fr-FR');
});

// ---------------------------------------------------------------------------
// resolveLocale precedence
// ---------------------------------------------------------------------------

test('resolveLocale returns null when nothing is set', () => {
  withEnv({}, () => {
    assert.equal(resolveLocale(null), null);
    assert.equal(resolveLocale({}), null);
    assert.equal(resolveLocale({ raw: {} }), null);
  });
});

test('resolveLocale: config.raw.locale wins over every env variable', () => {
  withEnv({ BL_LOCALE: 'de', LC_ALL: 'es_ES', LANG: 'it_IT.UTF-8' }, () => {
    const cfg = { raw: { locale: 'fr_FR' } };
    assert.equal(resolveLocale(cfg), 'fr-FR');
  });
});

test('resolveLocale: BL_LOCALE wins over LC_ALL and LANG', () => {
  withEnv({ BL_LOCALE: 'de', LC_ALL: 'es_ES', LANG: 'it_IT' }, () => {
    assert.equal(resolveLocale(null), 'de');
  });
});

test('resolveLocale: LC_ALL wins over LANG', () => {
  withEnv({ LC_ALL: 'es_ES.UTF-8', LANG: 'it_IT' }, () => {
    assert.equal(resolveLocale(null), 'es-ES');
  });
});

test('resolveLocale: LANG=fr_FR.UTF-8 → fr-FR', () => {
  withEnv({ LANG: 'fr_FR.UTF-8' }, () => {
    assert.equal(resolveLocale(null), 'fr-FR');
  });
});

test('resolveLocale: LANG=C / POSIX resolves to null (treat as no locale)', () => {
  withEnv({ LANG: 'C' }, () => assert.equal(resolveLocale(null), null));
  withEnv({ LANG: 'POSIX' }, () => assert.equal(resolveLocale(null), null));
});

test('resolveLocale: empty config.raw.locale falls through to env', () => {
  withEnv({ LANG: 'fr_FR' }, () => {
    const cfg = { raw: { locale: '' } };
    assert.equal(resolveLocale(cfg), 'fr-FR');
  });
});

// ---------------------------------------------------------------------------
// fragmentCandidates
// ---------------------------------------------------------------------------

test('fragmentCandidates with null locale returns only the un-suffixed file', () => {
  assert.deepEqual(fragmentCandidates('foo', null), ['foo.md']);
});

test('fragmentCandidates with bare language returns lang then un-suffixed', () => {
  assert.deepEqual(fragmentCandidates('foo', 'fr'), ['foo.fr.md', 'foo.md']);
});

test('fragmentCandidates with region-tagged locale returns full, lang, un-suffixed', () => {
  assert.deepEqual(fragmentCandidates('foo', 'fr-FR'), ['foo.fr-FR.md', 'foo.fr.md', 'foo.md']);
});

test('fragmentCandidates with agent and region-tagged locale ranks agent axis first', () => {
  assert.deepEqual(fragmentCandidates('foo', 'fr-FR', 'claude'), [
    'foo.claude.fr-FR.md',
    'foo.claude.fr.md',
    'foo.claude.md',
    'foo.fr-FR.md',
    'foo.fr.md',
    'foo.md',
  ]);
});

test('fragmentCandidates with agent and no locale returns agent then shared', () => {
  assert.deepEqual(fragmentCandidates('foo', null, 'gemini'), ['foo.gemini.md', 'foo.md']);
});

test('fragmentCandidates ignores malformed and unregistered agent IDs', () => {
  assert.deepEqual(fragmentCandidates('foo', 'fr', 'DROP TABLE'), ['foo.fr.md', 'foo.md']);
  assert.deepEqual(fragmentCandidates('foo', 'fr', 'not-registered'), ['foo.fr.md', 'foo.md']);
});
