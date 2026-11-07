import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadPrompt } from '../../src/session.js';
import { main as agentsMain } from '../../src/agents.js';
import { mkTempDir } from '../helpers/tempdir.js';

// Every session writes something the operator or another agent reads, so every
// top-level prompt carries the plain-writing rule (about 80% of ASD-STE100)
// exactly once, and `bl agents` prints it for sessions bl does not build.
const MARKER = '## Plain writing';
const VARS = {
  storyId: 'S-7',
  featureId: 'F-3',
  backlogDir: '/bl',
  roostDir: '/roost',
  storyAbsPath: '/bl/s.md',
  storyCount: '2',
  storyTasks: '-',
  unitKind: 'story',
};
const PROMPTS_DIR = new URL('../../prompts/', import.meta.url);
const TOP_LEVEL = readdirSync(PROMPTS_DIR)
  .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
  .map((f) => f.slice(0, -'.md'.length));
const PARTIAL = readFileSync(new URL('_plain-writing.md', PROMPTS_DIR), 'utf8');
// The rule as every prompt renders it when no dictionaries are listed (F-82 D8).
const GUIDE = PARTIAL.replace('{{dictionaryGuide}}', '');
const DICTIONARY_MARKER = "Take the names from the project's dictionaries";
const LISTED = { backlogRoot: '/bl', topLevel: { dictionaries: ['coding-dictionary.yaml', 'docs/domain.yaml'] } };

const count = (text, s) => text.split(s).length - 1;

test('the prompt set is found', () => {
  assert.ok(TOP_LEVEL.length >= 19, TOP_LEVEL.join(' '));
});

for (const name of TOP_LEVEL) {
  test(`${name} renders the plain-writing rule exactly once`, () => {
    const text = loadPrompt(name, VARS);
    assert.equal(count(text, MARKER), 1, name);
    assert.doesNotMatch(text, /\{\{writingGuide\}\}/);
    assert.ok(text.includes(GUIDE.trim()), name);
  });

  test(`${name} names each listed dictionary once, and none when none are listed`, () => {
    const listed = loadPrompt(name, VARS, { agent: 'claude', config: LISTED });
    assert.equal(count(listed, DICTIONARY_MARKER), 1, name);
    assert.equal(count(listed, '`/bl/coding-dictionary.yaml`'), 1, name);
    assert.equal(count(listed, '`/bl/docs/domain.yaml`'), 1, name);
    for (const config of [null, { backlogRoot: '/bl', topLevel: {} }]) {
      const text = loadPrompt(name, VARS, { agent: 'claude', config });
      assert.equal(count(text, DICTIONARY_MARKER), 0, name);
      assert.doesNotMatch(text, /\{\{dictionaryGuide\}\}/);
    }
  });
}

