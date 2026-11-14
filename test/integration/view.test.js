/**
 * Integration tests for `bl view` (S-1109): the unit's page opens as a
 * read-only copy in `<tmp>/<parent dir name>/<file name>`, in $VISUAL →
 * $EDITOR → vi, and the copy's temp directory is removed when the editor
 * exits; the real file is never changed. When the copy cannot be made, the
 * page is shown instead (`showText`). With stdout not a terminal the page is
 * printed (S-1139). The page is rendered, its generated tables in place
 * (F-79 D7); one with nothing to render is the file byte for byte. Tests of the editor path fake a terminal on
 * stdout with the `tty` fault, since runBl captures stdout in a file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { GIT_ENV, initGitBacklog } from '../helpers/git-backlog.js';
import { BL_BIN, runBl } from '../helpers/run-bl.js';
import { withNoAgent } from '../helpers/fake-agent.js';
import { rendered } from '../helpers/rendered.js';

const VIEW_FAULTS = fileURLToPath(new URL('../helpers/view-faults.js', import.meta.url));
const bl = (args, cwd, env = {}, input) => runBl(args, { cwd, env: { ...GIT_ENV, ...env }, input });
/** Env that makes `bl view`'s stdout read as a terminal, plus any other faults. */
const tty = (...faults) => ({ NODE_OPTIONS: `--import=${VIEW_FAULTS}`, BL_VIEW_FAULT: ['tty', ...faults].join(',') });

function backlog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'One',
        body: '## Summary\n\nWork.\n\n## Dependencies\n\nNone.\n\n## Deferred\n\nNone.',
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

  const r = bl(['view', 'S-1'], dir, {
    ...tty(),
    VISUAL: `${editor.bin} --wait`,
    EDITOR: 'never-run',
    TMPDIR: tmp,
  });
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
  const r = bl(['view', 'S-1'], dir, {
    ...tty(),
    VISUAL: undefined,
    EDITOR: editor.bin,
    TMPDIR: mkTempDir('bl-view-tmp-'),
  });
  assert.equal(r.status, 3, r.stderr);
  assert.ok(editor.read().path.endsWith('/S1/index.md'));
});

test('bl view of a task id copies tasks/T<n>-<slug>.md', () => {
  const dir = backlog();
  initGitBacklog(dir);
  assert.equal(bl(['task', 'S-1', '--title', 'Run the migration', '--gate', 'none'], dir).status, 0);
  const editor = fakeEditor();
  const r = bl(['view', 'T-1'], dir, { ...tty(), VISUAL: editor.bin, TMPDIR: mkTempDir('bl-view-tmp-') });
  assert.equal(r.status, 3, r.stderr);
  assert.ok(editor.read().path.endsWith('/tasks/T1-run-the-migration.md'), editor.read().path);
});

test('bl view survives a Ctrl-C, a Ctrl-\\ and a SIGTERM while the editor runs and still removes the copy', () => {
  // The terminal sends Ctrl-C and Ctrl-\ to bl as well as to the editor (vi traps them). The
  // fake editor records its path, finds bl among its ancestors and sends it SIGINT, SIGQUIT
  // and SIGTERM, then exits 0.
  const dir = backlog();
  const tdir = mkTempDir('bl-view-editor-');
  const record = join(tdir, 'record');
  const bin = join(tdir, 'fake-editor');
  writeFileSync(
    bin,
    `#!/bin/sh
trap '' INT QUIT TERM
for f; do :; done
printf '%s' "$f" > '${record}'
p=$PPID
until tr '\\0' ' ' < /proc/$p/cmdline | grep -q 'bl.js'; do p=$(ps -o ppid= -p $p | tr -d ' '); done
kill -INT $p
kill -QUIT $p
kill -TERM $p
sleep 0.3
exit 0
`,
  );
  chmodSync(bin, 0o755);
  const r = bl(['view', 'S-1'], dir, { ...tty(), VISUAL: bin, TMPDIR: mkTempDir('bl-view-tmp-') });
  assert.equal(r.signal, null, "bl is not killed by the editor's Ctrl-C");
  assert.equal(r.status, 0, r.stderr);
  const path = readFileSync(record, 'utf8');
  assert.equal(existsSync(dirname(dirname(path))), false, 'the bl-view-* directory is removed');
});

