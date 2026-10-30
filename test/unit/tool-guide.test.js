/**
 * Unit tests for `renderToolGuide` and the per-section helpers (S-442).
 *
 * The renderer is the single editable surface for prompt-shaped tool data;
 * these tests pin the mapping from `backlog.json`'s `plugins`,
 * `language_dispatch`, and `forge` registries onto the rendered fragment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  renderToolGuide,
  renderToolUsageHint,
  renderStageExamples,
  renderPrOps,
  renderToolsOnPath,
  loadHookDenyMessage,
} from '../../src/tool-guide.js';
import { mkTempDir } from '../helpers/tempdir.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'prompts');

// Save & restore the env keys these tests mutate so test order is stable.
function withEnv(overrides, fn) {
  const keys = ['BL_LOCALE', 'LC_ALL', 'LANG', 'BL_SURFACE', 'CLAUDECODE', 'BL_INTERNAL_TEST_PROMPTS_DIR'];
  const saved = {};
  for (const k of keys) {
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

const CLAUDE_HINTS = {
  readTool: 'Read',
  editTool: 'Edit',
  writeTool: 'Write',
  globTool: 'Glob',
  grepTool: 'Grep',
};

const GEMINI_HINTS = {
  readTool: 'read_file',
  editTool: 'replace',
  writeTool: 'write_file',
  globTool: 'glob',
  grepTool: 'grep_search',
};

function fixtureConfig(overrides = {}) {
  return {
    plugins: {
      md: { format: 'prettier --write {{path}}' },
      py: { format: 'ruff format {{path}}', lint: 'ruff check {{path}}' },
      github: {
        'change.open': 'gh pr create --title {{title}} --body {{body}}',
        'change.find': 'gh pr list --head {{branch}} --state all --json number,url,state,headRefOid,labels --limit 1',
        'change.close': 'gh pr close {{number}} --comment {{comment}}',
      },
    },
    languageDispatch: {
      format: { '.md': 'md', '.py': 'py' },
      lint: { '.py': 'py' },
    },
    raw: { forge: 'github' },
    ...overrides,
  };
}

function withPromptFixtures(files, fn, env = {}) {
  const dir = mkTempDir('bl-prompts-');
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body, 'utf8');
    }
    return withEnv({ ...env, BL_INTERNAL_TEST_PROMPTS_DIR: dir }, fn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MINIMAL_TOOL_GUIDE = `## Tools

### Available on PATH

{{toolsOnPath}}

{{ideHints}}
`;

// ---------------------------------------------------------------------------
// renderToolUsageHint
// ---------------------------------------------------------------------------

test('renderToolUsageHint substitutes Claude tool names', () => {
  const out = renderToolUsageHint(CLAUDE_HINTS);
  assert.match(out, /`Read` not `cat`/);
  assert.match(out, /`Edit` not `sed`/);
  assert.doesNotMatch(out, /\{\{readTool\}\}/);
});

test('renderToolUsageHint substitutes Gemini tool names', () => {
  const out = renderToolUsageHint(GEMINI_HINTS);
  assert.match(out, /`read_file` not `cat`/);
  assert.match(out, /`replace` not `sed`/);
  assert.doesNotMatch(out, /\{\{readTool\}\}/);
});

// ---------------------------------------------------------------------------
// renderStageExamples
// ---------------------------------------------------------------------------

test('renderStageExamples renders ext → command bullets sorted by extension', () => {
  const cfg = fixtureConfig();
  const out = renderStageExamples('format', cfg.languageDispatch, cfg.plugins);
  assert.match(out, /`\.md` → `prettier --write \{\{path\}\}`/);
  assert.match(out, /`\.py` → `ruff format \{\{path\}\}`/);
  // Sorted: .md before .py
  assert.ok(out.indexOf('.md') < out.indexOf('.py'));
});

test('renderStageExamples returns _(none configured)_ when stage is missing', () => {
  const out = renderStageExamples('lint', {}, {});
  // Trailing newline keeps adjacent skeleton slots visually separated.
  assert.equal(out, '_(none configured)_\n');
});

test('renderStageExamples skips dispatch entries whose plugin lacks the stage', () => {
  // dispatch references `md` for lint but the plugin has no `lint` cmd
  const out = renderStageExamples('lint', { lint: { '.md': 'md' } }, { md: { format: 'prettier {{path}}' } });
  assert.equal(out, '_(none configured)_\n');
});

test('renderStageExamples ends with a trailing newline so sections separate', () => {
  const out = renderStageExamples(
    'format',
    { format: { '.md': 'md' } },
    { md: { format: 'prettier --write {{path}}' } },
  );
  assert.ok(out.endsWith('\n'), `expected trailing newline, got: ${out}`);
});

test('renderStageExamples honours array dispatch values (multi-plugin per ext)', () => {
  const out = renderStageExamples(
    'format',
    { format: { '.md': ['md', 'extra-md'] } },
    {
      md: { format: 'prettier --write {{path}}' },
      'extra-md': { format: 'markdownlint-cli2 --fix {{path}}' },
    },
  );
  assert.match(out, /prettier --write/);
  assert.match(out, /markdownlint-cli2 --fix/);
});

// ---------------------------------------------------------------------------
// renderPrOps
// ---------------------------------------------------------------------------

test('renderPrOps says bl owns the PR and lists no forge command (F-42 D4)', () => {
  const cfg = fixtureConfig();
  const out = renderPrOps(cfg.raw.forge, cfg.plugins);
  assert.match(out, /`bl` makes every call to the forge \(`github`\)/);
  assert.match(out, /never open,\nedit or close this unit's pull request with the forge CLI/);
  assert.match(out, /`bl run` and `bl review` open it/);
  assert.doesNotMatch(out, /gh pr|change\.open|change\.find/);
});

test('renderPrOps without a forge says the change document records it without a PR', () => {
  assert.match(renderPrOps(null, {}), /^No forge is configured: the change document records/);
});

test('renderPrOps reports unregistered-forge when plugin is missing', () => {
  const out = renderPrOps('ghe', { github: {} });
  assert.match(out, /forge `ghe` is not registered/);
});

// ---------------------------------------------------------------------------
// renderToolsOnPath
// ---------------------------------------------------------------------------

test("renderToolsOnPath unions plugin leaders + baseline, leaving out the forge's", () => {
  const cfg = fixtureConfig();
  const out = renderToolsOnPath(cfg.plugins, cfg.raw.forge);
  // Baseline always present
  assert.match(out, /`bl`/);
  assert.match(out, /`git`/);
  assert.match(out, /`node`/);
  // Plugin leaders present, deduped
  assert.match(out, /`prettier`/);
  assert.match(out, /`ruff`/);
  // The forge plugin's leader is bl's to run, not the agent's.
  assert.doesNotMatch(out, /`gh`/);
  // No literal `ppp`/`pnpm` from the prior hardcoded list
  assert.doesNotMatch(out, /`ppp`/);
});

test('renderToolsOnPath preserves a {{roostDir}} leader', () => {
  // The real top-level prettier plugin: the leading-brace strip used to
  // render it as `roostDir}}/tools/node_modules/.bin/prettier` in every
  // session prompt. `renderToolGuide` then resolves the `{{roostDir}}` slot.
  const out = renderToolsOnPath(
    {
      prettier: {
        format: '{{roostDir}}/tools/node_modules/.bin/prettier --write {{path}}',
      },
    },
    null,
  );
  assert.match(out, /`\{\{roostDir\}\}\/tools\/node_modules\/\.bin\/prettier`/);
  assert.doesNotMatch(out, /[^{]roostDir\}\}/);
});

test('renderToolGuide resolves the {{roostDir}} of an on-PATH leader', () => {
  // End to end: the templated leader survives `renderToolsOnPath` and the
  // `{{roostDir}}` slot then makes it the real path in the prompt.
  const cfg = fixtureConfig({
    plugins: {
      prettier: {
        format: '{{roostDir}}/tools/node_modules/.bin/prettier --write {{path}}',
      },
    },
  });
  const out = withEnv({}, () => renderToolGuide(cfg, CLAUDE_HINTS, { roostDir: '/roost' }));
  assert.match(out, /`\/roost\/tools\/node_modules\/\.bin\/prettier`/);
  assert.doesNotMatch(out, /roostDir\}\}/);
});

test('renderToolsOnPath lists the leader of a brace-grouped command', () => {
  // `{ cmd; }` used to contribute nothing (the bare `{` stripped to an
  // empty leader), so the plugin was missing from "Available on PATH".
  const out = renderToolsOnPath({ grouped: { run: '{ cmd; }' }, spaced: { run: '( other --x )' } }, null);
  assert.match(out, /`cmd`/);
  assert.match(out, /`other`/);
  assert.doesNotMatch(out, /`\{`|`\(`|``|`cmd;`|`other\)`/);
});

test('renderToolsOnPath sorts leaders alphabetically', () => {
  const out = renderToolsOnPath({ z: { run: 'zoxide foo' }, a: { run: 'alpha bar' } }, null);
  assert.ok(out.indexOf('`alpha`') < out.indexOf('`zoxide`'));
});

// ---------------------------------------------------------------------------
// renderToolGuide
// ---------------------------------------------------------------------------

test('renderToolGuide renders the full skeleton with config slots populated', () => {
  const cfg = fixtureConfig();
  const out = renderToolGuide(cfg, CLAUDE_HINTS, {
    storyId: 'S-442',
    storyRepos: 'bl',
    backlogDir: '/home/u/backlog',
  });
  // Sections present
  assert.match(out, /## Tools/);
  assert.match(out, /### Story-explicit invocation/);
  assert.match(out, /### Format and lint/);
  assert.match(out, /### Pull requests/);
  assert.match(out, /### Available on PATH/);
  // Slot interpolation
  assert.match(out, /S-442/);
  assert.match(out, /bl/);
  assert.match(out, /git -C \/home\/u\/backlog/);
  assert.match(out, /Read.*not `cat`/s);
  assert.match(out, /`bl` makes every call to the forge/);
  assert.doesNotMatch(out, /gh pr (create|list|close)/, 'no forge command reaches the agent');
  // No leftover unrendered tool-guide slots. `{{path}}` intentionally
  // remains inside command examples — a plugin-template token the agent
  // fills at invocation time, not a slot the renderer replaces.
  const knownPluginTokens = new Set(['{{path}}']);
  for (const m of out.matchAll(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g)) {
    assert.ok(knownPluginTokens.has(m[0]), `unexpected unrendered slot: ${m[0]}`);
  }
});

test('renderToolGuide maps each hook-denied shape to its replacement', () => {
  const out = renderToolGuide(fixtureConfig(), CLAUDE_HINTS, {
    storyId: 'S-1',
    roostDir: '/r',
  });
  // One row per bash-shape guard rule, naming the same fix as the hook.
  assert.match(out, /\| `cd <path> && <cmd>`\s+\| a path argument: `git -C <path>`/);
  assert.match(out, /\| `VAR=val cmd`\s+\| `env VAR=val cmd`/);
  assert.match(out, /\| loops, .*\$\(…\).*\| a script in your scratch dir/);
  assert.doesNotMatch(out, /Keep commands simple/);
  // bl knows no session stack: no docker row, no session CLI.
  assert.doesNotMatch(out, /docker|containers|session stack/i);
  assert.doesNotMatch(out, /\{\{sessionStackTools\}\}/);
});

test("renderToolGuide adds a session_stack guide's tool rules, and a placeholder when no roostDir is known", () => {
  const dir = mkTempDir('bl-tool-guide-stack-');
  mkdirSync(join(dir, 'stack'));
  writeFileSync(join(dir, 'stack', 'tool-guide.md'), 'Use `{{roostDir}}/stack/session exec` for {{storyId}}.\n');
  const config = { ...fixtureConfig(), backlogRoot: dir, topLevel: { session_stack: { guide: 'stack' } } };
  assert.match(
    renderToolGuide(config, CLAUDE_HINTS, { storyId: 'S-1', roostDir: '/r' }),
    /Use `\/r\/stack\/session exec` for S-1\./,
  );
  assert.match(
    renderToolGuide(config, CLAUDE_HINTS, { storyId: 'S-1' }),
    /Use `<backlog-parent>\/stack\/session exec`/,
  );
});

test('renderToolGuide renders Claude vs Gemini hints differently', () => {
  const cfg = fixtureConfig();
  const claude = renderToolGuide(cfg, CLAUDE_HINTS, { storyId: 'S-1' });
  const gemini = renderToolGuide(cfg, GEMINI_HINTS, { storyId: 'S-1' });
  assert.match(claude, /`Read`/);
  assert.match(gemini, /`read_file`/);
  assert.notEqual(claude, gemini);
});

test('renderToolGuide tolerates missing language_dispatch / forge config', () => {
  // Empty config — every optional section falls back to the placeholder.
  const out = renderToolGuide({}, CLAUDE_HINTS, { storyId: 'S-1' });
  assert.match(out, /_\(none configured\)_/);
  assert.match(out, /No forge is configured/);
  // Skeleton structure still present
  assert.match(out, /## Tools/);
});

test('renderToolGuide responds to a config swap (AC: prettier → custom)', () => {
  const baseline = fixtureConfig();
  const swapped = fixtureConfig({
    plugins: {
      ...baseline.plugins,
      md: { format: 'dprint fmt {{path}}' },
    },
  });
  const before = renderToolGuide(baseline, CLAUDE_HINTS, { storyId: 'S-1' });
  const after = renderToolGuide(swapped, CLAUDE_HINTS, { storyId: 'S-1' });
  assert.match(before, /prettier --write/);
  assert.doesNotMatch(before, /dprint/);
  assert.match(after, /dprint fmt/);
  assert.doesNotMatch(after, /prettier --write/);
});

test('renderToolGuide includes IDE hints for the resolved surface', () => {
  withPromptFixtures(
    {
      '_tool-guide.md': MINIMAL_TOOL_GUIDE,
      '_ide-hints.claude-code.md': '### IDE hints\n\nUse {{readTool}} for {{storyId}}.\n',
    },
    () => {
      const out = renderToolGuide(fixtureConfig({ raw: { surface: 'claude-code' } }), CLAUDE_HINTS, {
        storyId: 'S-456',
      });
      assert.match(out, /### IDE hints/);
      assert.match(out, /Use Read for S-456/);
    },
  );
});

test('renderToolGuide renders empty IDE hints when no surface is resolved', () => {
  withPromptFixtures(
    {
      '_tool-guide.md': MINIMAL_TOOL_GUIDE,
      '_ide-hints.claude-code.md': '### IDE hints\n\nHidden.\n',
    },
    () => {
      const out = renderToolGuide({}, CLAUDE_HINTS, {
        storyId: 'S-456',
      });
      assert.doesNotMatch(out, /### IDE hints/);
      assert.doesNotMatch(out, /\{\{ideHints\}\}/);
      assert.equal(out, '## Tools\n\n### Available on PATH\n\n`bl`, `git`, `node`\n');
    },
  );
});

test('renderToolGuide renders empty IDE hints when the surface fragment is missing', () => {
  withPromptFixtures({ '_tool-guide.md': MINIMAL_TOOL_GUIDE }, () => {
    const out = renderToolGuide({ raw: { surface: 'gemini-cli' } }, CLAUDE_HINTS, { storyId: 'S-456' });
    assert.doesNotMatch(out, /\{\{ideHints\}\}/);
    assert.equal(out, '## Tools\n\n### Available on PATH\n\n`bl`, `git`, `node`\n');
  });
});

test('renderToolGuide renders empty IDE hints when the surface fragment is empty', () => {
  withPromptFixtures(
    {
      '_tool-guide.md': MINIMAL_TOOL_GUIDE,
      '_ide-hints.claude-code.md': ' \n\n ',
    },
    () => {
      const out = renderToolGuide({ raw: { surface: 'claude-code' } }, CLAUDE_HINTS, { storyId: 'S-456' });
      assert.doesNotMatch(out, /\{\{ideHints\}\}/);
      assert.equal(out, '## Tools\n\n### Available on PATH\n\n`bl`, `git`, `node`\n');
    },
  );
});

test('renderToolGuide prefers localized IDE hints for surface + locale', () => {
  withPromptFixtures(
    {
      '_tool-guide.md': MINIMAL_TOOL_GUIDE,
      '_ide-hints.claude-code.md': '### IDE hints\n\nEnglish.\n',
      '_ide-hints.claude-code.fr.md': '### Astuces IDE\n\nFrancais.\n',
    },
    () => {
      const out = renderToolGuide(fixtureConfig({ raw: { surface: 'claude-code' } }), CLAUDE_HINTS, {
        storyId: 'S-456',
      });
      assert.match(out, /### Astuces IDE/);
      assert.match(out, /Francais/);
      assert.doesNotMatch(out, /English/);
    },
    { BL_LOCALE: 'fr' },
  );
});

test('renderToolGuide honours BL_SURFACE overriding CLAUDECODE autodetect', () => {
  withPromptFixtures(
    {
      '_tool-guide.md': MINIMAL_TOOL_GUIDE,
      '_ide-hints.claude-code.md': '### Claude Code hints\n',
      '_ide-hints.gemini-cli.md': '### Gemini CLI hints\n',
    },
    () => {
      const out = renderToolGuide(fixtureConfig(), CLAUDE_HINTS, {
        storyId: 'S-456',
      });
      assert.match(out, /### Gemini CLI hints/);
      assert.doesNotMatch(out, /### Claude Code hints/);
    },
    { BL_SURFACE: 'gemini-cli', CLAUDECODE: '1' },
  );
});

// ---------------------------------------------------------------------------
// loadHookDenyMessage
// ---------------------------------------------------------------------------

test('loadHookDenyMessage round-trips through JSON encoding without breaking', () => {
  const text = loadHookDenyMessage('_cd-git-guard-deny');
  assert.match(text, /git -C <path>/);
  assert.match(text, /cd <path>/);
  // Round-trip through JSON.stringify → JSON.parse — proves the fragment is
  // safely embeddable in the shell wrapper that printf-emits a JSON object.
  const wrapped = JSON.stringify({ permissionDecisionReason: text });
  const parsed = JSON.parse(wrapped);
  assert.equal(parsed.permissionDecisionReason, text);
});

test('loadHookDenyMessage throws when the fragment is missing', () => {
  assert.throws(() => loadHookDenyMessage('_does-not-exist-442'), /not found or empty/);
});

// ---------------------------------------------------------------------------
// Localized fragment lookup (S-457)
//
// Exercised through `loadHookDenyMessage` because `readFragment` is a
// private helper. The behaviour under test — the prefer-localized,
// fall-back-to-bare-language, fall-back-to-un-suffixed chain — is shared
// by every fragment reader.
// ---------------------------------------------------------------------------

test('readFragment: no locale → un-suffixed file is loaded', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR }, () => {
    const out = loadHookDenyMessage('frag-a');
    assert.equal(out, 'A english only');
  });
});

test('readFragment: locale set, localized file present → localized loaded', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR, BL_LOCALE: 'fr' }, () => {
    const out = loadHookDenyMessage('frag-b');
    assert.equal(out, 'B francais');
  });
});

test('readFragment: locale set, no localized file → fallback to un-suffixed', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR, BL_LOCALE: 'de' }, () => {
    const out = loadHookDenyMessage('frag-b');
    assert.equal(out, 'B english');
  });
});

test('readFragment: fr-FR prefers regional, falls back to bare, then un-suffixed', () => {
  // Region variant exists → that wins.
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR, BL_LOCALE: 'fr-FR' }, () => {
    assert.equal(loadHookDenyMessage('frag-c'), 'C francais regional');
  });
  // Only bare-language exists → falls back to fr.md.
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR, BL_LOCALE: 'fr-FR' }, () => {
    assert.equal(loadHookDenyMessage('frag-d'), 'D francais only');
  });
  // No localized variant of any kind → throws (empty fragment).
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR, BL_LOCALE: 'fr-FR' }, () => {
    assert.equal(loadHookDenyMessage('frag-a'), 'A english only');
  });
});

test('readFragment honours LANG=fr_FR.UTF-8 via loadHookDenyMessage', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR, LANG: 'fr_FR.UTF-8' }, () => {
    // frag-c has both fr-FR and fr; LANG=fr_FR.UTF-8 → fr-FR → fr-FR variant.
    assert.equal(loadHookDenyMessage('frag-c'), 'C francais regional');
  });
});

// ---------------------------------------------------------------------------
// Per-agent fragment lookup (S-455)
//
// Exercised through `loadHookDenyMessage` because `readFragment` is a
// private helper. These tests pin the agent-dominant cross-product shared
// by every fragment reader.
// ---------------------------------------------------------------------------

test('readFragment: agent variant wins over shared', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR }, () => {
    const out = loadHookDenyMessage('frag-agent-only', 'claude');
    assert.equal(out, 'agent=claude only');
  });
});

test('readFragment: absent agent variant falls back through locale chain', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR, BL_LOCALE: 'fr' }, () => {
    const out = loadHookDenyMessage('frag-b', 'claude');
    assert.equal(out, 'B francais');
  });
});

test('readFragment: agent + locale variant wins when present', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR, BL_LOCALE: 'fr-FR' }, () => {
    const out = loadHookDenyMessage('frag-agent-locale', 'claude');
    assert.equal(out, 'agent=claude fr');
  });
});

test('readFragment: agent-bare variant beats shared-locale variant', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR, BL_LOCALE: 'fr' }, () => {
    const out = loadHookDenyMessage('frag-agent-bare-vs-shared-locale', 'claude');
    assert.equal(out, 'agent=claude bare beats locale');
  });
});

test('readFragment: garbage agent ID silently degrades to shared file', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR }, () => {
    const out = loadHookDenyMessage('frag-agent-only', 'DROP TABLE');
    assert.equal(out, 'agent=shared only');
  });
});

test('readFragment: unregistered agent ID silently degrades to locale chain', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR, BL_LOCALE: 'fr' }, () => {
    const out = loadHookDenyMessage('frag-agent-locale', 'not-registered');
    assert.equal(out, 'agent=shared fr');
  });
});

test('readFragment: agent unset preserves existing shared behaviour', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR }, () => {
    const out = loadHookDenyMessage('frag-agent-only');
    assert.equal(out, 'agent=shared only');
  });
});
