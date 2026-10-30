import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { classifyId, resolveTargets } from '../../src/targets.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

function fixture() {
  return mkTempBacklog({
    components: [{ id: 'C01', title: 'One', dirSuffix: 'one' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'Loose', dirSuffix: 'loose', status: 'refined' },
      { id: 'S-2', component: 'C01', title: 'In feature', dirSuffix: 'in-feature', status: 'refined', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'approved', stories: ['S-2'] }],
  });
}

function withConfig(fn) {
  const { dir, cleanup } = fixture();
  try {
    fn(loadConfig({ backlogRoot: dir }));
  } finally {
    cleanup();
  }
}

test('classifyId reads the kind from the prefix, in any accepted spelling', () => {
  assert.equal(classifyId('S-34').kind, 'story');
  assert.equal(classifyId('s34').parsed.id, 'S-34');
  assert.equal(classifyId('F-3').kind, 'feature');
  assert.equal(classifyId('f3').parsed.id, 'F-3');
  assert.equal(classifyId('C1').kind, 'component');
  assert.equal(classifyId('c-01').parsed.id, 'C01');
  assert.equal(classifyId('E1'), null, 'an E-id is no longer a code boundary');
  assert.equal(classifyId('X-1'), null);
  assert.equal(classifyId('S-'), null);
});

test('resolveTargets classifies a story, a feature and a component with their records', () => {
  withConfig((config) => {
    const { targets, errors } = resolveTargets(['s1', 'F-1', 'C1'], config, null);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      targets.map((t) => [t.kind, t.id]),
      [
        ['story', 'S-1'],
        ['feature', 'F-1'],
        ['component', 'C01'],
      ],
    );
    assert.equal(targets[0].record.status, 'refined');
    assert.equal(targets[1].record.featureEntry, 'F1-feat');
    assert.equal(targets[2].record.componentEntry, 'C01-one');
  });
});

test('resolveTargets keeps the given order and drops a repeated id', () => {
  withConfig((config) => {
    const { targets } = resolveTargets(['C01', 'S-1', 'F-1', 's-1'], config, null);
    assert.deepEqual(
      targets.map((t) => t.id),
      ['C01', 'S-1', 'F-1'],
    );
  });
});

test('resolveTargets tells an E-id that components are C-ids (F-49 D2)', () => {
  withConfig((config) => {
    const { targets, errors } = resolveTargets(['E01', 'S-1'], config, 'refine');
    assert.deepEqual(
      targets.map((t) => t.id),
      ['S-1'],
    );
    assert.deepEqual(errors, ['E01 is not a component id: components are C-ids (C01).']);
  });
});

test('resolveTargets reports malformed and unknown ids as errors and keeps the rest', () => {
  withConfig((config) => {
    const { targets, errors } = resolveTargets(['foo', 'S-99', 'F-9', 'C09', 'S-1'], config, null);
    assert.deepEqual(
      targets.map((t) => t.id),
      ['S-1'],
    );
    assert.equal(errors.length, 4);
    assert.match(
      errors[0],
      /^Invalid id: foo \(expected a story like S-34, a feature like F-3 or a component like C01\)/,
    );
    assert.match(errors[1], /Story S-99 not found/);
    assert.match(errors[2], /Feature F-9 not found/);
    assert.match(errors[3], /Component C09 not found/);
  });
});

test('run and implement refuse a component, pointing at bl new --feature; done refuses it too', () => {
  withConfig((config) => {
    for (const verb of ['run', 'implement']) {
      const { targets, errors } = resolveTargets(['C01'], config, verb);
      assert.deepEqual(targets, []);
      assert.deepEqual(errors, [
        'C01 is a component. Make the stories you want into a feature: `bl new --feature --title … S-1 S-2`',
      ]);
    }
    for (const verb of ['review', 'merge', 'approve']) {
      assert.match(
        resolveTargets(['C01'], config, verb).errors[0],
        new RegExp(`C01 is a component; bl ${verb} takes a story or a feature`),
      );
    }
    assert.deepEqual(resolveTargets(['C01'], config, 'done').errors, [
      'C01 is a component: a code boundary with no status, so it is never done.',
    ]);
    for (const verb of ['refine', 'status']) {
      assert.deepEqual(resolveTargets(['C01'], config, verb).errors, [], verb);
    }
  });
});

test('run, implement, review and merge refuse a story that belongs to a feature, naming it', () => {
  withConfig((config) => {
    for (const verb of ['run', 'implement', 'review', 'merge']) {
      const { targets, errors } = resolveTargets(['S-2'], config, verb);
      assert.deepEqual(targets, [], verb);
      assert.deepEqual(errors, ['S-2 is part of F-1; use F-1'], verb);
      assert.deepEqual(resolveTargets(['S-1'], config, verb).errors, [], `${verb} takes a loose story`);
    }
    for (const verb of ['refine', 'status', 'done']) {
      assert.deepEqual(resolveTargets(['S-2'], config, verb).errors, [], verb);
    }
  });
});

test('approve refuses a story; done refuses a feature', () => {
  withConfig((config) => {
    assert.match(resolveTargets(['S-1'], config, 'approve').errors[0], /S-1 is a story; stories have no approve step/);
    assert.deepEqual(resolveTargets(['F-1'], config, 'approve').errors, []);
    assert.deepEqual(resolveTargets(['F-1'], config, 'done').errors, ['F-1 is a feature; bl merge F-1 marks it done.']);
  });
});
