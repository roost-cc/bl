/**
 * plan-fixture.js — stories with Implementation Plans, for the tests of
 * `src/execution-plan.js`.
 */

import { loadConfig } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { resolveTargets } from '../../src/targets.js';
import { mkTempBacklog } from './tempdir.js';

/** A story body whose `## Implementation Plan` holds `lines`. */
export const plan = (...lines) => `## Summary\n\nx\n\n## Implementation Plan\n\n${lines.join('\n')}\n`;

/** A refined story of epic E01 (repo `bl`) for `mkTempBacklog`. */
export const story = (id, extra = {}) => ({
  id,
  epic: 'E01',
  epicDirSuffix: 'one',
  title: `story ${id}`,
  dirSuffix: id.toLowerCase(),
  status: 'refined',
  ...extra,
});

function fixture() {
  return mkTempBacklog({
    // A story's repo is its component's (F-52 D1).
    epics: [{ id: 'E01', projectId: 'demo', title: 'One', dirSuffix: 'one', repo: 'bl' }],
    stories: [
      story('S-1', { body: plan('1. `src/a.js`: add it') }),
      story('S-2', { depends_on: ['S-1'], body: plan('1. `src/b.js`') }),
      story('S-3', { depends_on: ['S-9'] }),
      story('S-4', { depends_on: ['S-10'] }),
      story('S-5', { depends_on: ['S-8'] }),
      story('S-8', { status: 'done' }),
      story('S-9', { status: 'backlog' }),
      story('S-10', {
        feature: 'F-1',
        depends_on: ['S-11'],
        body: plan('- `src/x.js` and `test/unit/x.test.js` (~12)'),
      }),
      story('S-11', { feature: 'F-1', body: plan('- `./src/y.js`, `bl run`, `.bl/run/<id>.out`, src/not-seen.js') }),
      story('S-12', { feature: 'F-2', depends_on: ['S-1'] }),
    ],
    features: [
      { id: 'F-1', title: 'One', dirSuffix: 'one', status: 'approved', primary_repo: 'bl', stories: ['S-10', 'S-11'] },
      { id: 'F-2', title: 'Two', dirSuffix: 'two', status: 'approved', primary_repo: 'bl', stories: ['S-12'] },
    ],
  });
}

/** Run `fn` with the fixture backlog's config, its stories and a target resolver. */
export function withBacklog(fn) {
  const { dir, cleanup } = fixture();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const all = readAllStories(config);
    const units = (...ids) => resolveTargets(ids, config, null).targets;
    fn({ config, all, units });
  } finally {
    cleanup();
  }
}

/** Every class of span a plan may backtick: kept (as git prints it) or dropped. */
export const PATH_CASES = [
  ['src/plain.js', 'src/plain.js', 'plain'],
  ['src/with space.js', 'src/with space.js', 'whitespace in a name'],
  ["src/name+variant (copy), #2 & 'q'.js", "src/name+variant (copy), #2 & 'q'.js", 'punctuation'],
  ['src/file..js', 'src/file..js', '`..` inside a name is not traversal'],
  ['src/..hidden/a.js', 'src/..hidden/a.js', '`..` starting a name'],
  ['docs/café/naïve.md', 'docs/café/naïve.md', 'Unicode names'],
  ['README.été', 'README.été', 'Unicode extension, no slash'],
  ['  src/padded.js  ', 'src/padded.js', 'whitespace around the path inside backticks'],
  ['./src/dot.js', 'src/dot.js', 'leading ./'],
  ['src/dir/', 'src/dir', 'directory, trailing slash'],
  ['src/dir', 'src/dir', 'directory, no slash'],
  ['lib/', 'lib', 'top-level directory, trailing slash'],
  ['Makefile.am', 'Makefile.am', 'top-level file with an extension'],
  ['../outside.js', null, 'parent traversal'],
  ['src/../x.js', null, 'parent traversal mid-path'],
  ['src/./x.js', null, '`.` segment'],
  ['src//x.js', null, 'empty segment'],
  ['/etc/passwd', null, 'absolute'],
  ['bl run', null, 'a command'],
  ['Makefile', null, 'no slash and no extension'],
  ['.bl/run/<id>.out', null, 'template'],
  ['src/{a,b}.js', null, 'brace expansion'],
  ['src/*.js', null, 'glob'],
  ['$HOME/x.js', null, 'variable'],
  ['', null, 'empty'],
];
