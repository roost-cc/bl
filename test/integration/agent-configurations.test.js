/**
 * agent-configurations.test.js — F-64 D2 through processes: `bl validate`
 * reporting the retired agent shape, and scripts/migrate-agent-configurations.js
 * run as the operator runs it. The pure mapping and equality cases are in
 * test/unit/agent-configurations.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, configForRepo } from '../../src/config.js';
import { findAgentConfigFindings, runAll } from '../../src/validate.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/migrate-agent-configurations.js');

// Roost's backlog.json agent keys before F-64 (D7).
const LEGACY_KEYS = { agent: 'claude', review_agent: 'codex', agent_model: 'opus', fallback_model: 'sonnet' };

/** A fixture backlog whose backlog.json has `patch` over it (undefined removes a key). */
function backlog(patch, fixture = { repos: ['../demo-repo'] }) {
  const t = mkTempBacklog(fixture);
  const cfgPath = join(t.dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...raw, ...patch }, null, 2) + '\n');
  return { ...t, cfgPath };
}

test('bl validate reports the retired agent shape as an agent-config finding instead of failing to load', () => {
  const { dir, cleanup } = backlog(LEGACY_KEYS, {
    repos: {
      'demo-repo': { path: '../demo-repo', overrides: { agent_model: 'sonnet' } },
      other: { path: '../other', overrides: { plugins: {} } },
    },
  });
  try {
    const config = loadConfig({ backlogRoot: dir, lenientAgents: true });
    const findings = findAgentConfigFindings(config);
    assert.equal(findings.length, 2, JSON.stringify(findings));
    assert.ok(
      findings.every((f) => f.severity === 'error' && f.code === 'agent-config' && f.location === 'backlog.json'),
    );
    assert.match(
      findings[0].message,
      /^backlog\.json has a string "agent" and a string "review_agent" and "agent_model" and "fallback_model", the retired agent shape/,
    );
    assert.match(findings[0].message, /scripts\/migrate-agent-configurations\.js/);
    assert.match(
      findings[1].message,
      /^backlog\.json repos\["demo-repo"\] overrides has /,
      'the repo that sets a key, not the one inheriting the top level',
    );
    assert.ok(runAll(config, { json: true }).findings.some((f) => f.code === 'agent-config'));

    const r = runBl(['validate', '--json'], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(
      out.findings.some((f) => f.code === 'agent-config' && /retired agent shape/.test(f.message)),
      r.stdout,
    );
  } finally {
    cleanup();
  }
});

test("the migration script turns Roost's four keys into the list shape, leaves every other key untouched, and the result loads", () => {
  const { dir, cleanup, cfgPath } = backlog(LEGACY_KEYS);
  try {
    const before = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.throws(() => loadConfig({ backlogRoot: dir }), /retired agent shape/);
    const r = spawnSyncFiles(process.execPath, [SCRIPT, cfgPath], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rewritten/);
    const after = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.deepEqual(after.agent, [
      { agent: 'claude', model: 'opus' },
      { agent: 'claude', model: 'sonnet' },
    ]);
    assert.deepEqual(after.review_agent, [{ agent: 'codex' }], 'Codex never used agent_model');
    for (const k of ['agent_model', 'fallback_model']) assert.equal(Object.hasOwn(after, k), false, k);
    const rest = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !Object.hasOwn(LEGACY_KEYS, k)));
    assert.deepEqual(rest(after), rest(before), 'every other key untouched');
    assert.equal(readFileSync(cfgPath, 'utf8'), JSON.stringify(after, null, 2) + '\n', 'two-space JSON');

    const cfg = loadConfig({ backlogRoot: dir });
    assert.equal(cfg.agent, 'claude');
    assert.equal(cfg.agentModel, 'opus');
    assert.equal(cfg.reviewAgent, 'codex');
    assert.equal(cfg.reviewAgentModel, null);

    // A second run has nothing to do.
    const again = spawnSyncFiles(process.execPath, [SCRIPT, cfgPath], { encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing to do/);
  } finally {
    cleanup();
  }
});

test('--dry-run prints the change and writes nothing; bad arguments exit 2; a half-migrated file exits 1', () => {
  const { cleanup, cfgPath } = backlog(LEGACY_KEYS);
  try {
    const text = readFileSync(cfgPath, 'utf8');
    const dry = spawnSyncFiles(process.execPath, [SCRIPT, '--dry-run', cfgPath], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /agent \[\{"agent":"claude","model":"opus"\},\{"agent":"claude","model":"sonnet"\}\]/);
    assert.equal(readFileSync(cfgPath, 'utf8'), text);
    assert.equal(spawnSyncFiles(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(text), agent: [{ agent: 'claude' }], agent_model: 'opus' }));
    const half = spawnSyncFiles(process.execPath, [SCRIPT, cfgPath], { encoding: 'utf8' });
    assert.equal(half.status, 1);
    assert.match(half.stderr, /half migrated/);
  } finally {
    cleanup();
  }
});

test('a migrated backlog with overrides loads, and each repo resolves the lists its old settings meant', () => {
  const { dir, cleanup, cfgPath } = backlog(LEGACY_KEYS, {
    repos: { 'demo-repo': { path: '../demo-repo', overrides: { review_agent: 'claude' } } },
  });
  try {
    assert.equal(spawnSyncFiles(process.execPath, [SCRIPT, cfgPath], { encoding: 'utf8' }).status, 0);
    const repo = configForRepo(loadConfig({ backlogRoot: dir }), 'demo-repo');
    assert.deepEqual(repo.reviewAgents, [{ agent: 'claude', model: 'opus' }]);
    assert.deepEqual(repo.agents, [
      { agent: 'claude', model: 'opus' },
      { agent: 'claude', model: 'sonnet' },
    ]);
  } finally {
    cleanup();
  }
});
