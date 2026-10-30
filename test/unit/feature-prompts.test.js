import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadConfig } from '../../src/config.js';
import { loadPrompt } from '../../src/session.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { writeStackGuide } from '../helpers/session-stack.js';

// The variables the loop actually passes: prepareFeatureWorktree's baseVars,
// reviewVars, and the per-step extras in feature-run.js. A placeholder in a
// prompt that none of these supply renders literally, and the agent sees
// `{{something}}` instead of an instruction.
const BASE = {
  featureId: 'F-9',
  storyId: 'F-9',
  title: 'T',
  featureRelPath: 'features/F9-t/index.md',
  featureAbsPath: '/b/features/F9-t/index.md',
  projectId: 'demo',
  primaryRepo: 'r',
  targetRepo: 'r',
  leadRepo: 'r',
  changeAbsPath: '/b/features/F9-t/change.md',
  changeRelPath: 'features/F9-t/change.md',
  worktreePath: '/wt',
  unitDir: '/u',
  branchName: 'f9-t',
  roostDir: '/roost',
  backlogDir: '/b',
  storyRepos: 'r',
  storiesPlan: '1. S-1',
  storyCount: '1',
  prTitle: 'F-9: T',
  otherWorktrees: '(none)',
  sessionId: 's597',
  sessionNum: '597',
  scratchDir: '/b/.bl/run/F-9.x.scratch',
  adhocProject: 'demo',
  adhocComponent: 'C03',
  unitKind: 'feature',
  deferredHeading: 'Deferred',
  premise: "the feature's Premise",
  themeBrief: '- `/roost/app.acme.com/docs/public/tenets.md`',
};
const REVIEW = {
  mainRef: 'main',
  prNumber: '7',
  prUrl: 'u',
  reviewStatus: '(none)',
  reviewRound: '0',
  nextRound: '1',
  reviewRoundsMax: '2',
  reReview: 'false',
  closingRound: 'false',
  changedFiles: '(none)',
  reviewScope: 'all',
};
const CASES = {
  'review-correctness': { ...BASE, ...REVIEW, findingsPath: '/f', dimension: 'correctness', scratchDir: '/s' },
  'review-failure-paths': { ...BASE, ...REVIEW, findingsPath: '/f', dimension: 'failure-paths', scratchDir: '/s' },
  'review-verify': {
    ...BASE,
    ...REVIEW,
    findingsPaths: '- /f',
    scratchDir: '/s',
    reviewers: 'codex gpt-6-sol, claude sonnet',
  },
  'feature-workon-review': { ...BASE },
  'feature-fix-self-review': { ...BASE, fixBaseSha: 'abc1234', fixDiff: 'git diff abc1234..HEAD' },
  'feature-self-review': { ...BASE, mainRef: 'main' },
  'feature-story': {
    ...BASE,
    storyId: 'S-1',
    storyTitle: 'One',
    storyAbsPath: '/b/s1.md',
    storyRelPath: 's1.md',
    storyPoints: '3',
    nudge: '',
  },
  'feature-workon': { ...BASE },
  'feature-fix-tests': {
    ...BASE,
    fixNote: '',
    testRepo: 'docs.acme.com',
    testWorktree: '/wt-docs',
    testCommand: 'npm test',
    testLogPath: '/b/.bl/run/F-9.test-1.log',
    testExcerpt: 'Error: x',
    testTail: '(tail)',
  },
};

// F-60 D3: every session of a unit starts in its unit directory. The tool
// guide says so and names `<unitDir>/<repo>` as each worktree, and no prompt
// calls the lead worktree "this worktree", as if it were the cwd.
test('every unit prompt names the unit directory as the working directory, and no worktree as the cwd', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    for (const [name, vars] of Object.entries(CASES)) {
      for (const agent of ['claude', 'codex']) {
        const text = loadPrompt(name, vars, { agent, config });
        assert.match(text, /^Unit dir {5}: \/u \(your working directory\)$/m, `${name} (${agent})`);
        assert.match(
          text,
          /Your working directory is the unit directory, `\/u`\. Each repo's worktree\n {2}is `\/u\/<repo>`, and you may write in every one of them\./,
          `${name} (${agent})`,
        );
        assert.doesNotMatch(text, /This worktree|code worktree root|started you in the first/, `${name} (${agent})`);
      }
    }
    const workon = loadPrompt('feature-workon', { ...CASES['feature-workon'], otherWorktrees: '/u/b (b)' }, { config });
    assert.match(workon, /^Lead worktree: \/wt \(r\)\nOther repos  : \/u\/b \(b\)$/m);
    assert.match(workon, /\*\*Code changes\*\* go in each repo's worktree, `\/u\/<repo>`/);
  } finally {
    cleanup();
  }
});

