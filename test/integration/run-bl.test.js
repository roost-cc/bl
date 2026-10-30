import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { lockOwnerVisible, startBlBehindLock } from '../helpers/run-bl.js';
import { LOCK_FILE } from '../../src/lock.js';

// S-877: startBlBehindLock must observe a live lock this process owns, must
// settle both promises for every way the child ends, and must not reject
// `blocked` while the child is still running. Each case is its own test so a
// failure in one cannot hide the others.

/** S-1 depends on S-3, so `bl fix --story S-1` takes the lock to write S-3. */
function backlog() {
  return mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'one', depends_on: 'S-3' },
      { id: 'S-3', component: 'C01', title: 'three' },
    ],
  });
}

const holdLock = (dir, pid = process.pid) =>
  writeFileSync(join(dir, LOCK_FILE), `${pid}\n${new Date().toISOString()}\n`);

/** An executable node script in `dir` that never writes and never exits. */
function silentBin(dir, body) {
  const path = join(dir, 'silent.js');
  writeFileSync(path, `#!/usr/bin/env node\n${body}\nsetInterval(() => {}, 1000);\n`);
  chmodSync(path, 0o755);
  return path;
}

test('startBlBehindLock observes a live lock before its timeout', async (t) => {
  if (!lockOwnerVisible(t)) return;
  const { dir, cleanup } = backlog();
  try {
    holdLock(dir);
    const run = startBlBehindLock(['fix', '--story', 'S-1'], { cwd: dir });
    await run.blocked;
    unlinkSync(join(dir, LOCK_FILE));
    const r = await run.closed;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.signal, null);
  } finally {
    cleanup();
  }
});

test('startBlBehindLock refuses a lock this process does not own', () => {
  const cases = [
    { name: 'no lock file', setup: () => {}, found: /found "ENOENT"/ },
    {
      name: 'lock held by another pid',
      setup: (dir) => holdLock(dir, process.ppid),
      found: new RegExp(`found "${process.ppid}\\\\n`),
    },
    {
      // The child would look for the lock under the overridden root.
      name: 'BL_BACKLOG_DIR overridden away from the held lock',
      setup: (dir) => {
        holdLock(dir);
        mkdirSync(join(dir, 'elsewhere'));
      },
      env: (dir) => ({ BL_BACKLOG_DIR: join(dir, 'elsewhere') }),
      found: /elsewhere\/\.bl-new\.lock must name this process .* found "ENOENT"/,
    },
  ];
  for (const c of cases) {
    const { dir, cleanup } = backlog();
    try {
      c.setup(dir);
      assert.throws(() => startBlBehindLock(['help'], { cwd: dir, env: c.env?.(dir) }), c.found, c.name);
    } finally {
      cleanup();
    }
  }
});

const failures = [
  {
    name: 'exits before announcing',
    args: ['help'],
    rejects: /bl exited before waiting for the lock, status 0/,
    status: 0,
    signal: null,
  },
  {
    name: 'stays silent past the timeout',
    bin: (dir) => silentBin(dir, ''),
    timeoutMs: 300,
    rejects: /never reported waiting for the lock within 300 ms \(lock file then: "\d+\\n/,
    status: null,
    signal: 'SIGTERM',
  },
  {
    // SIGTERM does not end it, so the helper must follow up with SIGKILL.
    name: 'survives SIGTERM after the timeout',
    bin: (dir) => silentBin(dir, `process.on("SIGTERM", () => {});`),
    timeoutMs: 300,
    rejects: /never reported waiting for the lock within 300 ms/,
    status: null,
    signal: 'SIGKILL',
  },
  {
    name: 'fails to start',
    bin: (dir) => join(dir, 'missing-bl'),
    rejects: /bl exited before waiting for the lock \(spawn .* ENOENT\)/,
    status: null,
    signal: null,
  },
];

for (const c of failures) {
  test(`startBlBehindLock settles after the child ${c.name}`, async () => {
    const { dir, cleanup } = backlog();
    try {
      holdLock(dir);
      const run = startBlBehindLock(c.args ?? [], {
        cwd: dir,
        bin: c.bin?.(dir),
        timeoutMs: c.timeoutMs,
      });
      let closed = false;
      run.closed.then(() => (closed = true));
      await assert.rejects(run.blocked, c.rejects);
      assert.equal(closed, true, 'blocked rejected before the child closed');
      const r = await run.closed;
      assert.equal(r.status, c.status, r.stderr);
      assert.equal(r.signal, c.signal);
    } finally {
      cleanup();
    }
  });
}
