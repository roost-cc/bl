import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { findExistingWorktree } from '../../src/story.js';
import { git, statusLines } from '../helpers/git-backlog.js';
import { build, fmOf, sideWithFaults, storyDirs } from '../helpers/side-fixture.js';

const BL_JS = fileURLToPath(new URL('../../src/bl.js', import.meta.url));

/** repoB's bootstrap runs `command`; the config change is committed, so the tree starts clean. */
function withBootstrap(dir, command) {
  const p = join(dir, 'backlog.json');
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  cfg.plugins = { ...(cfg.plugins ?? {}), broken: { bootstrap: command } };
  cfg.repos.repoB['plugins-bootstrap'] = ['broken'];
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  git(dir, 'commit', '-q', '-am', 'bootstrap');
}

// side_failure_and_concurrent_sync_preserve_unit_consistency: whatever step
// fails, attached or standalone, the backlog holds either nothing of the side
// story or the whole committed unit, never a half; no worktree outlives a
// story that is gone; and nothing another commit holds is deleted.
test('side_failure_and_concurrent_sync_preserve_unit_consistency: a failure at any step leaves the whole unit or none of it', () => {
  const cases = [
    { name: 'mark', faults: 'mark' },
    { name: 'change write', faults: 'change' },
    { name: 'bootstrap', faults: '', bootstrap: 'node -e "process.exit(7)"' },
    { name: 'concurrent sync in bootstrap', faults: '', bootstrap: 'sync' },
    { name: 'undo fails', faults: 'mark,undo' },
  ];
  for (const c of cases) {
    for (const from of ['F-1', 'S-3']) {
      const label = `${c.name}, --from ${from}`;
      const { tmp, dir, repos, mainBranches } = build();
      if (c.bootstrap === 'sync') {
        const script = join(tmp, 'sync-then-fail.mjs');
        writeFileSync(
          script,
          `import { spawnSync } from "child_process";\nspawnSync(process.execPath, [${JSON.stringify(BL_JS)}, "sync", "--commit", "--story", "S-4", "-m", "concurrent sync"], { stdio: "inherit", cwd: process.env.BL_BACKLOG_DIR });\nprocess.exit(7);\n`,
        );
        withBootstrap(dir, `node ${script}`);
      } else if (c.bootstrap) {
        withBootstrap(dir, c.bootstrap);
      }
      const head = git(dir, 'rev-parse', 'HEAD');
      const featureBefore = readFileSync(join(dir, 'features', 'F1-run', 'index.md'), 'utf8');
      const changeBefore = readFileSync(join(dir, 'features', 'F1-run', 'change.md'), 'utf8');
      const r = sideWithFaults(dir, from, c.faults);
      assert.equal(r.status, 1, `${label}: ${r.stderr}`);
      assert.equal(r.stdout, '', label);
      const s4 = storyDirs(dir).find((d) => d.startsWith('S4-'));
      // Standalone, the worktree comes after the commit: a bootstrap failure
      // keeps the committed story, whole, and says how to finish.
      const kept = from === 'S-3' && Boolean(c.bootstrap);
      if (kept) {
        assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-4 (bl side, found by S-3)', label);
        const fm = fmOf(join(dir, 'stories', s4, 'index.md'));
        assert.deepEqual([fm.status, fm.found_by], ['in_progress', 'S-3'], label);
        const change = fmOf(join(dir, 'stories', s4, 'change.md'));
        assert.deepEqual(
          change.repos.map((e) => [e.repo, e.branch]),
          [['repoB', 's4-partial']],
          label,
        );
        assert.deepEqual(statusLines(dir), [], label);
        assert.match(r.stderr, /S-4 is committed, but its worktree could not be prepared .*`bl implement S-4`/, label);
        assert.ok(
          findExistingWorktree(repos.repoB, 's4-partial'),
          `${label}: the story's own worktree stays for bl implement`,
        );
      } else if (c.faults.includes('undo')) {
        // The undo itself failed: what is left is named, not hidden.
        assert.match(r.stderr, /could not be undone \(injected undo failure\)/, label);
        assert.equal(git(dir, 'rev-parse', 'HEAD'), head, label);
        assert.equal(
          readFileSync(join(dir, 'features', 'F1-run', 'index.md'), 'utf8'),
          featureBefore,
          `${label}: the feature is put back first`,
        );
      } else {
        assert.equal(s4, undefined, `${label}: no story left`);
        assert.equal(git(dir, 'rev-parse', 'HEAD'), head, `${label}: nothing committed`);
        assert.deepEqual(statusLines(dir), [], `${label}: no tracked deletion or stray file`);
        assert.equal(readFileSync(join(dir, 'features', 'F1-run', 'index.md'), 'utf8'), featureBefore, label);
        assert.equal(readFileSync(join(dir, 'features', 'F1-run', 'change.md'), 'utf8'), changeBefore, label);
        assert.equal(
          findExistingWorktree(repos.repoB, from === 'F-1' ? 'f1-run' : 's4-partial'),
          null,
          `${label}: no orphan worktree`,
        );
        assert.doesNotMatch(r.stderr, /nothing else was written/, label);
      }
      assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' }, label);
    }
  }
});