test('a session with no unit directory keeps the worktree-root working directory line', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const { unitDir, ...vars } = CASES['feature-workon'];
    const text = loadPrompt('feature-workon', vars, { config });
    assert.match(text, /Your working directory is the code worktree root\./);
    assert.doesNotMatch(text, /Your working directory is the unit directory/);
  } finally {
    cleanup();
  }
});

test('feature-fix-tests names the failing repo and its worktree, and has the fix committed there', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    for (const agent of ['claude', 'codex']) {
      const text = loadPrompt('feature-fix-tests', CASES['feature-fix-tests'], { agent, config });
      assert.match(text, /^Lead worktree: \/wt \(r\)\nFailing repo : docs\.acme\.com, worktree \/wt-docs$/m, agent);
      assert.match(
        text,
        /failed in \*\*docs\.acme\.com\*\*\. Fix it and commit the fix in `\/wt-docs`, on `f9-t`\./,
        agent,
      );
      assert.match(text, /`git -C \/wt-docs …`/, agent);
    }
  } finally {
    cleanup();
  }
});

test("feature-story derives the feature's repos from its stories' components and escalates a missing repo as a missing story", () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const text = loadPrompt(
      'feature-story',
      { ...CASES['feature-story'], storyRepos: 'bl, docs.acme.com' },
      { agent: 'claude', config },
    );
    assert.match(text, /Repos {8}: bl, docs\.acme\.com\n/);
    assert.match(
      text,
      /The feature's repos are derived from its stories \(bl, docs\.acme\.com, in the order bl prepares,\s+reviews and merges them: `bl` first, then by first story\)/,
    );
    assert.match(text, /a story's one repo is its\s+component's/);
    // F-48 D1: a drive-by change is a bl side story; missing scope escalates.
    assert.match(text, /A drive-by change the work needs or found[^]*make it with `bl side`/);
    assert.match(text, /Work the feature's design is missing[^]*escalate/);
    assert.doesNotMatch(text, /primary_repo|secondary_repos|Primary repo|Secondaries/);
    const refine = loadPrompt(
      'feature-refine',
      { ...BASE, status: 'draft', storiesList: '(none)', pointsMin: '1', pointsMax: '8' },
      { agent: 'claude', config },
    );
    assert.match(refine, /a\s+story's repo is its component's, and that is what puts the repo in the\s+feature/);
    assert.match(refine, /bl orders them `bl` first, then by first story in\s+dependency order/);
    assert.match(refine, /Neither a story nor a feature names a repo/);
    assert.doesNotMatch(refine, /Primary repo/);
    for (const name of ['feature-workon', 'feature-workon-review']) {
      const p = loadPrompt(name, { ...CASES[name], storyRepos: 'bl, containers' }, { agent: 'claude', config });
      assert.match(p, /Repos {8}: bl, containers\n/, name);
      assert.doesNotMatch(p, /Primary repo/, name);
      assert.match(p, /a\s+missing story/, name);
    }
  } finally {
    cleanup();
  }
});