test('the dictionary paragraph says to use the terms and to keep the entries current', () => {
  const prose = loadPrompt('agent', VARS, { agent: 'claude', config: LISTED }).replace(/\s+/g, ' ');
  assert.match(prose, /Use each entry's `term` for its `meaning`, and never its `avoid` words/);
  assert.match(
    prose,
    /When a refine introduces a concept, or an operator decision renames a term, add or update the entry/,
  );
});

test('no prompt says "the user"', () => {
  for (const f of readdirSync(PROMPTS_DIR)) {
    assert.doesNotMatch(readFileSync(new URL(f, PROMPTS_DIR), 'utf8'), /\bthe user\b/i, f);
  }
});

test('the rule makes its points and assumes no project', () => {
  const prose = PARTIAL.replace(/\s+/g, ' ');
  assert.match(prose, /about 80% of ASD-STE100/);
  assert.match(prose, /Put the answer, the result or the decision first/);
  assert.match(prose, /one idea per sentence, in about 25 words or fewer/);
  assert.match(prose, /active voice and name who acts/);
  assert.match(prose, /condition before the command/);
  assert.match(prose, /Give each thing one name/);
  assert.match(prose, /Keep every fact, number, condition and hedge exact/);
  assert.match(prose, /read your three longest sentences/);
  assert.doesNotMatch(prose, /roost/i);
});

/** `bl agents`'s stdout, run in `cwd` with no `BL_BACKLOG_DIR`. */
async function agentsOutput(cwd) {
  const chunks = [];
  const here = process.cwd();
  const envDir = process.env.BL_BACKLOG_DIR;
  const write = process.stdout.write;
  const isTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  process.stdout.write = (chunk) => chunks.push(String(chunk)) > 0;
  delete process.env.BL_BACKLOG_DIR;
  process.chdir(cwd);
  try {
    await agentsMain([]);
  } finally {
    process.chdir(here);
    if (envDir !== undefined) process.env.BL_BACKLOG_DIR = envDir;
    process.stdout.write = write;
    process.stdout.isTTY = isTTY;
    process.exitCode = 0;
  }
  return chunks.join('');
}

test('bl agents outside a backlog prints the reference and then the plain-writing rule', async () => {
  const dir = mkTempDir('bl-agents-');
  try {
    const out = await agentsOutput(dir);
    assert.ok(out.includes('Stream policy'), 'the AGENTS.md reference');
    assert.ok(out.trimEnd().endsWith(GUIDE.trimEnd()), 'the rule closes the output');
    assert.equal(count(out, MARKER), 1);
    assert.doesNotMatch(out.slice(out.indexOf(MARKER)), /## Dictionary:|Take the names from/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bl agents in a backlog prints the reference, the rule and then each listed dictionary', async () => {
  const dir = mkTempDir('bl-agents-');
  try {
    const root = join(dir, 'backlog');
    mkdirSync(root);
    const backlog = {
      repos: {},
      worktrees: join(dir, 'wt'),
      agent: [{ agent: 'claude' }],
      review_agent: [{ agent: 'claude' }],
      dictionaries: ['coding-dictionary.yaml'],
    };
    writeFileSync(join(root, 'backlog.json'), JSON.stringify(backlog));
    writeFileSync(join(root, 'coding-dictionary.yaml'), 'entries:\n  - term: work unit\n');
    const out = await agentsOutput(root);
    const dict = join(root, 'coding-dictionary.yaml');
    const reference = out.indexOf('Stream policy');
    const rule = out.indexOf(MARKER);
    const heading = out.indexOf(`## Dictionary: ${dict}`);
    assert.ok(reference >= 0 && reference < rule && rule < heading, 'reference, rule, dictionary in order');
    assert.equal(count(out, '`' + dict + '`'), 1, 'the rule names the path');
    assert.ok(out.trimEnd().endsWith('entries:\n  - term: work unit'), 'the dictionary closes the output');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bl agents skips a listed dictionary that is missing, with a warning, and prints the rest', async () => {
  const dir = mkTempDir('bl-agents-');
  const stderr = process.stderr.write;
  const errors = [];
  try {
    const root = join(dir, 'backlog');
    mkdirSync(root);
    const backlog = {
      repos: {},
      worktrees: join(dir, 'wt'),
      agent: [{ agent: 'claude' }],
      review_agent: [{ agent: 'claude' }],
      dictionaries: ['missing.yaml', 'coding-dictionary.yaml'],
    };
    writeFileSync(join(root, 'backlog.json'), JSON.stringify(backlog));
    writeFileSync(join(root, 'coding-dictionary.yaml'), 'entries:\n  - term: work unit\n');
    process.stderr.write = (chunk) => errors.push(String(chunk)) > 0;
    const out = await agentsOutput(root);
    process.stderr.write = stderr;
    assert.ok(out.includes('Stream policy'), 'the AGENTS.md reference');
    assert.doesNotMatch(out, /## Dictionary: .*missing\.yaml/);
    assert.ok(out.includes(`## Dictionary: ${join(root, 'coding-dictionary.yaml')}`));
    assert.match(errors.join(''), /warning: .*missing\.yaml.*ENOENT/);
  } finally {
    process.stderr.write = stderr;
    rmSync(dir, { recursive: true, force: true });
  }
});
