import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { commandLeader, commandWords, enumeratePlugins } from '../../src/config.js';
import { probeBinary, probePluginBinaries, formatPluginStatus, resetProbeCache } from '../../src/plugin-binaries.js';
import { mkTempDir } from '../helpers/tempdir.js';

function makeBinDir(names) {
  const dir = mkTempDir('bl-plugin-bins-');
  for (const name of names) {
    const p = join(dir, name);
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
  }
  return dir;
}

test('enumeratePlugins groups stages by first-token', () => {
  const cfg = {
    plugins: {
      prettier: {
        format: 'prettier --write {{path}}',
        extensions: ['.md'], // non-string — ignored
      },
      ruff: {
        format: 'ruff format {{path}}',
        lint: 'ruff check {{path}}',
      },
    },
  };
  const out = enumeratePlugins(cfg);
  assert.equal(out.length, 2);
  const ruff = out.find((e) => e.key === 'ruff');
  assert.deepEqual(ruff.stages.sort(), ['format', 'lint']);
  assert.equal(ruff.firstToken, 'ruff');
});

test('commandLeader keeps a {{var}} leader intact and still strips subshell braces', () => {
  // The brace strip is for `(cmd)` / `{ cmd; }` forms; a template token is
  // not shell grouping, and stripping it left the dead `roostDir}}/...`.
  assert.equal(commandLeader('{{roostDir}}/tools/bin/prettier --write {{path}}'), '{{roostDir}}/tools/bin/prettier');
  assert.equal(commandLeader('{{roostDir}}/x/y --flag'), '{{roostDir}}/x/y');
  assert.equal(commandLeader('{{backlogRoot}}/bin/tool'), '{{backlogRoot}}/bin/tool');
  assert.equal(
    commandLeader('CI=true {{roostDir}}/x/y'),
    '{{roostDir}}/x/y',
    'env-var prefixes are still stripped first',
  );
  // The strip stops at the template inside every wrapper shape: a
  // parenthesized `({{roostDir}}/bin/tool` used to come out as the dead
  // `roostDir}}/bin/tool`. The whitespace-separated brace group and spaced
  // subshell used to yield `null` (the bare `{` stripped to nothing), and
  // an ordinary leader goes through every shape too.
  const leaders = ['{{roostDir}}/bin/tool', '{{backlogRoot}}/bin/tool', 'cmd'];
  for (const leader of leaders) {
    const shapes = {
      bare: `${leader} --flag`,
      'env-prefixed': `CI=true ${leader} --flag`,
      parenthesized: `(${leader} --flag)`,
      'doubly parenthesized': `((${leader} --flag))`,
      'brace-prefixed': `{${leader} --flag; }`,
      'brace group': `{ ${leader} --flag; }`,
      'spaced subshell': `( ${leader} --flag )`,
      'env-prefixed brace group': `CI=true { ${leader} --flag; }`,
      // An env assignment inside the group is skipped too: the first fix
      // returned `CI=true` here (and emitted a `CI=true:*` rule).
      'env inside brace group': `{ CI=true ${leader} --flag; }`,
      'env inside spaced subshell': `( CI=true ${leader} --flag )`,
      'env inside attached subshell': `(CI=true ${leader} --flag)`,
    };
    for (const [shape, cmd] of Object.entries(shapes)) {
      assert.equal(commandLeader(cmd), leader, `${leader} ${shape}`);
    }
  }
  assert.equal(commandLeader('{ cmd; }'), 'cmd');
  assert.equal(commandLeader('{ cmd arg; }'), 'cmd');
  assert.equal(commandLeader('( cmd arg )'), 'cmd');
  // Trailing shell punctuation is trimmed from a one-token group.
  assert.equal(commandLeader('{cmd;}'), 'cmd');
  assert.equal(commandLeader('(cmd)'), 'cmd');
  assert.equal(commandLeader('cmd;'), 'cmd');
  // ...but never the closing `}}` of a leader that ends in a template.
  assert.equal(commandLeader('{{bin}} --x'), '{{bin}}');
  assert.equal(commandLeader('( {{bin}} )'), '{{bin}}');
  assert.equal(commandLeader('({{bin}})'), '{{bin}}');
  assert.equal(commandLeader('{{bin}}'), '{{bin}}');
  // Unchanged results.
  assert.equal(commandLeader('cmd'), 'cmd');
  assert.equal(commandLeader('CI=true cmd'), 'cmd');
  assert.equal(commandLeader('(cd x && make)'), 'cd');
  assert.equal(commandLeader('{cmd'), 'cmd');
  assert.equal(commandLeader('((cmd'), 'cmd');
  assert.equal(commandLeader('{{'), null, 'a lone brace is still nothing');
  assert.equal(commandLeader(''), null);
  assert.equal(commandLeader(undefined), null);
  assert.equal(commandLeader('{'), null);
  assert.equal(commandLeader('{ }'), null);
  assert.equal(commandLeader('( )'), null);
  assert.equal(commandLeader('FOO=bar'), null);
  assert.equal(commandLeader('FOO=bar {'), null);
  assert.equal(commandLeader('{ FOO=bar }'), null);
});