// `bl run S-n`: prepareStoryRun's baseVars. The story is the unit, so the
// unit's id and file are the story's own.
const STORY_BASE = {
  ...BASE,
  featureId: 'S-9',
  storyId: 'S-9',
  title: 'Nine',
  featureRelPath: 'projects/demo/E3-x/S9-nine/index.md',
  featureAbsPath: '/b/projects/demo/E3-x/S9-nine/index.md',
  branchName: 's9-nine',
  storiesPlan: '1. S-9',
  changeAbsPath: '/b/projects/demo/E3-x/S9-nine/change.md',
  changeRelPath: 'projects/demo/E3-x/S9-nine/change.md',
  prTitle: 'S-9: Nine',
  sessionId: 's9',
  sessionNum: '9',
  scratchDir: '/b/.bl/run/S-9.x.scratch',
  unitKind: 'story',
  deferredHeading: 'To Do',
  premise: "the story's Summary and Acceptance Criteria",
};
const STORY_CASES = {
  ...Object.fromEntries(
    Object.entries(CASES)
      .filter(([n]) => n !== 'feature-story' && n !== 'feature-workon')
      .map(([n, v]) => [n, { ...v, ...STORY_BASE }]),
  ),
  'story-run': {
    ...STORY_BASE,
    storyTitle: 'Nine',
    storyAbsPath: '/b/projects/demo/E3-x/S9-nine/index.md',
    storyRelPath: 'projects/demo/E3-x/S9-nine/index.md',
    storyPoints: '3',
    nudge: '',
  },
};
CASES['story-run'] = STORY_CASES['story-run'];

test("a story run's prompts name the story file and its To Do, never the feature's", () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    for (const [name, vars] of Object.entries(STORY_CASES)) {
      for (const agent of ['claude', 'codex']) {
        const text = loadPrompt(name, vars, { agent, config });
        const where = `${name} (${agent})`;
        const left = [...new Set(text.match(/\{\{[A-Za-z]+\}\}/g) ?? [])];
        assert.deepEqual(left, [], `${where} left ${left.join(', ')}`);
        assert.doesNotMatch(text, /feature file|## Deferred|feature.s Premise/, where);
        assert.doesNotMatch(text, /--feature S-9/, `${where}: no ad-hoc story attached to a story`);
      }
    }
    const verify = loadPrompt('review-verify', STORY_CASES['review-verify'], { agent: 'claude', config });
    assert.match(verify, /goes to \*\*## To Do\*\* in the story file/);
    assert.match(verify, /\*\*Check the story's Summary and Acceptance Criteria\*\*/);
    assert.match(
      verify,
      /Prepend a session block to `## Review Log` in the change document\n\s+\(`\/b\/projects\/demo\/E3-x\/S9-nine\/change\.md`\)/,
    );
    assert.match(verify, /Update the change document's frontmatter \(not the story file's\)/);
    const self = loadPrompt('feature-self-review', STORY_CASES['feature-self-review'], { agent: 'claude', config });
    assert.match(self, /rest on the story's Summary and Acceptance Criteria\?/);
    assert.match(self, /`bl run` does that next/);
  } finally {
    cleanup();
  }
});

test("story-run: the story file only, no PR, follow-ups to To Do, and the story's ad-hoc fix rule", () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    for (const agent of ['claude', 'codex']) {
      const text = loadPrompt('story-run', STORY_CASES['story-run'], { agent, config });
      assert.match(text, /Story file   : \/b\/projects\/demo\/E3-x\/S9-nine\/index\.md/);
      assert.doesNotMatch(text, /Feature file|storiesPlan|featureAbsPath/);
      assert.match(text, /Do not open a pull\s+request: `bl run` opens it/);
      assert.match(text, /Follow-up code work of 8 points or more: a bullet under \*\*## To Do\*\*/);
      assert.match(text, /a dated bullet under \*\*## Notes\*\*,\s+`- <YYYY-MM-DD> \(S-9\): …`/);
      assert.match(text, /bl sync --commit -m "chore: S-9 implemented" --story S-9\n/);
      assert.match(text, /bl sync --commit -m "chore: S-9 ad-hoc fix noted" --story S-9\n/);
      assert.equal(text.split('## Blocked by a bug').length, 2, 'the rule appears once');
      assert.match(
        text,
        /add a dated bullet to the story's \*\*## Notes\*\*[^]*`- <YYYY-MM-DD> \(S-9\): Ad-hoc fix \(done, <short sha>\):`/,
      );
      assert.doesNotMatch(text, /bl new -p/, 'no ad-hoc story: a story has no feature to hold it');
      assert.equal(text.split('## Writing an escalation').length, 2);
      assert.match(text, /usually the story file's \*\*## Escalation\*\*/);
      assert.match(text, /^- Do NOT push\. `bl run` pushes/m);
    }
  } finally {
    cleanup();
  }
});

// F-65 D4: a session's leftovers go to three places (sized follow-up work,
// Notes, a task), and the implementing and fixing prompts fix a small
// finding in code the branch touches instead of deferring it (from S-638).
test('the implementing and fixing prompts fix a one-point finding and never defer a nit', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    for (const name of [
      'feature-story',
      'feature-workon',
      'feature-workon-review',
      'feature-fix-self-review',
      'feature-fix-tests',
      'story-run',
    ]) {
      const text = loadPrompt(name, CASES[name], { agent: 'claude', config });
      assert.match(text, /about one point in code this\s+branch\s+already\s+touches/, name);
      assert.match(text, /a nit is fixed\s+or dropped, never deferred/, name);
      assert.doesNotMatch(text, /\[points: -\]|Operator tasks|→ deferred \(nit\)/, name);
    }
    for (const name of ['feature-story', 'feature-workon']) {
      const text = loadPrompt(name, CASES[name], { agent: 'claude', config });
      assert.match(
        text,
        /a bullet under the feature's\s+\*\*## Deferred\*\*,\s+starting with its estimate `\[points: N\]`/,
        name,
      );
      assert.match(text, /under the\s+feature's \*\*## Notes\*\*/, name);
      assert.match(text, /`bl task F-9 --title "<what to do>" --gate <merge\|next\|none> --body-file <file>`/, name);
      assert.match(text, /warn the operator with a task, `bl task F-9 --title "<the warning>"\s+--gate none`/, name);
    }
  } finally {
    cleanup();
  }
});

// S-867: a pathspec-less `git commit` in the shared backlog takes along what
// other sessions have staged, so every backlog commit a prompt asks for goes
// through the locked `bl sync --commit`.
const PROMPTS_DIR = fileURLToPath(new URL('../../prompts/', import.meta.url));

test('no prompt commits the backlog with a raw git add / git commit', () => {
  const raw = /git\s+-C\s+\{\{backlogDir\}\}\s+(add|commit)\b/;
  const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 10);
  for (const f of files) {
    assert.doesNotMatch(readFileSync(PROMPTS_DIR + f, 'utf8'), raw, f);
  }
});