test('bl view shows the file with one stderr line when the copy cannot be made', () => {
  const dir = backlog();
  const missing = join(mkTempDir('bl-view-tmp-'), 'missing');
  const r = bl(['view', 'S-1'], dir, { ...tty(), VISUAL: 'false', TMPDIR: missing, PAGER: 'cat' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, readFileSync(join(dir, 'stories', 'S1', 'index.md'), 'utf8'));
  assert.match(r.stderr, /^bl view: cannot make a read-only copy \(.*\); showing it instead\n$/);
});

test('bl view pages a file taller than the terminal when the copy cannot be made', () => {
  const dir = backlog();
  const real = join(dir, 'stories', 'S1', 'index.md');
  writeFileSync(real, readFileSync(real, 'utf8') + Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(''));
  const pdir = mkTempDir('bl-view-pager-');
  const record = join(pdir, 'record');
  const pager = join(pdir, 'fake-pager');
  writeFileSync(pager, `#!/bin/sh\ncat > '${record}'\n`);
  chmodSync(pager, 0o755);
  const missing = join(mkTempDir('bl-view-tmp-'), 'missing');
  const r = bl(['view', 'S-1'], dir, { ...tty(), VISUAL: 'false', TMPDIR: missing, PAGER: pager });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'the pager, not bl, shows the file');
  assert.equal(readFileSync(record, 'utf8'), readFileSync(real, 'utf8'));
});