test('commandWords pairs the leader with the trimmed word after it', () => {
  // The forge two-word mode rule (`gh pr:*`) is built from this pair, so it
  // inherits every shape the leader parse supports instead of reading the
  // raw first two tokens (which gave `CI=true gh:*` and `(gh pr:*`).
  // `commandLeader` is the pair's leader, so it keeps every result.
  const cases = {
    'gh pr create --title x': ['gh', 'pr'],
    'CI=true gh pr create': ['gh', 'pr'],
    '(gh pr diff 1)': ['gh', 'pr'],
    '(gh pr)': ['gh', 'pr'],
    '{gh pr;}': ['gh', 'pr'],
    '{ gh pr view; }': ['gh', 'pr'],
    '( gh pr )': ['gh', 'pr'],
    '{ CI=true gh pr; }': ['gh', 'pr'],
    'gh pr;': ['gh', 'pr'],
    '{{roostDir}}/bin/gh pr view': ['{{roostDir}}/bin/gh', 'pr'],
    '({{roostDir}}/bin/gh pr view)': ['{{roostDir}}/bin/gh', 'pr'],
    '{ {{roostDir}}/bin/gh pr; }': ['{{roostDir}}/bin/gh', 'pr'],
    // The second word keeps content punctuation, like the leader does.
    'gh ${SUB} view': ['gh', '${SUB}'],
    'gh $(sub) view': ['gh', '$(sub)'],
    '(gh ${A:-${B}})': ['gh', '${A:-${B}}'],
    // No second word.
    gh: ['gh', null],
    '(gh)': ['gh', null],
    '{ gh; }': ['gh', null],
    '( gh )': ['gh', null],
    'CI=true gh': ['gh', null],
    '{{bin}}': ['{{bin}}', null],
    // A leader that closed its group: what follows is a new command.
    'cmd; foo': ['cmd', null],
    '(cmd) foo': ['cmd', null],
    '{cmd;} foo': ['cmd', null],
    // A spaced closer is a whole token that trims to nothing, the same
    // answer by a different path than an attached `(cmd)`.
    '( cmd ) foo': ['cmd', null],
    '{ cmd; } foo': ['cmd', null],
    // A substitution leader is content, not grouping, so its word follows.
    '$(tool) pr view': ['$(tool)', 'pr'],
    // A templated second word holds no permission rule.
    'gh {{sub}} view': ['gh', null],
    'gh {{sub}}': ['gh', null],
    '(gh {{sub}})': ['gh', null],
  };
  for (const [cmd, [leader, next]] of Object.entries(cases)) {
    assert.deepEqual(commandWords(cmd), { leader, next }, cmd);
    assert.equal(commandLeader(cmd), leader, `${cmd}: leader`);
  }
  for (const cmd of ['', '{', '{ }', '( )', '{{', 'FOO=bar', ';', '{ ; }']) {
    assert.equal(commandWords(cmd), null, JSON.stringify(cmd));
  }
  assert.equal(commandWords(undefined), null);
  assert.equal(commandWords(42), null);
});

