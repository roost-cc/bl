// tab-title.js: one code path for the terminal tab's title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { delimiter, join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { withEnv } from '../helpers/fake-pagers.js';
import {
  DEFAULT_TAB_TITLE_FORMAT,
  captureTmuxWindowId,
  clearTabTitle,
  currentTabTitle,
  reassertTabTitle,
  renderTabTitle,
  restoreTabTitle,
  tabTitleFields,
  unitTitleFields,
  updateTabTitle,
} from '../../src/tab-title.js';

/** A temp dir on PATH holding a fake `tmux` that appends its arguments, one per line, to `record`. */
function fakeTmux() {
  const dir = mkTempDir('bl-tmux-');
  const record = join(dir, 'record');
  writeFileSync(
    join(dir, 'tmux'),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${record}'\nprintf '\\036\\n' >> '${record}'\n`,
  );
  chmodSync(join(dir, 'tmux'), 0o755);
  return {
    dir,
    record,
    calls: () => (existsSync(record) ? readFileSync(record, 'utf8').split('\x1e\n').filter(Boolean) : []),
  };
}

/** Run `fn` under a fake tmux: `TMUX` set, a captured window id, titles on. */
function underFakeTmux(fn) {
  const fake = fakeTmux();
  return withEnv(
    {
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      TMUX: '/tmp/tmux-fake,1,0',
      BL_TMUX_WINDOW_ID: '@7',
      BL_TAB_TITLE: undefined,
    },
    () => fn(fake),
  );
}

