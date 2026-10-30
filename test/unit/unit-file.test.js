/**
 * Unit tests for `findUnitFile` (S-1108), the lookup `bl which`, `bl view`
 * and `bl edit` share: a feature, story, component or task id to its file
 * and directory, or the message for a missing or invalid id.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { componentIdHint, loadConfig } from '../../src/config.js';
import { newTaskFile } from '../../src/task.js';
import { findUnitFile } from '../../src/unit-file.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

function fixture() {
  const { dir, cleanup } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', feature: 'F-1' }],
    features: [{ id: 'F-1', title: 'One', status: 'approved', stories: ['S-1'] }],
  });
  const cfg = loadConfig({ backlogRoot: dir });
  mkdirSync(join(dir, 'tasks'));
  const task = newTaskFile(cfg, { id: 'T-1', title: 'Run it', unit: 'F-1', date: '2026-10-28' });
  writeFileSync(task.path, task.text);
  return { dir, cfg, cleanup };
}

test('findUnitFile resolves a feature, story, component and task to its file and directory', () => {
  const { dir, cfg, cleanup } = fixture();
  try {
    const file = (rel) => join(dir, rel, 'index.md');
    assert.deepEqual(findUnitFile('F1', cfg), {
      kind: 'feature',
      id: 'F-1',
      indexPath: file('features/F1'),
      dir: join(dir, 'features/F1'),
    });
    assert.deepEqual(findUnitFile('S-1', cfg), {
      kind: 'story',
      id: 'S-1',
      indexPath: file('stories/S1'),
      dir: join(dir, 'stories/S1'),
    });
    assert.deepEqual(findUnitFile('C01', cfg), {
      kind: 'component',
      id: 'C01',
      indexPath: file('components/C01'),
      dir: join(dir, 'components/C01'),
    });
    const task = { kind: 'task', id: 'T-1', indexPath: join(dir, 'tasks', 'T1-run-it.md'), dir: join(dir, 'tasks') };
    for (const raw of ['T-1', 't1', 'T-01']) assert.deepEqual(findUnitFile(raw, cfg), task, raw);
  } finally {
    cleanup();
  }
});

test('findUnitFile names a missing id of each kind, the component hint for E<n>, and an invalid id', () => {
  const { cfg, cleanup } = fixture();
  try {
    assert.deepEqual(findUnitFile('F-9', cfg), { error: 'Feature F-9 not found.' });
    assert.deepEqual(findUnitFile('S-9', cfg), { error: 'Story S-9 not found.' });
    assert.deepEqual(findUnitFile('C09', cfg), { error: 'Component C09 not found.' });
    assert.deepEqual(findUnitFile('T-99', cfg), { error: 'Task T-99 not found.' });
    const hint = componentIdHint('E10');
    assert.ok(hint, 'E10 has a component-id hint');
    assert.deepEqual(findUnitFile('E10', cfg), { error: hint });
    assert.deepEqual(findUnitFile('X-1', cfg), { error: 'Invalid id: X-1' });
  } finally {
    cleanup();
  }
});

test('findUnitFile: no tasks/ directory, or a task file with no task_id, is a task not found', () => {
  const { dir, cleanup } = mkTempBacklog({ components: [{ id: 'C01', title: 'Work' }] });
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    assert.deepEqual(findUnitFile('T-1', cfg), { error: 'Task T-1 not found.' });
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(join(dir, 'tasks', 'T1-no-id.md'), '---\ntitle: No id\n---\n');
    assert.deepEqual(findUnitFile('T-1', cfg), { error: 'Task T-1 not found.' });
  } finally {
    cleanup();
  }
});
