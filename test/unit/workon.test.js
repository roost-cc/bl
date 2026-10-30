import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { resolveWorkonTargets } from '../../src/workon.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

function fixture() {
  return mkTempBacklog({
    components: [
      { id: 'C01', title: 'One', dirSuffix: 'one' },
      { id: 'C02', title: 'Two', dirSuffix: 'two' },
    ],
    stories: [
      // C01: a startable refined story, a refined story blocked by S-10,
      // a refined story whose dep (S-90) is done, plus non-refined noise.
      {
        id: 'S-10',
        component: 'C01',
        title: 'Ten',
        dirSuffix: 'ten',
        status: 'refined',
      },
      {
        id: 'S-11',
        component: 'C01',
        title: 'Eleven',
        dirSuffix: 'eleven',
        status: 'refined',
        depends_on: ['S-10'],
      },
      {
        id: 'S-12',
        component: 'C01',
        title: 'Twelve',
        dirSuffix: 'twelve',
        status: 'refined',
        depends_on: ['S-90'],
      },
      {
        id: 'S-13',
        component: 'C01',
        title: 'Thirteen',
        dirSuffix: 'thirteen',
        status: 'backlog',
      },
      {
        id: 'S-14',
        component: 'C01',
        title: 'Fourteen',
        dirSuffix: 'fourteen',
        status: 'in_progress',
      },
      {
        id: 'S-15',
        component: 'C01',
        title: 'Fifteen',
        dirSuffix: 'fifteen',
        status: 'done',
        completed: '2026-01-01',
      },
      // C02: a done story used as a satisfied dependency for S-12.
      {
        id: 'S-90',
        component: 'C02',
        title: 'Ninety',
        dirSuffix: 'ninety',
        status: 'done',
        completed: '2026-01-01',
      },
    ],
  });
}

const ids = (list) => list.map((t) => t.id);

test('component expands to refined stories only, gated by dependencies', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { startable, deferred, errors, notices } = resolveWorkonTargets(['C01'], cfg);
    // backlog (S-13), in_progress (S-14), done (S-15) are excluded from the
    // component expansion; only refined S-10/S-11/S-12 are considered.
    assert.deepEqual(ids(startable), ['S-10', 'S-12']);
    assert.deepEqual(ids(deferred), ['S-11']);
    assert.deepEqual(deferred[0].blockers, ['S-10']);
    assert.deepEqual(errors, []);
    assert.deepEqual(notices, []);
    assert.ok(startable.every((t) => t.source === 'component'));
  } finally {
    cleanup();
  }
});

test('a story whose dependency is already done is startable', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { startable, deferred } = resolveWorkonTargets(['S-12'], cfg);
    assert.deepEqual(ids(startable), ['S-12']);
    assert.deepEqual(ids(deferred), []);
  } finally {
    cleanup();
  }
});

test('a same-batch dependency defers its dependent (not yet merged)', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    // Naming both S-10 and S-11: S-10 is startable, but S-11 depends on S-10,
    // which is refined (not done), so S-11 defers this run.
    const { startable, deferred } = resolveWorkonTargets(['S-10', 'S-11'], cfg);
    assert.deepEqual(ids(startable), ['S-10']);
    assert.deepEqual(ids(deferred), ['S-11']);
    assert.deepEqual(deferred[0].blockers, ['S-10']);
  } finally {
    cleanup();
  }
});

test('a named in_progress story is included', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { startable } = resolveWorkonTargets(['S-14'], cfg);
    assert.deepEqual(ids(startable), ['S-14']);
    assert.equal(startable[0].source, 'named');
  } finally {
    cleanup();
  }
});

test('a named backlog story is skipped with a refine-first notice', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { startable, deferred, notices } = resolveWorkonTargets(['S-13'], cfg);
    assert.deepEqual(ids(startable), []);
    assert.deepEqual(ids(deferred), []);
    assert.ok(notices.some((n) => n.includes('S-13') && n.includes('refined first')));
  } finally {
    cleanup();
  }
});

test('a named done story is skipped with a notice', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { startable, notices } = resolveWorkonTargets(['S-15'], cfg);
    assert.deepEqual(ids(startable), []);
    assert.ok(notices.some((n) => n.includes('S-15') && n.includes('done')));
  } finally {
    cleanup();
  }
});

test('a named story outranks the same story pulled in via its component', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    // S-11 comes in via C01 (source component) and is also named (source named);
    // the named source wins, and it stays deferred (blocked on S-10).
    const { startable, deferred } = resolveWorkonTargets(['C01', 'S-11'], cfg);
    assert.deepEqual(ids(startable), ['S-10', 'S-12']);
    assert.deepEqual(ids(deferred), ['S-11']);
    assert.equal(deferred[0].source, 'named');
  } finally {
    cleanup();
  }
});

test('a component with no refined stories yields a notice, not an error', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { startable, deferred, errors, notices } = resolveWorkonTargets(['C02'], cfg);
    assert.deepEqual(ids(startable), []);
    assert.deepEqual(ids(deferred), []);
    assert.deepEqual(errors, []);
    assert.ok(notices.some((n) => n.includes('C02')));
  } finally {
    cleanup();
  }
});

test('unknown component and invalid id produce errors', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { startable, errors } = resolveWorkonTargets(['C09', 'nonsense'], cfg);
    assert.deepEqual(ids(startable), []);
    assert.equal(errors.length, 2);
    assert.ok(errors.some((e) => e.includes('C09')));
    assert.ok(errors.some((e) => e.includes('nonsense')));
  } finally {
    cleanup();
  }
});