test('each loop prompt that commits the backlog names its bl sync --commit line', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const lines = {
      'feature-story': 'bl sync --commit -m "chore: S-1 implemented in F-9" --story S-1 --path features/F9-t/index.md',
      'feature-workon':
        'bl sync --commit -m "chore: S-<n> implemented in F-9" --story S-<n> --path features/F9-t/index.md',
      'review-verify':
        'bl sync --commit -m "chore: append review session for F-9 (<YYYY-MM-DD>)" --path features/F9-t/change.md --path features/F9-t/index.md',
      'feature-workon-review':
        'bl sync --commit -m "chore: address review feedback (F-9, session <YYYY-MM-DD>)" --path features/F9-t/change.md --path features/F9-t/index.md',
      'feature-self-review': 'bl sync --commit -m "chore: self-review notes for F-9" --path features/F9-t/index.md',
      'feature-fix-self-review':
        'bl sync --commit -m "chore: escalate F-9 fix self-review" --path features/F9-t/index.md',
    };
    for (const [name, line] of Object.entries(lines)) {
      const text = loadPrompt(name, CASES[name], { agent: 'claude', config });
      assert.ok(text.includes(line), `${name} lacks: ${line}`);
      // The ad-hoc story partial commits through the lock too.
      if (name !== 'review-verify')
        assert.ok(
          text.includes(
            'bl sync --commit -m "chore: S-<id> ad-hoc fix in F-9" --story S-<id> --path features/F9-t/index.md',
          ),
          `${name}: ad-hoc fix commit`,
        );
      assert.doesNotMatch(text, /Do NOT run `bl sync`/, name);
      assert.doesNotMatch(text, /git -C \/b (add|commit)/, name);
    }
    const refine = loadPrompt('feature-refine', { ...BASE }, { agent: 'claude', config });
    assert.match(refine, /bl sync --commit -m "chore: refine F-9" --path features\/F9-t\/index\.md --story S-<id>/);
    assert.doesNotMatch(refine, /git -C \/b (add|commit)/);
  } finally {
    cleanup();
  }
});

