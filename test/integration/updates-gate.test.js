import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { BRANCHES, fakeRunner, gitCalls, mkReport, run, setup, shellCalls } from '../helpers/updates-run-fixture.js';

// The gate's tracked-state check against a real Git worktree; the unit
// counterpart with an injected runner is in test/unit/updates-run.test.js.
test('bootstrap changing tracked state cannot produce a green merge of the original commit', async () => {
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const fix = (cwd) => writeFileSync(join(cwd, 'tracked.txt'), 'fixed');
  const commit = (cwd) => git(cwd, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qam', 'fix']);
  // [case, step that changes the worktree, what it does, merged?]
  const cases = [
    ['unstaged', 'make vendor', fix, false],
    ['staged', 'make vendor', (cwd) => (fix(cwd), git(cwd, ['add', '.'])), false],
    ['committed', 'make vendor', (cwd) => (fix(cwd), commit(cwd)), false],
    ['test step', 'npm test', fix, false],
    ['ignored build output', 'make vendor', (cwd) => writeFileSync(join(cwd, 'vendor.min.js'), 'x'), true],
  ];
  for (const [name, changer, change, merged] of cases) {
    const t = await setup(mkReport({ 'roost-cc/bl': [BRANCHES.vitest] }), {
      bootstrap: true,
    });
    try {
      const runner = fakeRunner();
      const fake = runner.git.bind(runner);
      let wt;
      // The update worktree is a real repo: HEAD and status answer from it.
      runner.git = (args, cwd) => {
        if (args[0] === 'worktree' && args[1] === 'add') {
          wt = args[3];
          mkdirSync(wt, { recursive: true });
          git(wt, ['init', '-q']);
          writeFileSync(join(wt, '.gitignore'), '*.min.js\n');
          writeFileSync(join(wt, 'tracked.txt'), name === 'ignored build output' ? 'fixed' : 'broken');
          git(wt, ['add', '.']);
          commit(wt);
        }
        if (cwd === wt && ['rev-parse', 'status'].includes(args[0])) {
          runner.calls.push({ type: 'git', args, cwd });
          return spawnSync('git', args, { cwd, encoding: 'utf8' });
        }
        return fake(args, cwd);
      };
      runner.shell = (cmd, cwd) => {
        runner.calls.push({ type: 'shell', cmd, cwd });
        if (cmd === changer) change(cwd);
        const ok = readFileSync(join(cwd, 'tracked.txt'), 'utf8') === 'fixed';
        return { status: cmd === 'npm test' && !ok ? 1 : 0, output: '' };
      };
      const { res, lines } = await run(t, runner);
      assert.equal(res.outcomes[0].kind, merged ? 'merged' : 'held', name);
      assert.equal(
        gitCalls(runner, 'merge').some((c) => c.args[1] === '--no-ff'),
        merged,
        name,
      );
      if (!merged) {
        assert.match(lines[0], new RegExp(`\`${changer}\` left the worktree different from the commit to merge`), name);
        // The failing step stops the gate: nothing after it runs.
        assert.equal(shellCalls(runner).at(-1).cmd, changer, name);
      }
    } finally {
      t.cleanup();
    }
  }
});