// The module keeps its fields, and the restore it owes, for the process; every test starts with neither.
test.beforeEach(() => {
  withEnv({ BL_TAB_TITLE: '' }, () => clearTabTitle());
  underFakeTmux(() => restoreTabTitle());
});
// Titles off when the test process exits, so the exit restore never reaches the real tmux.
test.after(() => {
  process.env.BL_TAB_TITLE = '';
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('the default format is feature : story : status', () => {
  assert.equal(DEFAULT_TAB_TITLE_FORMAT, '{{feature}} : {{story}} : {{status}}');
  assert.equal(
    renderTabTitle({ feature: 'F-56', story: 'S-210', status: 'testing' }, DEFAULT_TAB_TITLE_FORMAT),
    'F-56 : S-210 : testing',
  );
});

test('a missing field renders as nothing and the title is trimmed', () => {
  assert.equal(
    renderTabTitle({ story: 'S-210', status: 'implementing' }, DEFAULT_TAB_TITLE_FORMAT),
    ': S-210 : implementing',
  );
  assert.equal(
    renderTabTitle({ feature: 'F-123', status: 'refining' }, DEFAULT_TAB_TITLE_FORMAT),
    'F-123 :  : refining',
  );
  assert.equal(
    renderTabTitle({ feature: 'F-1', story: null, status: undefined }, DEFAULT_TAB_TITLE_FORMAT),
    'F-1 :  :',
  );
  assert.equal(renderTabTitle({}, DEFAULT_TAB_TITLE_FORMAT), ':  :');
});

test('BL_TAB_TITLE is the format; any field name works, unknown ones render as nothing', () => {
  withEnv({ BL_TAB_TITLE: '[{{foo}}] {{status}} {{ nope }}' }, () => {
    assert.equal(renderTabTitle({ foo: 'bar', status: 'x' }), '[bar] x');
  });
  withEnv({ BL_TAB_TITLE: undefined }, () => {
    assert.equal(renderTabTitle({ feature: 'F-2' }), 'F-2 :  :');
  });
});

test('unitTitleFields names the feature or the story a unit id stands for', () => {
  assert.deepEqual(unitTitleFields('F-56'), { feature: 'F-56' });
  assert.deepEqual(unitTitleFields('S-210'), { story: 'S-210' });
  assert.deepEqual(unitTitleFields('refine-batch'), {});
  assert.deepEqual(unitTitleFields('C01'), {});
  assert.deepEqual(unitTitleFields(undefined), {});
});

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

test('updateTabTitle sets one field or several, keeps the rest, and unsets on an empty value', () => {
  withEnv({ BL_TAB_TITLE: '' }, () => {
    updateTabTitle('story', 'S-34');
    assert.deepEqual(tabTitleFields(), { story: 'S-34' });
    updateTabTitle({ feature: 'F-5', status: 'implement' });
    assert.deepEqual(tabTitleFields(), { story: 'S-34', feature: 'F-5', status: 'implement' });
    updateTabTitle('foo', 'bar'); // any name is valid
    assert.equal(tabTitleFields().foo, 'bar');
    updateTabTitle('story', '');
    updateTabTitle({ foo: null });
    assert.deepEqual(tabTitleFields(), { feature: 'F-5', status: 'implement' });
    updateTabTitle('status', 42);
    assert.equal(tabTitleFields().status, '42');
  });
});

test('currentTabTitle is the rendered fields, or null when titles are off', () => {
  withEnv({ BL_TAB_TITLE: '' }, () => {
    updateTabTitle({ feature: 'F-5', status: 'review' });
    assert.equal(currentTabTitle(), null);
  });
  withEnv({ BL_TAB_TITLE: undefined, TMUX: undefined }, () => {
    assert.equal(currentTabTitle(), 'F-5 :  : review');
  });
});

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

test('under tmux every update renames the captured window, after --', () => {
  underFakeTmux((fake) => {
    updateTabTitle({ feature: 'F-56', status: 'refine' });
    updateTabTitle('story', 'S-210');
    assert.deepEqual(fake.calls(), [
      'rename-window\n-t\n@7\n--\nF-56 :  : refine\n',
      'rename-window\n-t\n@7\n--\nF-56 : S-210 : refine\n',
    ]);
  });
});

test('without a captured id the current window is renamed', () => {
  const fake = fakeTmux();
  withEnv(
    {
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      TMUX: '/tmp/tmux-fake,1,0',
      BL_TMUX_WINDOW_ID: undefined,
      BL_TAB_TITLE: undefined,
    },
    () => {
      updateTabTitle('status', 'agent');
      assert.deepEqual(fake.calls(), ['rename-window\n--\n:  : agent\n']);
    },
  );
});

test('reassertTabTitle sends the current title again, and nothing before the first update', () => {
  underFakeTmux((fake) => {
    reassertTabTitle();
    assert.deepEqual(fake.calls(), []);
    updateTabTitle({ story: 'S-1', status: 'triage' });
    reassertTabTitle();
    assert.deepEqual(fake.calls(), [
      'rename-window\n-t\n@7\n--\n: S-1 : triage\n',
      'rename-window\n-t\n@7\n--\n: S-1 : triage\n',
    ]);
  });
});

test('an empty BL_TAB_TITLE turns titles off: fields are kept, tmux is never called', () => {
  const fake = fakeTmux();
  withEnv(
    {
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      TMUX: '/tmp/tmux-fake,1,0',
      BL_TMUX_WINDOW_ID: '@7',
      BL_TAB_TITLE: '',
    },
    () => {
      updateTabTitle({ story: 'S-1', status: 'merge' });
      reassertTabTitle();
      assert.deepEqual(fake.calls(), []);
      assert.deepEqual(tabTitleFields(), { story: 'S-1', status: 'merge' });
    },
  );
});

test('outside tmux with no terminal, updates do nothing and do not throw', () => {
  // node --test runs this file in a child whose stderr is a pipe, so the OSC path is skipped.
  withEnv({ TMUX: undefined, BL_TAB_TITLE: undefined }, () => {
    assert.doesNotThrow(() => updateTabTitle({ story: 'S-123', status: 'refine' }));
    assert.doesNotThrow(() => reassertTabTitle());
  });
});

test('a title starting with - is still a name, never a tmux option', () => {
  withEnv({ BL_TAB_TITLE: '-{{status}}' }, () => {
    underFakeTmux((fake) => {
      withEnv({ BL_TAB_TITLE: '-{{status}}' }, () => updateTabTitle('status', 'x'));
      assert.deepEqual(fake.calls(), ['rename-window\n-t\n@7\n--\n-x\n']);
    });
  });
});

test('a shorter title is padded to the widest title shown; a longer one raises the width', () => {
  underFakeTmux((fake) => {
    updateTabTitle({ feature: 'F-56', story: 'S-210', status: 'implement' });
    updateTabTitle('status', 'test');
    assert.equal(currentTabTitle(), 'F-56 : S-210 : test');
    updateTabTitle('status', 'implementing');
    updateTabTitle('status', 'x');
    const name = (i) => fake.calls()[i].split('\n')[4];
    assert.equal(name(0), 'F-56 : S-210 : implement');
    assert.equal(name(1), 'F-56 : S-210 : test'.padEnd(24));
    assert.equal(name(2), 'F-56 : S-210 : implementing');
    assert.equal(name(3), 'F-56 : S-210 : x'.padEnd(27));
  });
});

test('OSC 2 path pads a shorter title', () => {
  const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  const write = process.stderr.write;
  const out = [];
  withEnv({ TMUX: undefined, BL_TAB_TITLE: undefined }, () => {
    process.stderr.isTTY = true;
    process.stderr.write = (s) => (out.push(s), true);
    try {
      updateTabTitle({ feature: 'F-56', story: 'S-210', status: 'implement' });
      updateTabTitle('status', 'test');
    } finally {
      process.stderr.write = write;
      if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
      else delete process.stderr.isTTY;
    }
  });
  assert.equal(out[0], '\x1b[22;2t\x1b]2;F-56 : S-210 : implement\x07');
  assert.equal(out[1], `\x1b]2;${'F-56 : S-210 : test'.padEnd(24)}\x07`);
});

test('a title set while titles are off does not change the width', () => {
  underFakeTmux((fake) => {
    updateTabTitle({ feature: 'F-56', story: 'S-210', status: 'test' });
    withEnv({ BL_TAB_TITLE: '' }, () => updateTabTitle('status', 'implementing'));
    updateTabTitle('status', 'x');
    assert.equal(fake.calls().length, 2);
    assert.equal(fake.calls()[1], `rename-window\n-t\n@7\n--\n${'F-56 : S-210 : x'.padEnd(19)}\n`);
  });
});

test('clearTabTitle keeps the width', () => {
  underFakeTmux((fake) => {
    updateTabTitle({ feature: 'F-56', story: 'S-210', status: 'implement' });
    clearTabTitle();
    assert.equal(fake.calls()[1], `rename-window\n-t\n@7\n--\n${':  :'.padEnd(24)}\n`);
    assert.equal(currentTabTitle(), ':  :');
  });
});

// ---------------------------------------------------------------------------
// restore on exit
// ---------------------------------------------------------------------------

test('restoreTabTitle turns automatic-rename on for the captured window, once, after a title was set', () => {
  underFakeTmux((fake) => {
    restoreTabTitle();
    assert.deepEqual(fake.calls(), [], 'nothing to restore before a title');
    updateTabTitle({ story: 'S-1', status: 'implement' });
    restoreTabTitle();
    restoreTabTitle();
    assert.deepEqual(fake.calls(), [
      'rename-window\n-t\n@7\n--\n: S-1 : implement\n',
      'set-option\n-w\n-t\n@7\nautomatic-rename\non\n',
    ]);
    // The next title owes a new restore.
    updateTabTitle('status', 'review');
    restoreTabTitle();
    assert.equal(fake.calls().length, 4);
  });
});

test('restoreTabTitle does nothing with titles off', () => {
  underFakeTmux((fake) => {
    updateTabTitle('status', 'x');
    withEnv({ BL_TAB_TITLE: '' }, () => restoreTabTitle());
    assert.deepEqual(fake.calls(), ['rename-window\n-t\n@7\n--\n:  : x\n']);
    restoreTabTitle(); // titles on again: the restore owed is paid
    assert.equal(fake.calls().length, 2);
  });
});

test('after restoreTabTitle the next title is not padded', () => {
  underFakeTmux((fake) => {
    updateTabTitle({ feature: 'F-56', story: 'S-210', status: 'implement' });
    restoreTabTitle();
    updateTabTitle({ feature: null, story: null, status: 'x' });
    assert.equal(fake.calls()[2], 'rename-window\n-t\n@7\n--\n:  : x\n');
  });
});

// ---------------------------------------------------------------------------
// window id capture
// ---------------------------------------------------------------------------

test('captureTmuxWindowId is a no-op when not under tmux', () => {
  withEnv({ TMUX: undefined, BL_TMUX_WINDOW_ID: undefined }, () => {
    captureTmuxWindowId();
    assert.equal(process.env.BL_TMUX_WINDOW_ID, undefined);
  });
});

test('captureTmuxWindowId does not overwrite an already-captured id', () => {
  const fake = fakeTmux();
  withEnv(
    { PATH: `${fake.dir}${delimiter}${process.env.PATH}`, TMUX: '/tmp/tmux-fake,1,0', BL_TMUX_WINDOW_ID: '@7' },
    () => {
      captureTmuxWindowId();
      assert.equal(process.env.BL_TMUX_WINDOW_ID, '@7');
      assert.deepEqual(fake.calls(), []); // tmux is never consulted
    },
  );
});

test('captureTmuxWindowId asks tmux for the window id once', () => {
  const dir = mkTempDir('bl-tmux-');
  writeFileSync(join(dir, 'tmux'), '#!/bin/sh\necho @42\n');
  chmodSync(join(dir, 'tmux'), 0o755);
  withEnv(
    { PATH: `${dir}${delimiter}${process.env.PATH}`, TMUX: '/tmp/tmux-fake,1,0', BL_TMUX_WINDOW_ID: undefined },
    () => {
      captureTmuxWindowId();
      assert.equal(process.env.BL_TMUX_WINDOW_ID, '@42');
    },
  );
});