test('commandLeader preserves parameter expansions and escaped trailing punctuation', () => {
  // The trailing trim is for shell grouping. The closing `}` of a `${var}`
  // parameter expansion, the closing `)` of a `$(cmd)` command substitution
  // and a backslash-escaped `\;`, `\)` or `\}` are token content:
  // `${TOOL} --x` used to come out as `${TOOL`, `$(tool) --x` as `$(tool`
  // and `foo\; --x` as `foo\`. Every such leader goes through every wrapper
  // shape.
  const leaders = [
    '${TOOL}',
    '${TOOL:-fallback}',
    '${A:-${B}}',
    '${TOOL}/bin/x',
    '$(tool)',
    '$(outer-$(inner))',
    'foo\\;',
    'foo\\)',
    'foo\\}',
  ];
  for (const leader of leaders) {
    const shapes = {
      alone: leader,
      bare: `${leader} --x`,
      'trailing semicolon': `${leader};`,
      'env-prefixed': `CI=true ${leader} --x`,
      parenthesized: `(${leader} --x)`,
      'one-token subshell': `(${leader})`,
      'brace-prefixed': `{${leader};}`,
      'brace group': `{ ${leader} --x; }`,
      'spaced subshell': `( ${leader} )`,
      'env inside brace group': `{ CI=true ${leader}; }`,
    };
    for (const [shape, cmd] of Object.entries(shapes)) {
      assert.equal(commandLeader(cmd), leader, `${leader} ${shape}`);
    }
  }
  // Unescaped grouping after an expansion is still trimmed.
  assert.equal(commandLeader('${TOOL});'), '${TOOL}');
  assert.equal(commandLeader('$(tool));'), '$(tool)');
  assert.equal(commandLeader('foo\\;;'), 'foo\\;');
});

