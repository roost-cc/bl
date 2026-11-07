import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import { CODING_DICTIONARY_FILE } from '../../src/config.js';

const SEED = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', CODING_DICTIONARY_FILE);

test('the coding dictionary seed is YAML whose entries each have term, meaning, avoid and decided (F-82 D4)', () => {
  const text = readFileSync(SEED, 'utf8');
  const { entries, ...rest } = parse(text);
  assert.deepEqual(Object.keys(rest), [], 'entries is the only key');
  assert.ok(Array.isArray(entries) && entries.length > 0);
  for (const e of entries) {
    assert.deepEqual(Object.keys(e).sort(), ['avoid', 'decided', 'meaning', 'term'], JSON.stringify(e));
    for (const key of ['term', 'meaning', 'decided']) assert.ok(typeof e[key] === 'string' && e[key].trim(), key);
    assert.ok(Array.isArray(e.avoid) && e.avoid.every((w) => typeof w === 'string' && w.trim()), e.term);
  }
  const terms = entries.map((e) => e.term);
  assert.equal(new Set(terms).size, terms.length, 'each term once');
  assert.ok(terms.includes('work unit'), 'defines "work unit" (D5)');
  for (const t of ['theme', 'epic', 'feature', 'story', 'component', 'operator', 'check']) {
    assert.ok(terms.includes(t), `defines "${t}" (D7)`);
  }
});

test('the seed names no project and states its limit (F-82 D6, D7)', () => {
  const text = readFileSync(SEED, 'utf8');
  assert.doesNotMatch(text, /roost/i);
  assert.match(text, /does not rename bl's CLI\s*#?\s*verbs, frontmatter keys or section headings/);
});
