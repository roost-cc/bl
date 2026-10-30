/**
 * Integration tests for `bl view` (S-1109): the unit's file opens as a
 * read-only copy in `<tmp>/<parent dir name>/<file name>`, in $VISUAL →
 * $EDITOR → vi, and the copy's temp directory is removed when the editor
 * exits; the real file is never changed. When the copy cannot be made, the
 * file is paged instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { GIT_ENV, initGitBacklog } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';

const VIEW_FAULTS = fileURLToPath(new URL('../helpers/view-faults.js', import.meta.url));
const bl = (args, cwd, env = {}) => runBl(args, { cwd, env: { ...GIT_ENV, ...env } });

function backlog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'One',
        body: '## Summary\n\nWork.\n\n## Dependencies\n\nNone.\n\n## To Do\n\nNone.',
      },
    ],
  });
  return dir;
}

/**
 * A fake editor that records the path it is given (its last argument) and that path's mode,
 * then makes the file writable, appends a line to it and exits 3.
 */
function fakeEditor() {
  const dir = mkTempDir('bl-view-editor-');
  const record = join(dir, 'record');
  const bin = join(dir, 'fake-editor');
  writeFileSync(
    bin,
    `#!/bin/sh
for f; do :; done
printf '%s\\n%s\\n' "$f" "$(stat -c %a "$f")" > '${record}'
chmod u+w "$f"
echo scribble >> "$f"
exit 3
`,
  );
  chmodSync(bin, 0o755);
  const read = () => {
    const [path, mode] = readFileSync(record, 'utf8').split('\n');
    return { path, mode };
  };
  return { bin, read };
}

test("bl view opens a read-only copy in VISUAL, removes it after, and exits with the editor's status", () => {
  const dir = backlog();
  const real = join(dir, 'stories', 'S1', 'index.md');
  const before = readFileSync(real, 'utf8');
  const mtime = statSync(real).mtimeMs;
  const tmp = mkTempDir('bl-view-tmp-');
  const editor = fakeEditor();

  const r = bl(['view', 'S-1'], dir, { VISUAL: `${editor.bin} --wait`, EDITOR: 'never-run', TMPDIR: tmp });
  assert.equal(r.status, 3, r.stderr);
  const { path, mode } = editor.read();
  assert.ok(path.startsWith(`${tmp}/bl-view-`), path);
  assert.ok(path.endsWith('/S1/index.md'), path);
  assert.equal(mode, '444');
  assert.equal(readFileSync(real, 'utf8'), before);
  assert.equal(statSync(real).mtimeMs, mtime);
  assert.equal(existsSync(dirname(dirname(path))), false, 'the bl-view-* directory is removed');
});

test('bl view uses EDITOR when VISUAL is unset', () => {
  const dir = backlog();
  const editor = fakeEditor();
  const r = bl(['view', 'S-1'], dir, { VISUAL: undefined, EDITOR: editor.bin, TMPDIR: mkTempDir('bl-view-tmp-') });
  assert.equal(r.status, 3, r.stderr);
  assert.ok(editor.read().path.endsWith('/S1/index.md'));
});

test('bl view of a task id copies tasks/T<n>-<slug>.md', () => {
  const dir = backlog();
  initGitBacklog(dir);
  assert.equal(bl(['task', 'S-1', '--title', 'Run the migration', '--gate', 'none'], dir).status, 0);
  const editor = fakeEditor();
  const r = bl(['view', 'T-1'], dir, { VISUAL: editor.bin, TMPDIR: mkTempDir('bl-view-tmp-') });
  assert.equal(r.status, 3, r.stderr);
  assert.ok(editor.read().path.endsWith('/tasks/T1-run-the-migration.md'), editor.read().path);
});

test('bl view survives a Ctrl-C the editor handles and still removes the copy', () => {
  // The terminal sends Ctrl-C to bl as well as to the editor (vi traps it). The fake editor
  // records its path, finds bl among its ancestors and sends it SIGINT, then exits 0.
  const dir = backlog();
  const tdir = mkTempDir('bl-view-editor-');
  const record = join(tdir, 'record');
  const bin = join(tdir, 'fake-editor');
  writeFileSync(
    bin,
    `#!/bin/sh
trap '' INT
for f; do :; done
printf '%s' "$f" > '${record}'
p=$PPID
until tr '\\0' ' ' < /proc/$p/cmdline | grep -q 'bl.js'; do p=$(ps -o ppid= -p $p | tr -d ' '); done
kill -INT $p
sleep 0.3
exit 0
`,
  );
  chmodSync(bin, 0o755);
  const r = bl(['view', 'S-1'], dir, { VISUAL: bin, TMPDIR: mkTempDir('bl-view-tmp-') });
  assert.equal(r.signal, null, "bl is not killed by the editor's Ctrl-C");
  assert.equal(r.status, 0, r.stderr);
  const path = readFileSync(record, 'utf8');
  assert.equal(existsSync(dirname(dirname(path))), false, 'the bl-view-* directory is removed');
});

test('bl view pages the file with one stderr line when the copy cannot be made', () => {
  const dir = backlog();
  const missing = join(mkTempDir('bl-view-tmp-'), 'missing');
  const r = bl(['view', 'S-1'], dir, { VISUAL: 'false', TMPDIR: missing, PAGER: 'cat' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, readFileSync(join(dir, 'stories', 'S1', 'index.md'), 'utf8'));
  assert.match(r.stderr, /^bl view: cannot make a read-only copy \(.*\); paging instead\n$/);
});

test('view_cleanup_failure_preserves_primary_outcome_and_reports_retained_path', async (t) => {
  // Both places bl removes the copy: after a failed setup (before the pager fallback) and
  // after the editor exits (before its status is passed on).
  const cases = [
    { name: 'setup failure, then cleanup failure', fault: 'chmod,rm', status: 0, paged: true },
    { name: 'editor exit, then cleanup failure', fault: 'rm', status: 3, paged: false },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      const dir = backlog();
      const tmp = mkTempDir('bl-view-tmp-');
      const r = bl(['view', 'S-1'], dir, {
        NODE_OPTIONS: `--import=${VIEW_FAULTS}`,
        BL_VIEW_FAULT: c.fault,
        VISUAL: fakeEditor().bin,
        PAGER: 'cat',
        TMPDIR: tmp,
      });
      assert.equal(r.status, c.status, r.stderr);
      if (c.paged) assert.equal(r.stdout, readFileSync(join(dir, 'stories', 'S1', 'index.md'), 'utf8'));
      const kept = r.stderr.match(/^bl view: cannot remove (\S+) \(injected rm failure\); left behind$/m);
      assert.ok(kept, r.stderr);
      assert.ok(kept[1].startsWith(`${tmp}/bl-view-`), kept[1]);
      assert.equal(existsSync(kept[1]), true, 'the reported directory is the one left behind');
    });
  }
});

test('bl view --help names the editor chain, the read-only copy and the wait flag', () => {
  const r = bl(['view', '--help'], backlog(), { VISUAL: 'myeditor' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /read-only copy of the file in myeditor \(\$VISUAL → \$EDITOR → vi\)/);
  assert.match(r.stdout, /discarded when the editor exits/);
  assert.match(r.stdout, /code --wait/);
});