for (const [name, vars] of Object.entries(CASES)) {
  test(`${name} renders with the loop's variables and leaves no placeholder unresolved`, () => {
    const { dir, cleanup } = mkTempBacklog();
    try {
      const config = loadConfig({ backlogRoot: dir });
      for (const agent of ['claude', 'codex']) {
        const text = loadPrompt(name, vars, { agent, config });
        const left = [...new Set(text.match(/\{\{[A-Za-z]+\}\}/g) ?? [])];
        assert.deepEqual(left, [], `${name} (${agent}) left ${left.join(', ')}`);
      }
    } finally {
      cleanup();
    }
  });
}

test('both review passes ask for an origin tag and the verifier routes pre-existing findings to Deferred', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    for (const dim of ['review-correctness', 'review-failure-paths']) {
      const text = loadPrompt(dim, CASES[dim], { agent: 'codex', config });
      assert.match(text, /Origin: <introduced\|pre-existing>/);
      assert.match(text, /git diff main\.\.\.HEAD/);
    }
    const verify = loadPrompt('review-verify', CASES['review-verify'], { agent: 'codex', config });
    assert.match(verify, /Only `introduced` findings go into the session/);
    assert.match(verify, /\(pre-existing, review round 1\)/);
    assert.match(verify, /passed step 4 in the round that found it, so these are all\s+`introduced`/);
  } finally {
    cleanup();
  }
});

test('the class contract runs through reviewer, verifier, fixer, and fix self-review', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const render = (name) => loadPrompt(name, CASES[name], { agent: 'codex', config });
    for (const dim of ['review-correctness', 'review-failure-paths']) {
      const t = render(dim);
      assert.match(t, /Name the class, and hunt it/, dim);
      assert.match(t, /Class: <class> — instances: <list>; also check: <where>\./, dim);
    }
    const verify = render('review-verify');
    assert.match(verify, /merge findings of\s+the \*\*same class\*\* into one item/);
    assert.match(verify, /did not close the class/);
    // Both Must and Should templates in the session block carry the class field.
    const block = verify.slice(verify.indexOf('### Session <YYYY-MM-DD>'), verify.indexOf('_Dropped:_'));
    const must = block.slice(block.indexOf('**Must fix**'), block.indexOf('**Should fix**'));
    const should = block.slice(block.indexOf('**Should fix**'), block.indexOf('**Nits**'));
    assert.match(must, /Class: <class> — instances: <list>; also check: <where>\./, 'Must template');
    assert.match(should, /Class: <class> — instances: <list>; also check: <where>\./, 'Should template');
    const fix = render('feature-workon-review');
    assert.match(fix, /Sweep the class, not just the instance/);
    assert.match(fix, /class <name>: fixed <every instance>/);
    const selfReview = render('feature-fix-self-review');
    assert.match(selfReview, /The class is closed/);
    assert.match(selfReview, /Every change maps to an item or its class/);
  } finally {
    cleanup();
  }
});

const STACK_PROMPTS = [
  'workon',
  'story-run',
  'feature-story',
  'feature-workon',
  'feature-workon-review',
  'feature-fix-tests',
];

test('with no session_stack configured, no prompt says anything about a session stack', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    for (const name of STACK_PROMPTS) {
      for (const agent of ['claude', 'codex']) {
        const text = loadPrompt(name, CASES[name] ?? BASE, { agent, config });
        const where = `${name} (${agent})`;
        assert.doesNotMatch(text, /session stack|containers\/|PLAYWRIGHT_|docker (logs|restart)/i, where);
        assert.doesNotMatch(text, /\{\{sessionStack(Tools)?\}\}/, `${where}: the empty slot renders as ""`);
      }
    }
  } finally {
    cleanup();
  }
});

test("a session_stack guide renders in every session prompt, the prompt's own fragment first", () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    writeStackGuide(dir, {
      default: '## Session stack\n\nSession `{{sessionId}}` (number {{sessionNum}}) runs {{worktreePath}}.\n\n',
      'feature-fix-tests': '## Session stack\n\nFix-tests on session {{sessionNum}}.\n',
      'tool-guide': 'Raw docker verbs are denied: use `{{roostDir}}/stack/session exec`.\n',
    });
    const config = loadConfig({ backlogRoot: dir });
    for (const name of STACK_PROMPTS) {
      for (const agent of ['claude', 'codex']) {
        const text = loadPrompt(name, CASES[name] ?? BASE, { agent, config });
        const where = `${name} (${agent})`;
        assert.equal(text.split('## Session stack').length, 2, `${where}: one section`);
        if (name === 'feature-fix-tests') assert.match(text, /Fix-tests on session 597\.\n/, where);
        else assert.match(text, /Session `s(597|9)` \(number (597|9)\) runs \/wt\.\n\n\S/, where);
        assert.match(text, /Raw docker verbs are denied: use `\/roost\/stack\/session exec`\./, `${where}: tool guide`);
      }
    }
  } finally {
    cleanup();
  }
});

