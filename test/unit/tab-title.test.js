// tab-title.js: one code path for the terminal tab's title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { delimiter, join } from 'path';
import { spawnToFiles } from '../helpers/spawn-files.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { withEnv } from '../helpers/fake-pagers.js';
import {
  DEFAULT_TAB_TITLE_FORMAT,
  captureTmuxWindowId,
  clearTabTitle,
  currentTabTitle,
  endTabTitle,
  finalTabTitle,
  reassertTabTitle,
  renderTabTitle,
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

// The module keeps its fields, the end state it owes and the final mark for the process; every test starts with none.
test.beforeEach(() => {
  underFakeTmux(() => endTabTitle(0));
  withEnv({ BL_TAB_TITLE: '' }, () => clearTabTitle());
});
// Titles off when the test process exits, so the exit hook never reaches the real tmux.
test.after(() => {
  process.env.BL_TAB_TITLE = '';
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('the default format is feature : story : status next', () => {
  assert.equal(DEFAULT_TAB_TITLE_FORMAT, '{{feature}} : {{story}} : {{status}} {{next}}');
  assert.equal(
    renderTabTitle({ feature: 'F-56', story: 'S-210', status: 'testing' }, DEFAULT_TAB_TITLE_FORMAT),
    'F-56 : S-210 : testing',
  );
  assert.equal(
    renderTabTitle({ feature: 'F-56', status: 'clean', next: '→ bl merge' }, DEFAULT_TAB_TITLE_FORMAT),
    'F-56 :  : clean → bl merge',
  );
});

test('BL_TAB_TITLE can move the next field or leave it out', () => {
  const values = { story: 'S-1', status: 'clean', next: '→ bl merge' };
  withEnv({ BL_TAB_TITLE: '{{next}} | {{story}}' }, () => assert.equal(renderTabTitle(values), '→ bl merge | S-1'));
  withEnv({ BL_TAB_TITLE: '{{story}} {{status}}' }, () => assert.equal(renderTabTitle(values), 'S-1 clean'));
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

/** Run `fn` outside tmux with stderr as a fake terminal; returns what was written to it. */
function underFakeTerminal(fn) {
  const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  const write = process.stderr.write;
  const out = [];
  withEnv({ TMUX: undefined, BL_TAB_TITLE: undefined }, () => {
    process.stderr.isTTY = true;
    process.stderr.write = (s) => (out.push(s), true);
    try {
      fn();
    } finally {
      process.stderr.write = write;
      if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
      else delete process.stderr.isTTY;
    }
  });
  return out;
}

test('OSC 2 path pads a shorter title and never uses the title stack', () => {
  const out = underFakeTerminal(() => {
    updateTabTitle({ feature: 'F-56', story: 'S-210', status: 'implement' });
    updateTabTitle('status', 'test');
    endTabTitle(0);
  });
  assert.deepEqual(out, [
    '\x1b]2;F-56 : S-210 : implement\x07',
    `\x1b]2;${'F-56 : S-210 : test'.padEnd(24)}\x07`,
    '\x1b]2;F-56 : S-210 : ended\x07',
  ]);
  assert.ok(!out.some((s) => s.includes('\x1b[22;2t') || s.includes('\x1b[23;2t')), 'no XTWINOPS 22/23');
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

test('reassertTabTitle pads to the current width', () => {
  underFakeTmux((fake) => {
    updateTabTitle({ feature: 'F-56', story: 'S-210', status: 'implement' });
    updateTabTitle('status', 'test');
    reassertTabTitle();
    assert.equal(fake.calls()[2], `rename-window\n-t\n@7\n--\n${'F-56 : S-210 : test'.padEnd(24)}\n`);
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
// final title and exit
// ---------------------------------------------------------------------------

test('a final title is sent unpadded', () => {
  underFakeTmux((fake) => {
    updateTabTitle({ feature: 'F-56', story: 'S-210', status: 'implementing' });
    finalTabTitle({ story: '', status: 'clean', next: '→ bl merge' });
    reassertTabTitle();
    assert.deepEqual(fake.calls().slice(1), [
      'rename-window\n-t\n@7\n--\nF-56 :  : clean → bl merge\n',
      'rename-window\n-t\n@7\n--\nF-56 :  : clean → bl merge\n',
    ]);
  });
});

test('exit after a final title sends nothing, and never turns automatic-rename on', () => {
  underFakeTmux((fake) => {
    updateTabTitle({ feature: 'F-56', status: 'review' });
    finalTabTitle({ status: 'escalated', next: '→ fix, --resume' });
    endTabTitle(0);
    endTabTitle(0);
    assert.deepEqual(fake.calls(), [
      'rename-window\n-t\n@7\n--\nF-56 :  : review\n',
      'rename-window\n-t\n@7\n--\nF-56 :  : escalated → fix, --resume\n',
    ]);
  });
});

test('exit without a final title shows ended / interrupted / failed (exit N), unpadded, and drops next', () => {
  for (const [code, status] of [
    [0, 'ended'],
    [130, 'interrupted'],
    [143, 'interrupted'],
    [2, 'failed (exit 2)'],
  ]) {
    underFakeTmux((fake) => {
      updateTabTitle({ story: 'S-1', status: 'implementing', next: '→ x' });
      endTabTitle(code);
      const calls = fake.calls();
      assert.equal(calls.length, 2, `code ${code}`);
      assert.equal(calls[1], `rename-window\n-t\n@7\n--\n: S-1 : ${status}\n`, `code ${code}`);
      assert.ok(!calls.some((c) => c.includes('automatic-rename')));
    });
  }
});

test('a later update clears the final mark, so the exit shows ended', () => {
  underFakeTmux((fake) => {
    finalTabTitle({ story: 'S-1', status: 'done' });
    updateTabTitle('status', 'review');
    endTabTitle(0);
    assert.equal(fake.calls().at(-1), 'rename-window\n-t\n@7\n--\n: S-1 : ended\n');
  });
});

test('a later update after a final title drops next', () => {
  for (const [name, update, title] of [
    ['one field, no next', () => updateTabTitle('status', 'implement'), 'F-2 :  : implement'],
    ['several fields, no next', () => updateTabTitle({ story: 'S-1', status: 'fix' }), 'F-2 : S-1 : fix'],
    ['next set again', () => updateTabTitle({ status: 'fix', next: '→ x' }), 'F-2 :  : fix → x'],
  ]) {
    underFakeTmux((fake) => {
      updateTabTitle({ feature: 'F-2', story: null });
      finalTabTitle({ status: 'clean', next: '→ bl merge' });
      update();
      assert.equal(fake.calls().at(-1).split('\n')[4].trimEnd(), title, name);
    });
  }
  underFakeTmux((fake) => {
    updateTabTitle({ feature: 'F-2', story: null, status: 'review', next: '→ y' });
    updateTabTitle('status', 'fix');
    assert.equal(fake.calls().at(-1).split('\n')[4].trimEnd(), 'F-2 :  : fix → y', 'no final title: next stays');
  });
});

test('the exit hook does nothing before a title or with titles off', () => {
  underFakeTmux((fake) => {
    endTabTitle(1);
    assert.deepEqual(fake.calls(), [], 'nothing before a title');
    updateTabTitle('status', 'x');
    withEnv({ BL_TAB_TITLE: '' }, () => {
      finalTabTitle({ status: 'clean' });
      endTabTitle(1);
    });
    assert.deepEqual(fake.calls(), ['rename-window\n-t\n@7\n--\n:  : x\n']);
  });
});

test('after the exit hook the next title is not padded', () => {
  underFakeTmux((fake) => {
    updateTabTitle({ feature: 'F-56', story: 'S-210', status: 'implement' });
    endTabTitle(0);
    updateTabTitle({ feature: null, story: null, status: 'x' });
    assert.equal(fake.calls()[2], 'rename-window\n-t\n@7\n--\n:  : x\n');
  });
});

// ---------------------------------------------------------------------------
// signals (in a child process: the handlers belong to the whole process)
// ---------------------------------------------------------------------------

/**
 * Run `body` as an ES module in a child `node` under a fake tmux, send it
 * `signal` once it prints `ready`, and resolve with its exit code, signal
 * and the fake tmux's calls. `src(name)` in `body` is the URL of `src/<name>`.
 */
async function signalChild(body, signal) {
  const fake = fakeTmux();
  const src = (name) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);
  const code = `${body.replace(/src\((\w[\w.-]*)\)/g, (_, n) => src(n))}\nprocess.stdout.write('ready\\n');\n`;
  const env = {
    ...process.env,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    TMUX: '/tmp/tmux-fake,1,0',
    BL_TMUX_WINDOW_ID: '@7',
  };
  delete env.BL_TAB_TITLE;
  const run = spawnToFiles(process.execPath, ['--input-type=module', '-e', code], { env });
  const { child } = run;
  while (!run.read().stdout.includes('ready\n')) await new Promise((r) => setTimeout(r, 10));
  // A blocking spawnSync is called after `ready`; give the child a moment to enter it.
  await new Promise((r) => setTimeout(r, 300));
  const started = Date.now();
  child.kill(signal);
  const { status: exitCode, signal: exitSignal } = await run.closed;
  return { exitCode, exitSignal, ms: Date.now() - started, calls: fake.calls() };
}

for (const [signal, number] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
]) {
  test(`a command that sets no title still ends on ${signal} during spawnSync`, async () => {
    // config.js is the import chain most commands load; it reaches tab-title.js.
    const r = await signalChild(
      `await import(src(config.js)); await import(src(tab-title.js));
       setTimeout(() => import('child_process').then((cp) => cp.spawnSync('sleep', ['5'])), 0);`,
      signal,
    );
    assert.equal(r.exitSignal, signal, `Node's default action (exit ${r.exitCode})`);
    assert.ok(r.ms < 3000, `ended at once, not after the child (${r.ms} ms)`);
    assert.deepEqual(r.calls, []);
  });

  test(`a signalled process ends its title as interrupted (${signal})`, async () => {
    const r = await signalChild(
      `const t = await import(src(tab-title.js));
       t.updateTabTitle({ story: 'S-1', status: 'implement', next: '→ x' });
       setInterval(() => {}, 1000);`,
      signal,
    );
    assert.deepEqual([r.exitCode, r.exitSignal], [number, null]);
    assert.equal(r.calls.at(-1), 'rename-window\n-t\n@7\n--\n: S-1 : interrupted\n');
  });

  test(`a signal after finalTabTitle keeps the final title (${signal})`, async () => {
    const r = await signalChild(
      `const t = await import(src(tab-title.js));
       t.updateTabTitle({ feature: 'F-2', status: 'review' });
       t.finalTabTitle({ status: 'clean', next: '→ bl merge' });
       setInterval(() => {}, 1000);`,
      signal,
    );
    assert.deepEqual([r.exitCode, r.exitSignal], [number, null]);
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls.at(-1), 'rename-window\n-t\n@7\n--\nF-2 :  : clean → bl merge\n');
  });

  test(`a process that loads lock.js ends on ${signal} with exit ${number}`, async () => {
    const r = await signalChild(`await import(src(lock.js)); setInterval(() => {}, 1000);`, signal);
    assert.deepEqual([r.exitCode, r.exitSignal], [number, null]);
  });
}

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
