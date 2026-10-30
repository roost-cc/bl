// The adapter boundary (F-64 D1): src/agents/provider.js is the interface and
// claude.js, codex.js and gemini.js are adapters. Outside src/agents/, no
// module imports an adapter or compares a value to an agent name; it asks the
// adapter (getProvider(name).supportsDeny(), …) instead, so adding an agent, a
// model or a refusal sentence is a change in one adapter. Passing a name as a
// literal (a default argument, a locale variant) is not a comparison and is
// allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const AGENTS = join(SRC, 'agents');

const NAMES = 'claude|codex|gemini';
const IMPORT_RE = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'][^"']*\bagents/(?:${NAMES})(?:\.js)?["']`,
);
const COMPARE_RES = [
  new RegExp(String.raw`[!=]==?\s*["'\x60](?:${NAMES})["'\x60]`, 'i'),
  new RegExp(String.raw`["'\x60](?:${NAMES})["'\x60]\s*[!=]==?`, 'i'),
  new RegExp(String.raw`\bcase\s+["'\x60](?:${NAMES})["'\x60]\s*:`, 'i'),
];

// Each exception names its file, the exact line (trimmed) and why it is not
// an agent comparison.
const EXCEPTIONS = [
  {
    file: 'bl.js',
    line: 'case "claude":',
    why: 'a verb alias for `bl agent` in the command dispatch, not an agent comparison',
  },
];

/** Two trimmed source lines, alike but for the quote style a formatter chose. */
const sameLine = (a, b) => a.replaceAll("'", '"') === b.replaceAll("'", '"');

/**
 * The boundary violations in one module's source: `[{ line, text, what }]`.
 * @param {string} file - path relative to src/
 * @param {string} source
 */
export function boundaryViolations(file, source) {
  const out = [];
  source.split('\n').forEach((text, i) => {
    const trimmed = text.trim();
    if (EXCEPTIONS.some((e) => e.file === file && sameLine(e.line, trimmed))) return;
    if (IMPORT_RE.test(text)) out.push({ line: i + 1, text: trimmed, what: 'imports an adapter' });
    else if (COMPARE_RES.some((re) => re.test(text)))
      out.push({ line: i + 1, text: trimmed, what: 'compares a value to an agent name' });
  });
  return out;
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return p === AGENTS ? [] : sourceFiles(p);
    return e.isFile() && /\.m?js$/.test(e.name) ? [p] : [];
  });
}

test('no module under src/ outside src/agents/ imports an adapter or compares a value to an agent name', () => {
  const found = sourceFiles(SRC).flatMap((p) => {
    const file = relative(SRC, p);
    return boundaryViolations(file, readFileSync(p, 'utf8')).map((v) => `src/${file}:${v.line} ${v.what}: ${v.text}`);
  });
  assert.deepEqual(found, [], `Ask the adapter (src/agents/provider.js) instead:\n${found.join('\n')}`);
});

test('every exception still matches a line, so a stale one is noticed', () => {
  for (const e of EXCEPTIONS) {
    const lines = readFileSync(join(SRC, e.file), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    assert.ok(
      lines.some((l) => sameLine(l, e.line)),
      `src/${e.file} no longer has \`${e.line}\` (${e.why}); drop the exception`,
    );
  }
});

test('the boundary check catches imports and comparisons, and lets literals pass', () => {
  const bad = [
    `import { ensureCodexApprovedCommandPrefixes } from "./agents/codex.js";`,
    `import { ClaudeProvider } from '../agents/claude.js';`,
    `const m = await import("./agents/gemini.js");`,
    `export { parseLimit } from "./agents/claude";`,
    `if (config.agent?.toLowerCase() === "codex") {`,
    `if (agent !== 'claude') return;`,
    `const claude = agent == "claude";`,
    `if ("gemini" === name) {`,
    '  case `codex`:',
    `    case "Claude":`,
  ];
  for (const line of bad) assert.equal(boundaryViolations('x.js', line).length, 1, line);

  const ok = [
    `import { getProvider } from "./agents/index.js";`,
    `export function loadPrompt(name, vars, agentOrOpts = "claude") {`,
    `loadHookDenyMessage(FRAGMENTS[r], "claude")`,
    `  -A, --agent <id>     Agent provider (e.g. "claude", "codex", "gemini")`,
    `if (!getProvider(reviewAgent).supportsDeny()) {`,
    `const agent = agentFlag ?? raw.agent ?? "claude";`,
  ];
  for (const line of ok) assert.deepEqual(boundaryViolations('x.js', line), [], line);

  // The named exception holds in its own file only.
  assert.deepEqual(boundaryViolations('bl.js', `    case "claude":`), []);
  assert.equal(boundaryViolations('feature-cmd.js', `    case "claude":`).length, 1);
});