test("fix-tests reads the gate's log and does not fix a gate that runs other code", () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const fix = loadPrompt('feature-fix-tests', CASES['feature-fix-tests'], { agent: 'claude', config });
    assert.match(fix, /read the full log at `\/b\/\.bl\/run\/F-9\.test-1\.log`/, "fix-tests: reads the gate's log");
    assert.match(fix, /Do not rerun the suite to see its output/, 'fix-tests: no rerun to diagnose');
    assert.match(fix, /## Failure excerpt\n[\s\S]*Error: x/, 'fix-tests: the excerpt is shown');
    assert.doesNotMatch(fix, /redirected to a file/, 'fix-tests: the old rerun-and-redirect rule is gone');
    assert.match(fix, /the gate is\s+testing the wrong code/, 'fix-tests: a gate on other code is not fixed in code');
  } finally {
    cleanup();
  }
});

test('implement, fix-tests and review-fix sessions write diagnostics to the scratch dir and are never told to delete files', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    for (const name of ['feature-story', 'feature-workon-review', 'feature-fix-tests']) {
      for (const agent of ['claude', 'codex']) {
        const text = loadPrompt(name, CASES[name], { agent, config });
        const where = `${name} (${agent})`;
        assert.match(
          text,
          /Write diagnostics \(probe scripts, redirected test output, scratch configs\) under\s+`\/b\/\.bl\/run\/F-9\.x\.scratch`, never in the worktree\./,
          where,
        );
        assert.doesNotMatch(
          text,
          /\b[Dd]elete\b(?! , skip, or loosen an assertion)(?!, skip, or loosen)/,
          `${where}: no delete instruction`,
        );
      }
    }
    const fix = loadPrompt('feature-fix-tests', CASES['feature-fix-tests'], { agent: 'claude', config });
    assert.match(
      fix,
      /redirect its output to a file in\s+`\/b\/\.bl\/run\/F-9\.x\.scratch`/,
      'rule 1 redirects into the scratch dir',
    );
    assert.match(fix, /Move any that do not belong into `\/b\/\.bl\/run\/F-9\.x\.scratch`/, 'rule 5 moves strays out');
    assert.match(fix, /`UNRELATED`\s+stops the run and escalates/, 'the agent knows UNRELATED escalates');
    assert.match(fix, /^  - `FIXED`: /m, 'FIXED is one final line');
    assert.match(fix, /^  - `RERUN: <what you tried>`: /m, 'RERUN is one final line');
    assert.match(fix, /^  - `UNRELATED: <reason>`: use it only when nothing in the repos/m, 'UNRELATED is narrowed');
    assert.match(
      fix,
      /"Flaky", "intermittent", "timeout"\s+and "not caused by this branch" are never reasons for `UNRELATED`/,
    );
    assert.match(
      fix,
      /4\. A failure this branch did not cause is still a bug, and it is yours to fix\./,
      'rule 4 fixes flaky failures',
    );
    assert.doesNotMatch(
      fix,
      /record it under the\s+feature's \*\*## Deferred\*\* with `\[points: -\]`/,
      'the old defer-and-stop rule is gone',
    );
  } finally {
    cleanup();
  }
});

test("the verifier's Review Log session header names the configurations that reviewed (F-64 D4)", () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const text = loadPrompt('review-verify', CASES['review-verify'], { agent: 'codex', config });
    assert.ok(text.includes('### Session <YYYY-MM-DD> (PR #7; reviewed by codex gpt-6-sol, claude sonnet)'), text);
  } finally {
    cleanup();
  }
});

