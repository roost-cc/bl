import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runBl } from '../helpers/run-bl.js';
import { parse as parseYaml } from 'yaml';
import { parseFrontmatter } from '../../src/config.js';
import { componentBacklog, fmOf } from '../helpers/new-fixture.js';
import { statusOf as logStatusOf } from '../../src/transition.js';

// ---------------------------------------------------------------------------
// F-62 D3: every block bl new writes goes through serializeFrontmatter
// ---------------------------------------------------------------------------

const TEMPLATES = join(import.meta.dirname, '..', '..', 'templates');
const TRICKY = 'Parse: the title #1 keeps its colon';

/**
 * The block of `rel` in `dir`, parsed by the `yaml` package itself: its
 * title is TRICKY and its keys are template `name`'s, in the template's order.
 */
function assertTemplateBlock(dir, rel, name) {
  const block = readFileSync(join(dir, rel), 'utf8').match(/^---\n([\s\S]*?)\n---\n/)[1];
  const fm = parseYaml(block, { schema: 'failsafe' });
  const keys = Object.keys(parseFrontmatter(readFileSync(join(TEMPLATES, `${name}.md`), 'utf8')).fm);
  assert.deepEqual(
    Object.keys(fm),
    keys.filter((k) => k in fm),
    `${rel}: keys in ${name}.md's order`,
  );
  assert.equal(fm.title, TRICKY, rel);
  return fm;
}