test('bl view with stdout redirected prints the file as it is: no editor, no copy', () => {
  const dir = backlog();
  const real = join(dir, 'stories', 'S1', 'index.md');
  // No trailing newline and a stray byte: printed unchanged, nothing appended or decoded.
  writeFileSync(real, Buffer.concat([readFileSync(real), Buffer.from('tail \xff no newline', 'latin1')]));
  const tmp = mkTempDir('bl-view-tmp-');
  const editor = fakeEditor();
  const outDir = mkTempDir('bl-view-out-');
  const r = runBl(['view', 'S-1'], {
    cwd: dir,
    env: { ...GIT_ENV, VISUAL: editor.bin, PAGER: 'false', TMPDIR: tmp },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(existsSync(join(dirname(editor.bin), 'record')), false, 'the editor never ran');
  assert.deepEqual(readdirSync(tmp), [], 'no bl-view-* directory');
  // Byte for byte, redirected to a file and piped to cat (a real pipe, not runBl's file).
  const sh = spawnSync(
    'sh',
    ['-c', `"$0" view S-1 > '${outDir}/file' && "$0" view S-1 | cat > '${outDir}/pipe'`, BL_BIN],
    {
      cwd: dir,
      env: withNoAgent({ ...process.env, ...GIT_ENV, BL_BACKLOG_DIR: dir, VISUAL: editor.bin, TMPDIR: tmp }),
      stdio: 'ignore',
    },
  );
  assert.equal(sh.status, 0);
  assert.deepEqual(readFileSync(join(outDir, 'file')), readFileSync(real));
  assert.deepEqual(readFileSync(join(outDir, 'pipe')), readFileSync(real));
  assert.deepEqual(readdirSync(tmp), [], 'no bl-view-* directory');
});

test('bl view with stdin piped and stdout a terminal still opens the editor', () => {
  const dir = backlog();
  const editor = fakeEditor();
  const r = bl(['view', 'S-1'], dir, { ...tty(), VISUAL: editor.bin, TMPDIR: mkTempDir('bl-view-tmp-') }, 'piped\n');
  assert.equal(r.status, 3, r.stderr);
  assert.ok(editor.read().path.endsWith('/S1/index.md'));
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
        ...tty(c.fault),
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

/** An executable `#!/bin/sh` script `name` in `dir` with `body`. */
function script(dir, name, body) {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * A PATH directory holding only what bin/bl needs to start (node, readlink, dirname) and
 * `extra` scripts, so `less` and `more` are missing unless a test adds them.
 * @param {Record<string, string>} extra — script name → body
 */
function barePath(extra = {}) {
  const dir = mkTempDir('bl-view-path-');
  symlinkSync(process.execPath, join(dir, 'node'));
  for (const tool of ['readlink', 'dirname']) {
    const found = process.env.PATH.split(delimiter)
      .map((d) => join(d, tool))
      .find((p) => existsSync(p));
    symlinkSync(found, join(dir, tool));
  }
  for (const [name, body] of Object.entries(extra)) script(dir, name, body);
  return dir;
}

test('view_primary_and_fallback_failures_exit_nonzero', async (t) => {
  const tall = (dir) => {
    const real = join(dir, 'stories', 'S1', 'index.md');
    writeFileSync(real, readFileSync(real, 'utf8') + Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(''));
  };
  const tools = mkTempDir('bl-view-tools-');
  const killed = script(tools, 'killed', 'kill -TERM $$');

  await t.test('an editor missing from PATH', () => {
    const r = bl(['view', 'S-1'], backlog(), {
      ...tty(),
      VISUAL: 'no-such-editor-bl-test',
      TMPDIR: mkTempDir('bl-v-'),
    });
    assert.equal(r.status, 127, r.stderr);
    assert.match(r.stderr, /no-such-editor-bl-test/);
  });

  await t.test('an editor killed by a signal', () => {
    const r = bl(['view', 'S-1'], backlog(), { ...tty(), VISUAL: killed, TMPDIR: mkTempDir('bl-v-') });
    assert.equal(r.signal, null);
    assert.equal(r.status, 143, r.stderr);
    // Through the shell, which reports the kill and exits 128 + 15 itself.
    assert.match(r.stderr, /Terminated/);
  });

  // The copy fails (`chmod`), so bl pages the file; it is taller than the terminal.
  await t.test('a PAGER killed by a signal', () => {
    const dir = backlog();
    tall(dir);
    const r = bl(['view', 'S-1'], dir, { ...tty('chmod'), PAGER: killed });
    assert.equal(r.status, 143, r.stderr);
    // Through the shell, which reports the kill and exits 128 + 15 itself.
    assert.match(r.stderr, /Terminated/);
  });

  await t.test("less missing, the more fallback's exit 7 is bl's", () => {
    const dir = backlog();
    tall(dir);
    const PATH = barePath({ more: 'cat > /dev/null; exit 7' });
    const r = bl(['view', 'S-1'], dir, { ...tty('chmod'), PAGER: undefined, PATH });
    assert.equal(r.status, 7, r.stderr);
  });

  await t.test('less missing, the more fallback killed by a signal', () => {
    const dir = backlog();
    tall(dir);
    const PATH = barePath({ more: 'kill -TERM $$' });
    const r = bl(['view', 'S-1'], dir, { ...tty('chmod'), PAGER: undefined, PATH });
    assert.equal(r.status, 143, r.stderr);
    // `src/child.js` raises the interrupt that ended more (F-114 D2).
    assert.match(r.stderr, /^bl: more was ended by SIGTERM$/m);
  });

  await t.test('less and more both missing', () => {
    const dir = backlog();
    tall(dir);
    const r = bl(['view', 'S-1'], dir, { ...tty('chmod'), PAGER: undefined, PATH: barePath() });
    assert.equal(r.status, 127, r.stderr);
    assert.match(r.stderr, /bl: could not start more: /);
  });

  // The paging verbs exit with the shared function's status the same way. bl agents pages
  // AGENTS.md, far taller than a terminal.
  await t.test('bl agents with a PAGER killed by a signal, and with the more fallback exiting 7', () => {
    const dir = backlog();
    const a = bl(['agents'], dir, { ...tty(), PAGER: killed });
    assert.equal(a.status, 143, a.stderr);
    const b = bl(['agents'], dir, { ...tty(), PAGER: undefined, PATH: barePath({ more: 'cat > /dev/null; exit 7' }) });
    assert.equal(b.status, 7, b.stderr);
  });
});

/** A backlog with a page of every kind: a feature with a story under an epic, and a theme. */
function everyKind() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    valueEpics: [{ id: 'E50', title: 'Value', dirSuffix: 'value' }],
    features: [{ id: 'F-1', title: 'Feat', status: 'approved', epic: 'E50', stories: ['S-1'] }],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', body: '## Summary\n\nWork.\n\n## Dependencies\n\nNone.' }],
  });
  initGitBacklog(dir);
  assert.equal(bl(['task', 'S-1', '--title', 'Run the migration', '--gate', 'none'], dir).status, 0);
  return dir;
}

test('bl view prints each page kind and the root rendered, its generated tables in place (F-79 D7)', () => {
  const dir = everyKind();
  // With no root index.md the root renders from nothing.
  assert.match(bl(['view'], dir).stdout, /^Total backlog: .*\n\n## Themes\n/);
  writeFileSync(join(dir, 'index.md'), '---\ntitle: Demo backlog\n---\n\n# Demo backlog\n\nHand-written.\n');
  const cases = [
    { id: 'F-1', file: 'features/F1/index.md', headings: ['Stories'] },
    { id: 'C01', file: 'components/C01/index.md', headings: ['Stories', 'Features'] },
    { id: 'S-1', file: 'stories/S1/index.md', headings: ['Tasks'] },
    { id: 'E50', file: 'epics/E50-value/index.md', headings: ['Features'] },
    { id: 'demo', file: 'themes/demo/index.md', headings: ['Epics', 'Features'] },
    { id: undefined, file: 'index.md', headings: ['Themes', 'Components', 'Priority'] },
  ];
  for (const c of cases) {
    const r = bl(['view', ...(c.id ? [c.id] : [])], dir, { VISUAL: 'false', PAGER: 'false' });
    assert.equal(r.status, 0, `${c.id}: ${r.stderr}`);
    assert.equal(r.stdout, rendered(dir, c.id), c.id);
    assert.notEqual(r.stdout, readFileSync(join(dir, c.file), 'utf8'), `${c.id} adds tables to the committed text`);
    for (const h of c.headings) assert.match(r.stdout, new RegExp(`^## ${h}\\n\\n\\| `, 'm'), `${c.id} ${h}`);
  }
  const root = bl(['view'], dir).stdout;
  assert.match(
    root,
    /^---\ntitle: Demo backlog\n---\n\n# Demo backlog\n\nTotal backlog: 1 points across 1 stories in 1 components\.\n\nHand-written\.\n/,
  );
  assert.match(bl(['view', 'S-1'], dir).stdout, /Run the migration/);
});

test('bl view opens the rendered page as the read-only copy and removes it after', () => {
  const dir = everyKind();
  const edir = mkTempDir('bl-view-editor-');
  const record = join(edir, 'record');
  const bin = script(
    edir,
    'fake-editor',
    `for f; do :; done\nprintf '%s\\n' "$f" > '${record}'\nstat -c %a "$f" >> '${record}'\ncat "$f" >> '${record}'`,
  );
  const real = join(dir, 'epics', 'E50-value', 'index.md');
  const before = readFileSync(real, 'utf8');
  const r = bl(['view', 'E50'], dir, { ...tty(), VISUAL: bin, TMPDIR: mkTempDir('bl-view-tmp-') });
  assert.equal(r.status, 0, r.stderr);
  const [path, mode, ...text] = readFileSync(record, 'utf8').split('\n');
  assert.ok(path.endsWith('/E50-value/index.md'), path);
  assert.equal(mode, '444');
  assert.equal(text.join('\n'), rendered(dir, 'E50'));
  assert.equal(existsSync(dirname(dirname(path))), false, 'the bl-view-* directory is removed');
  assert.equal(readFileSync(real, 'utf8'), before);
});

test('bl which and bl edit name an epic and a theme by the committed file', () => {
  const dir = everyKind();
  assert.equal(bl(['which', 'E50'], dir).stdout, `${join(dir, 'epics', 'E50-value', 'index.md')}\n`);
  assert.equal(bl(['which', '-d', 'demo'], dir).stdout, `${join(dir, 'themes', 'demo')}\n`);
  const editor = fakeEditor();
  assert.equal(bl(['edit', 'demo'], dir, { VISUAL: editor.bin }).status, 3);
  assert.equal(editor.read().path, join(dir, 'themes', 'demo', 'index.md'));
  assert.doesNotMatch(readFileSync(join(dir, 'themes', 'demo', 'index.md'), 'utf8'), /^## Epics\n\n\| /m);
  assert.match(bl(['which', '--help'], dir).stdout, /epic, or task ID, or a theme slug/);
  assert.match(bl(['edit', '--help'], dir).stdout, /epic, or task ID, or a theme slug/);
});

test('bl view --help names the editor chain, the read-only copy, the wait flag and redirection', () => {
  const r = bl(['view', '--help'], backlog(), { VISUAL: 'myeditor' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: bl view \[<id>\]/);
  assert.match(r.stdout, /epic, or task ID, or a theme slug/);
  assert.match(r.stdout, /With no id, the\s+backlog's root index\.md/);
  assert.match(r.stdout, /generated tables/);
  assert.match(r.stdout, /With stdout redirected \(not a terminal\), the page is printed: no editor, no pager\./);
  assert.match(r.stdout, /When the copy cannot be made, the page is shown instead/);
  assert.match(r.stdout, /read-only copy of the page in myeditor \(\$VISUAL → \$EDITOR → vi\)/);
  assert.match(r.stdout, /discarded when the editor exits/);
  assert.match(r.stdout, /code --wait/);
  assert.match(r.stdout, /While the editor is open the copy follows the real file/);
  assert.match(r.stdout, /vim reloads it with 'autoread'/);
  assert.match(r.stdout, /less and more show it when they open\s+the file again\s+\(:e in less\)/);
});

/**
 * A fake editor whose body runs with `$f` the copy and `$SRC` the real file, and
 * `seen <word>`: wait up to 5 s for the copy to hold <word>; after that, the copy is
 * written to `<record>.<word>`. stdout and stderr go to bl's stderr (runBl captures it).
 */
function followEditor(body) {
  const dir = mkTempDir('bl-view-editor-');
  const record = join(dir, 'record');
  const bin = script(
    dir,
    'fake-editor',
    `for f; do :; done
seen() { i=0; until grep -q "$1" "$f" || [ $i -ge 50 ]; do sleep 0.1; i=$((i+1)); done; cat "$f" > '${record}'."$1"; }
${body}`,
  );
  return { bin, read: (word) => readFileSync(`${record}.${word}`, 'utf8') };
}

test('bl view follows the real file: written in place and replaced by rename, the copy at one path and 0444 (S-1182)', () => {
  const dir = backlog();
  const real = join(dir, 'stories', 'S1', 'index.md');
  const before = readFileSync(real, 'utf8');
  const editor = followEditor(`exec 3< "$f"
printf '%s' "$(cat "$SRC")
in place
" > "$SRC"
seen 'in place'
printf '%s' "$(cat "$SRC")
renamed
" > "$SRC.tmp" && mv "$SRC.tmp" "$SRC"
seen renamed
stat -c '%a' "$f" >&2
cat <&3 > "$(dirname "$0")/held"
exit 5`);
  const r = bl(['view', 'S-1'], dir, { ...tty(), VISUAL: editor.bin, SRC: real, TMPDIR: mkTempDir('bl-view-tmp-') });
  assert.equal(r.status, 5, r.stderr);
  assert.equal(r.stderr, '444\n', 'the refreshed copy is 0444, and bl says nothing');
  assert.equal(editor.read('in place'), `${before}in place\n`);
  assert.equal(editor.read('renamed'), `${before}in place\nrenamed\n`);
  // A reader that held the first copy open (less, more) still reads it whole.
  assert.equal(readFileSync(join(dirname(editor.bin), 'held'), 'utf8'), before);
});

test('bl view refreshes a rendered page from the backlog after its file changes (S-1182)', () => {
  const dir = everyKind();
  const real = join(dir, 'epics', 'E50-value', 'index.md');
  const editor = followEditor(`printf '\\nAdded line.\\n' >> "$SRC"\nseen 'Added line'`);
  const r = bl(['view', 'E50'], dir, { ...tty(), VISUAL: editor.bin, SRC: real, TMPDIR: mkTempDir('bl-view-tmp-') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(editor.read('Added line'), rendered(dir, 'E50'));
  assert.match(editor.read('Added line'), /^## Features\n\n\| /m);
});

test('bl view refreshes a burst of writes once and skips a change that leaves the text as it is (S-1182)', () => {
  const dir = backlog();
  const real = join(dir, 'stories', 'S1', 'index.md');
  const log = join(mkTempDir('bl-view-log-'), 'renames');
  const editor = followEditor(`for n in 1 2 3 4 5; do printf 'burst %s\\n' $n > "$SRC"; done
seen 'burst 5'
touch "$SRC"
cp "$SRC" "$SRC.tmp" && mv "$SRC.tmp" "$SRC"
sleep 0.5`);
  const r = bl(['view', 'S-1'], dir, {
    ...tty('renames'),
    VISUAL: editor.bin,
    SRC: real,
    BL_VIEW_RENAME_LOG: log,
    TMPDIR: mkTempDir('bl-view-tmp-'),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(editor.read('burst 5'), 'burst 5\n');
  const renames = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(renames.length, 2, `the copy placed, then one refresh: ${renames}`);
  assert.ok(
    renames.every((to) => to.endsWith('/S1/index.md')),
    renames.join(', '),
  );
});

test('bl view keeps the copy while the real file is gone, says so once, and picks it up again (S-1182)', () => {
  const dir = backlog();
  const real = join(dir, 'stories', 'S1', 'index.md');
  const before = readFileSync(real, 'utf8');
  const editor = followEditor(`mv "$SRC" "$SRC.away"
sleep 0.4
rm "$SRC.away"
sleep 0.4
cat "$f" > "$(dirname "$0")/kept"
printf 'back\\n' > "$SRC"
seen back
exit 4`);
  const r = bl(['view', 'S-1'], dir, { ...tty(), VISUAL: editor.bin, SRC: real, TMPDIR: mkTempDir('bl-view-tmp-') });
  assert.equal(r.status, 4, r.stderr);
  assert.equal(readFileSync(join(dirname(editor.bin), 'kept'), 'utf8'), before);
  assert.equal(r.stderr, `bl view: ${real} is gone; the copy keeps its last text\n`);
  assert.equal(editor.read('back'), 'back\n');
});

test('bl view keeps the last copy and says so when a refresh fails (S-1182)', () => {
  const dir = backlog();
  const real = join(dir, 'stories', 'S1', 'index.md');
  const before = readFileSync(real, 'utf8');
  const editor = followEditor(`printf 'new\\n' > "$SRC"
sleep 0.6
cat "$f" > "$(dirname "$0")/kept"`);
  const r = bl(['view', 'S-1'], dir, {
    ...tty('rename'),
    VISUAL: editor.bin,
    SRC: real,
    TMPDIR: mkTempDir('bl-view-tmp-'),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dirname(editor.bin), 'kept'), 'utf8'), before);
  assert.equal(r.stderr, 'bl view: cannot refresh the copy (injected rename failure); it keeps its last text\n');
});