test("the verifier's closing round checks only the open items and is the only round that escalates them", () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const text = loadPrompt(
      'review-verify',
      { ...CASES['review-verify'], closingRound: 'true' },
      { agent: 'codex', config },
    );
    assert.match(text, /Closing round: true/);
    assert.match(text, /If this is the closing round\*\* \(`true` is true\)/);
    assert.match(text, /Do not look for new findings/);
    assert.match(
      text,
      /If this is the closing round and Must-fix or Should-fix items remain[\s\S]{0,160}write \*\*## Escalation\*\*/,
    );
    assert.match(text, /Before the closing round,\s+never write \*\*## Escalation\*\* for open items/);
    assert.doesNotMatch(text, /at or past the cap/, 'the old cap-round escalation rule is gone');
  } finally {
    cleanup();
  }
});

test("the correctness pass checks the diff against the repo's AGENTS.md conventions", () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const text = loadPrompt('review-correctness', CASES['review-correctness'], { agent: 'codex', config });
    assert.match(text, /7\. \*\*Check the repo's own conventions\.\*\*/);
    assert.match(text, /every one in\s+a directory above a changed file/);
    assert.match(text, /design-system example/);
    assert.match(text, /Quote the rule and its file/);
    assert.match(text, /Class: documented project convention not followed/);
    assert.match(text, /then the `AGENTS\.md` files rule 7 names/);
  } finally {
    cleanup();
  }
});

test('the correctness pass and the self-review check code placement against the package map', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const review = loadPrompt('review-correctness', CASES['review-correctness'], { agent: 'codex', config });
    assert.match(review, /8\. \*\*Check placement\.\*\*/);
    assert.match(review, /Class: code left in a package of its old role/);
    assert.match(review, /the\s+package map rule 8 names/);
    const self = loadPrompt('feature-self-review', CASES['feature-self-review'], { agent: 'codex', config });
    assert.match(self, /5\. \*\*Placement\.\*\*/);
    for (const [name, text] of [
      ['review-correctness', review],
      ['feature-self-review', self],
    ]) {
      assert.match(text, /package of its new role/, `${name}: asks where the code now belongs`);
      assert.match(text, /AGENTS\.md package map, where it has one/, `${name}: points at the package map`);
      assert.match(
        text,
        /even when the\s+diff never touches\s+the file|even when the diff never touches\s+the file/,
        `${name}: untouched files count`,
      );
    }
  } finally {
    cleanup();
  }
});

test('every code-writing feature prompt carries the blocked-by-a-bug rule with the exact ad-hoc story command', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    for (const name of [
      'feature-story',
      'feature-self-review',
      'feature-fix-self-review',
      'feature-workon-review',
      'feature-workon',
      'feature-fix-tests',
    ]) {
      for (const agent of ['claude', 'codex']) {
        const text = loadPrompt(name, CASES[name], { agent, config });
        const where = `${name} (${agent})`;
        assert.equal(text.split('## Blocked by a bug').length, 2, `${where}: the rule appears once`);
        assert.ok(
          text.includes(
            'bl new F-9 C03 --type bug --points <1|2|3> --no-sync --title "<the bug, in a few words>" --body-file /b/.bl/run/F-9.adhoc-<slug>.md',
          ),
          `${where}: the exact bl new command`,
        );
        // An existing story is attached first (S-1095); a refused attach
        // falls back to an operator task, never a second story.
        assert.ok(text.includes('bl attach S-<id> F-9 --no-sync\n'), `${where}: the exact bl attach command`);
        assert.ok(
          text.includes(
            'bl task F-9 --title "Ad-hoc fix (done, <short sha>): <the bug>" --gate none --body-file /b/.bl/run/F-9.adhoc-<slug>.md',
          ),
          `${where}: the task fallback`,
        );
        assert.match(text, /If `bl new` or `bl attach` fails/, where);
        assert.match(text, /"Flaky" and "not caused by this branch" are\s+not reasons to stop/, where);
        assert.match(text, /Fix the bug in its own commit\.\*\* The commit touches only that bug/, where);
        assert.match(
          text,
          /only for three things: an architectural\s+problem, a business rule that is unclear, or a conflict with\s+the project's written principles/,
          where,
        );
        assert.match(
          text,
          /bl sync --commit -m "chore: S-<id> ad-hoc fix in F-9" --story S-<id> --path features\/F9-t\/index\.md\n/,
          where,
        );
        assert.doesNotMatch(
          text,
          /Never create new stories\.(?!, except)/,
          `${where}: no blanket ban on the ad-hoc story`,
        );
      }
    }
    // A prompt with no slot does not get the rule.
    assert.doesNotMatch(
      loadPrompt('review-verify', CASES['review-verify'], { agent: 'claude', config }),
      /## Blocked by a bug/,
    );
  } finally {
    cleanup();
  }
});