test("every template's frontmatter holds keys, no {{var}}; bodies keep theirs", () => {
  for (const name of ['story', 'story-feature', 'story-update', 'feature', 'epic', 'theme', 'component', 'change']) {
    const text = readFileSync(join(TEMPLATES, `${name}.md`), 'utf8');
    const block = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
    assert.doesNotMatch(block, /\{\s*\{/, name);
    assert.equal(typeof parseYaml(block, { schema: 'failsafe' }), 'object', name);
  }
  assert.match(readFileSync(join(TEMPLATES, 'story.md'), 'utf8'), /^# \{\{storyId\}\} · \{\{title\}\}$/m);
});

test("bl new with a title holding ': ' and ' #' writes a block yaml reads back (story, story-feature)", () => {
  const { dir, cleanup } = componentBacklog({
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites' }],
  });
  try {
    let r = runBl(['new', 'C01', '--title', TRICKY, '--points', '2', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    let fm = assertTemplateBlock(dir, r.stdout.trim(), 'story');
    assert.equal(fm.feature, undefined, 'no feature: key on a story with none');
    assert.equal(Object.hasOwn(fm, 'depends_on'), false, 'a dependency is an edge, never a key (F-111 D5)');
    assert.match(readFileSync(join(dir, r.stdout.trim()), 'utf8'), /^# S-1 · Parse: the title #1 keeps its colon$/m);

    r = runBl(['new', 'F-1', 'C01', '--title', TRICKY, '--points', '3', '--depends-on', 'S-1', '--no-sync'], {
      cwd: dir,
    });
    assert.equal(r.status, 0, r.stderr);
    fm = assertTemplateBlock(dir, r.stdout.trim(), 'story-feature');
    assert.equal(fm.feature, 'F-1');
    assert.equal(Object.hasOwn(fm, 'depends_on'), false);
  } finally {
    cleanup();
  }
});

test("bl new --from with ': ' and ' #' titles writes story and component blocks yaml reads back", () => {
  const { dir, cleanup } = componentBacklog();
  try {
    mkdirSync(join(dir, 'plan'), { recursive: true });
    writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\n{{title}}.\n');
    writeFileSync(join(dir, 'plan', 'c.md'), '## Boundary\n\n{{title}}.\n');
    const specPath = join(dir, 'plan', 'spec.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        component: { title: TRICKY, repo: 'alpha', paths: ['src/**', '**'], body_file: 'c.md' },
        stories: [
          { id: 'a', title: TRICKY, points: 1, body_file: 'a.md' },
          { id: 'b', title: TRICKY, points: 2, body_file: 'a.md', depends_on: ['@a'] },
        ],
      }),
    );
    const r = runBl(['new', '--from', specPath, '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const component = readdirSync(join(dir, 'components')).find((d) => d.startsWith('C04-'));
    const cfm = assertTemplateBlock(dir, `components/${component}/index.md`, 'component');
    assert.deepEqual(cfm.paths, ['src/**', '**']);
    assert.equal(cfm.home, undefined, "a spec's component is not its repo's home");
    const stories = readdirSync(join(dir, 'stories')).sort();
    const a = assertTemplateBlock(dir, `stories/${stories[0]}/index.md`, 'story');
    const b = assertTemplateBlock(dir, `stories/${stories[1]}/index.md`, 'story');
    assert.equal(a.component, 'C04');
    assert.equal(Object.hasOwn(b, 'depends_on'), false);
    assert.match(
      readFileSync(join(dir, `stories/${stories[0]}/index.md`), 'utf8'),
      /^Parse: the title #1 keeps its colon\.$/m,
    );
  } finally {
    cleanup();
  }
});

test('bl new --from accepts a new component without paths and writes no paths: key; a non-array paths is refused', () => {
  const { dir, cleanup } = componentBacklog();
  try {
    mkdirSync(join(dir, 'plan'), { recursive: true });
    writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\nA.\n');
    writeFileSync(join(dir, 'plan', 'c.md'), '## Boundary\n\nC.\n');
    const specPath = join(dir, 'plan', 'spec.json');
    const spec = (component) => ({ component, stories: [{ id: 'a', title: 'A', points: 1, body_file: 'a.md' }] });
    writeFileSync(specPath, JSON.stringify(spec({ title: 'Bad', repo: 'alpha', paths: 'src/**', body_file: 'c.md' })));
    let r = runBl(['new', '--from', specPath, '--no-sync'], { cwd: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /component\.paths/);
    writeFileSync(specPath, JSON.stringify(spec({ title: 'Unmapped', repo: 'alpha', body_file: 'c.md' })));
    r = runBl(['new', '--from', specPath, '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const component = readdirSync(join(dir, 'components')).find((d) => d.startsWith('C04-'));
    assert.doesNotMatch(readFileSync(join(dir, `components/${component}/index.md`), 'utf8'), /^paths:/m);
  } finally {
    cleanup();
  }
});

test("bl new --feature, --component, --epic and --theme with a ': ' and ' #' title write blocks yaml reads back", () => {
  const { dir, cleanup } = componentBacklog();
  try {
    let r = runBl(['new', '--feature', '--title', TRICKY, '--theme', 'demo', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    let fm = assertTemplateBlock(dir, r.stdout.trim().split('\n').pop(), 'feature');
    assert.deepEqual(
      [fm.theme, fm.epic, logStatusOf('feature', fm), fm.stories, fm.points],
      ['demo', undefined, 'draft', undefined, undefined],
    );

    r = runBl(['new', '--component', '--repo', 'beta', '--title', TRICKY, '--paths', '**', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    fm = assertTemplateBlock(dir, r.stdout.trim(), 'component');
    assert.deepEqual([fm.repo, fm.home, fm.paths], ['beta', undefined, ['**']]);

    r = runBl(['new', '--epic', '--theme', 'demo', '--title', TRICKY, '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    fm = assertTemplateBlock(dir, r.stdout.trim(), 'epic');
    assert.deepEqual([fm.theme, fm.status, fm.features], ['demo', undefined, undefined]);

    r = runBl(['new', '--theme', 'tricky', '--title', TRICKY, '--brief', 'x.md#a: b', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    fm = assertTemplateBlock(dir, r.stdout.trim(), 'theme');
    assert.deepEqual([fm.theme_id, fm.repos, fm.brief], ['tricky', [], ['x.md#a: b']]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// bl new F-<n> writes the story's feature: and never the feature (F-77 D3).
// ---------------------------------------------------------------------------

test('bl new F-<n> leaves the feature file, a CRLF one included, byte for byte', () => {
  const { dir, cleanup } = componentBacklog({
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites', primary_repo: 'beta' }],
  });
  try {
    const featurePath = join(dir, 'features/F1-invites/index.md');
    writeFileSync(featurePath, readFileSync(featurePath, 'utf8').replace(/\r?\n/g, '\r\n'));
    const before = readFileSync(featurePath, 'utf8');
    const r = runBl(['new', 'F-1', 'C01', '--title', 'Mint', '--points', '3', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(featurePath, 'utf8'), before);
    assert.equal(fmOf(dir, r.stdout.trim()).feature, 'F-1');
  } finally {
    cleanup();
  }
});