test('commandLeader distinguishes shell syntax from token content at arbitrary nesting and escape parity', () => {
  // The trailing trim decides by a balanced scan, not a bounded regex: the
  // one-level `EXPANSION_TRAILER` truncated `${A:-${B:-${C}}}` to
  // `${A:-${B:-${C}}`, and `GROUPING_TRAILER` looked only at the preceding
  // character, so `tool\\;` (an escaped backslash, then an unescaped `;`)
  // kept its `;`. A trailing character is escaped only by an odd run of
  // backslashes.
  const wrap = (leader) => ({
    alone: leader,
    bare: `${leader} --x`,
    'trailing semicolon': `${leader};`,
    'env-prefixed': `CI=true ${leader} --x`,
    parenthesized: `(${leader} --x)`,
    'one-token subshell': `(${leader})`,
    'brace-prefixed': `{${leader};}`,
    'brace group': `{ ${leader} --x; }`,
    'spaced subshell': `( ${leader} )`,
    'env-prefixed brace group': `CI=true { ${leader} --x; }`,
    'env inside brace group': `{ CI=true ${leader}; }`,
    'env inside spaced subshell': `( CI=true ${leader} )`,
  });
  // Content leaders survive every wrapper shape byte-for-byte.
  const content = [
    'cmd',
    '{{bin}}',
    '{{roostDir}}/bin/tool',
    '${TOOL}',
    '${A:-${B:-${C}}}',
    '${A:-${B:-${C:-${D}}}}/bin/x',
    '$(tool)',
    '$(outer-$(middle-$(inner)))',
    '$((1+(2*(3+4))))',
    '${A:-$(b-${c})}',
    // Odd backslash runs (1 and 3) escape each grouping character.
    'foo\\;',
    'foo\\)',
    'foo\\}',
    'foo\\\\\\;',
    'foo\\\\\\)',
    'foo\\\\\\}',
  ];
  for (const leader of content) {
    for (const [shape, cmd] of Object.entries(wrap(leader))) {
      assert.equal(commandLeader(cmd), leader, `${leader} ${shape}`);
    }
  }
  // Even backslash runs (2 and 4) leave the grouping character unescaped,
  // so it is trimmed; the backslashes themselves are content.
  for (const run of ['\\\\', '\\\\\\\\']) {
    for (const punct of [';', ')', '}']) {
      const shapes = Object.entries(wrap(`foo${run}${punct}`));
      for (const [shape, cmd] of shapes) {
        assert.equal(commandLeader(cmd), `foo${run}`, `${punct} ${shape}`);
      }
    }
  }
  // Grouping after a nested expansion is still trimmed, however deep.
  assert.equal(commandLeader('${A:-${B:-${C}}});'), '${A:-${B:-${C}}}');
  assert.equal(commandLeader('$(a-$(b-$(c))))}'), '$(a-$(b-$(c)))');
  assert.equal(commandLeader('{{bin}}})'), '{{bin}}');
  // Malformed and grouping-only inputs.
  assert.equal(commandLeader('${A:-${B}'), '${A:-${B}', 'unclosed stays');
  assert.equal(commandLeader('$(a'), '$(a');
  assert.equal(commandLeader('${'), '${');
  assert.equal(commandLeader(';'), null);
  assert.equal(commandLeader(';;)}'), null);
  assert.equal(commandLeader('{ ; }'), null);
  assert.equal(commandLeader('( )'), null);
  assert.equal(commandLeader('{{'), null);
  assert.equal(commandLeader(''), null);
  assert.equal(commandLeader(undefined), null);
  assert.equal(commandLeader(42), null);
  // Every consumer gets the leader verbatim: enumeratePlugins reports the
  // nested expansion as the binary to probe.
  const cfg = {
    plugins: { nested: { run: '{ ${A:-${B:-${C}}} --x; }' } },
  };
  assert.equal(enumeratePlugins(cfg)[0].firstToken, '${A:-${B:-${C}}}');
});

test('enumeratePlugins reports the real binary of a brace-grouped command', () => {
  // `{ {{roostDir}}/bin/tool --x; }` used to collapse into the SKIP row
  // (`firstToken: null`), so `bl validate` never probed the binary and
  // `warnMissingBinary` could not name it.
  const cfg = {
    roostDir: '/roost',
    plugins: {
      grouped: { run: '{ {{roostDir}}/bin/tool --x; }' },
    },
  };
  const out = enumeratePlugins(cfg);
  assert.equal(out.length, 1);
  assert.equal(out[0].firstToken, '/roost/bin/tool');
  assert.deepEqual(out[0].stages, ['run']);
});

test('enumeratePlugins resolves {{roostDir}} before extracting the leader', () => {
  // Regression: commandLeader's leading-brace strip turned an
  // un-interpolated `{{roostDir}}/.../prettier` into `roostDir}}/.../prettier`,
  // so the binary probe reported a present tool as MISSING.
  const cfg = {
    roostDir: '/roost',
    plugins: {
      prettier: {
        format: '{{roostDir}}/tools/node_modules/.bin/prettier --write {{path}}',
      },
    },
  };
  const out = enumeratePlugins(cfg);
  const prettier = out.find((e) => e.key === 'prettier');
  assert.equal(prettier.firstToken, '/roost/tools/node_modules/.bin/prettier');
  // Runtime vars are left intact for substitution at call time.
  assert.match(prettier.command, /\{\{path\}\}$/);
});

