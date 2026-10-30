/**
 * Unit tests for `resolveSurface` / `normalizeSurface`.
 *
 * Surface controls host-specific prompt fragments, so the resolver stays
 * conservative: explicit config wins, `BL_SURFACE=none` can disable
 * autodetect, and malformed values resolve to no surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSurface, normalizeSurface } from '../../src/surface.js';

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ['BL_SURFACE', 'CLAUDECODE']) {
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

test('normalizeSurface lowercases and trims kebab-case identifiers', () => {
  assert.equal(normalizeSurface(' Claude-Code '), 'claude-code');
  assert.equal(normalizeSurface('GEMINI-CLI'), 'gemini-cli');
});

test('normalizeSurface rejects empty, none, null, non-string, and malformed inputs', () => {
  assert.equal(normalizeSurface(undefined), null);
  assert.equal(normalizeSurface(null), null);
  assert.equal(normalizeSurface(''), null);
  assert.equal(normalizeSurface('   '), null);
  assert.equal(normalizeSurface('none'), null);
  assert.equal(normalizeSurface(' NULL '), null);
  assert.equal(normalizeSurface('../claude-code'), null);
  assert.equal(normalizeSurface('claude_code'), null);
  assert.equal(normalizeSurface('claude code'), null);
});

test('resolveSurface returns null when nothing is set', () => {
  withEnv({}, () => {
    assert.equal(resolveSurface(null), null);
    assert.equal(resolveSurface({}), null);
    assert.equal(resolveSurface({ raw: {} }), null);
  });
});

test('resolveSurface: config.raw.surface wins over env and autodetect', () => {
  withEnv({ BL_SURFACE: 'gemini-cli', CLAUDECODE: '1' }, () => {
    assert.equal(resolveSurface({ raw: { surface: 'Claude-Code' } }), 'claude-code');
  });
});

test('resolveSurface: BL_SURFACE wins over CLAUDECODE autodetect', () => {
  withEnv({ BL_SURFACE: 'gemini-cli', CLAUDECODE: '1' }, () => {
    assert.equal(resolveSurface({ raw: {} }), 'gemini-cli');
  });
});

test('resolveSurface: BL_SURFACE=none disables autodetect', () => {
  withEnv({ BL_SURFACE: 'none', CLAUDECODE: '1' }, () => {
    assert.equal(resolveSurface({ raw: {} }), null);
  });
});

test('resolveSurface: CLAUDECODE=1 autodetects claude-code', () => {
  withEnv({ CLAUDECODE: '1' }, () => {
    assert.equal(resolveSurface({ raw: {} }), 'claude-code');
  });
});

test('resolveSurface ignores CLAUDECODE values other than 1', () => {
  withEnv({ CLAUDECODE: 'true' }, () => {
    assert.equal(resolveSurface({ raw: {} }), null);
  });
});