test('every feature prompt that can escalate carries the escalation guide once', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const escalating = [
      'review-verify',
      'feature-fix-tests',
      'feature-story',
      'feature-workon',
      'feature-workon-review',
      'feature-self-review',
      'feature-fix-self-review',
    ];
    for (const name of escalating) {
      for (const agent of ['claude', 'codex']) {
        const text = loadPrompt(name, CASES[name], { agent, config });
        const where = `${name} (${agent})`;
        assert.equal(text.split('## Writing an escalation').length, 2, `${where}: the guide appears once`);
        assert.ok(!text.includes('{{escalationGuide}}'), `${where}: the slot is filled`);
        for (const heading of [
          '**The rule at stake:**',
          '**How it works:**',
          '**The problem:**',
          "**Why the agents can't fix it:**",
          '**The decision:**',
          '**Details:**',
        ]) {
          assert.ok(text.includes(heading), `${where}: ${heading}`);
        }
        assert.match(text, /timeline\s+table with named people \(Alice, Bob, Chad\)/, where);
        assert.match(text, /Use no unexplained jargon/, where);
        assert.match(text, /\| Time \| Alice \(removing Bob\)/, `${where}: the worked example`);
        assert.match(
          text,
          /Writing an\s+escalation\*\*\s+(below\s+)?describes/,
          `${where}: the escalation instruction points at the guide`,
        );
      }
    }
    // A prompt that never escalates does not get the guide.
    for (const name of ['review-correctness', 'review-failure-paths']) {
      assert.doesNotMatch(loadPrompt(name, CASES[name], { agent: 'claude', config }), /## Writing an escalation/, name);
    }
  } finally {
    cleanup();
  }
});

test('fix-tests asks for the UNRELATED explanation in the scratch escalation file; the verifier puts open items under Details', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const fix = loadPrompt('feature-fix-tests', CASES['feature-fix-tests'], { agent: 'claude', config });
    assert.match(
      fix,
      /write the full explanation for the\s+operator to `\/b\/\.bl\/run\/F-9\.x\.scratch\/escalation\.md`/,
    );
    assert.match(fix, /Keep the line itself to a short\s+summary/);
    const verify = loadPrompt('review-verify', CASES['review-verify'], { agent: 'claude', config });
    assert.match(
      verify,
      /carries your diagnosis: a code problem, a design problem,\s+or a test-infrastructure problem/,
    );
    assert.match(verify, /The open items, with their repros and tests, go in its\s+\*\*Details\*\* list/);
  } finally {
    cleanup();
  }
});

test('feature-refine records operator decisions in the Design and leaves ## Escalation at None.', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const text = loadPrompt(
      'feature-refine',
      { ...BASE, status: 'draft', storiesList: '(none)' },
      { agent: 'claude', config },
    );
    assert.match(text, /## Operator decisions and `## Escalation`/);
    assert.match(text, /`\*\*Decision A1 \(operator, YYYY-MM-DD\):\*\* …`/);
    assert.match(text, /\*\*## Open Questions\*\*/);
    assert.match(text, /\*\*## Escalation\*\* is only for a blocker that must stop `bl run`/);
    assert.match(text, /A refine normally leaves it exactly `None\.`/);
    assert.match(text, /never note it as "resolved" in \*\*## Escalation\*\*/);
    assert.match(text, /Any other text in \*\*## Escalation\*\* blocks `bl run`/);
    // Every escalating prompt's shared guide says how a decided escalation is cleared.
    const verify = loadPrompt('review-verify', CASES['review-verify'], { agent: 'claude', config });
    assert.match(verify, /never mark the escalation "resolved"\s+in place/);
    assert.match(verify, /set \*\*## Escalation\*\* back to exactly `None\.`/);
  } finally {
    cleanup();
  }
});