test('enumeratePlugins emits SKIP entry for empty command', () => {
  const cfg = {
    plugins: {
      skipme: { format: '' },
    },
  };
  const out = enumeratePlugins(cfg);
  assert.equal(out.length, 1);
  assert.equal(out[0].firstToken, null);
  assert.deepEqual(out[0].stages, ['format']);
});

test('enumeratePlugins emits one SKIP row for plugin with no string entries', () => {
  const cfg = {
    plugins: {
      metaonly: { extensions: ['.md'] },
    },
  };
  const out = enumeratePlugins(cfg);
  assert.equal(out.length, 1);
  assert.equal(out[0].firstToken, null);
  assert.deepEqual(out[0].stages, []);
});

test('enumeratePlugins splits a single plugin across multiple first-tokens', () => {
  const cfg = {
    plugins: {
      bundle: {
        format: 'prettier --write {{path}}',
        bootstrap: 'pnpm install',
      },
    },
  };
  const out = enumeratePlugins(cfg);
  assert.equal(out.length, 2);
  const tokens = out.map((e) => e.firstToken).sort();
  assert.deepEqual(tokens, ['pnpm', 'prettier']);
});

test('probeBinary returns true when command is on PATH', () => {
  const bin = makeBinDir(['fakeplugin']);
  const prev = process.env.PATH;
  process.env.PATH = bin;
  resetProbeCache();
  try {
    assert.equal(probeBinary('fakeplugin'), true);
    assert.equal(probeBinary('definitelynotthere_xyzzy'), false);
  } finally {
    process.env.PATH = prev;
    rmSync(bin, { recursive: true, force: true });
    resetProbeCache();
  }
});

test('probeBinary caches results across calls', () => {
  const bin = makeBinDir(['cachedplugin']);
  const prev = process.env.PATH;
  process.env.PATH = bin;
  resetProbeCache();
  try {
    assert.equal(probeBinary('cachedplugin'), true);
    // Remove the binary from PATH; cached result should still report present.
    process.env.PATH = '/nonexistent-path-bl-test';
    assert.equal(probeBinary('cachedplugin'), true);
  } finally {
    process.env.PATH = prev;
    rmSync(bin, { recursive: true, force: true });
    resetProbeCache();
  }
});

test('probePluginBinaries marks present/missing/SKIP correctly', () => {
  const bin = makeBinDir(['good']);
  const prev = process.env.PATH;
  process.env.PATH = bin;
  resetProbeCache();
  try {
    const cfg = {
      plugins: {
        good: { format: 'good --write' },
        gone: { lint: 'missingtool_xyzzy {{path}}' },
        empty: { format: '' },
      },
    };
    const out = probePluginBinaries(cfg);
    const byPlugin = Object.fromEntries(out.map((e) => [e.plugin, e]));
    assert.equal(byPlugin.good.present, true);
    assert.equal(byPlugin.gone.present, false);
    assert.equal(byPlugin.empty.present, null);
  } finally {
    process.env.PATH = prev;
    rmSync(bin, { recursive: true, force: true });
    resetProbeCache();
  }
});

test("formatPluginStatus emits a 'Plugin tools:' block with OK/MISSING/SKIP", () => {
  const probed = [
    {
      plugin: 'good',
      stages: ['format'],
      command: 'good --write',
      firstToken: 'good',
      present: true,
    },
    {
      plugin: 'gone',
      stages: ['lint'],
      command: 'gone {{path}}',
      firstToken: 'gone',
      present: false,
    },
    {
      plugin: 'empty',
      stages: ['format'],
      command: '',
      firstToken: null,
      present: null,
    },
  ];
  const block = formatPluginStatus(probed);
  assert.match(block, /^Plugin tools:/);
  assert.match(block, /good\s+OK/);
  assert.match(block, /gone\s+MISSING/);
  assert.match(block, /empty\s+SKIP/);
});

test('formatPluginStatus returns empty string when no plugins', () => {
  assert.equal(formatPluginStatus([]), '');
});
