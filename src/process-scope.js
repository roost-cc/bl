/**
 * Process scopes: run a headless step or a test-gate command in a user systemd
 * scope, and afterwards stop whatever is still running in it (F-70 D4).
 *
 * Why: processes a step starts outlive it. F-64's review left four hung
 * `codex-linux-sandbox` process groups with `node --test` children, reparented
 * to `systemd --user` and still running days later, and S-581's review left
 * another (F-70 Premise 3). A process group per step does not catch them: a
 * `setsid` child leaves the group, and those leftovers were exactly that. A
 * cgroup does: `systemd-run --user --scope` execs the command in a new scope
 * unit, every descendant stays in the scope's cgroup whatever it does with
 * `setsid` or reparenting, the command's exit status passes through, and
 * `systemctl --user stop <unit>.scope` kills what is left (verified at
 * refine, 2026-10-29, systemd 259).
 *
 * - The probe, `systemd-run --user --scope --quiet --collect true`, runs once
 *   per bl process (Linux only) and is cached. Without user systemd (macOS, a
 *   host or guest without a user manager, bl inside a sandbox) steps run
 *   unscoped and nothing is killed (decision D4-a): there is no cwd-snapshot
 *   fallback, which could kill an editor or a dev server the operator runs in
 *   the worktree.
 * - Unit names are `bl-<unit id, lowercased>-<bl pid>-<n>`, sanitized to
 *   `[a-z0-9-]`, so a later bl can find a crashed bl's scopes by unit and see
 *   that their pid is dead (`staleScopes`).
 * - Names are passed and returned without the `.scope` suffix.
 */
import { spawnSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { isPidAlive } from './lock.js';
import { spawnSyncFiles } from './child-stdio.js';

/** How long `systemctl stop` lets a scope's processes exit on SIGTERM before SIGKILL. */
const STOP_TIMEOUT = 'TimeoutStopSec=10s';

/** A process's command line is trimmed to this many characters in a record. */
const COMMAND_MAX = 120;

let probed = null;

function systemctl(args, timeout = 30_000) {
  return spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}

/** The first line of a failed command's stderr, or its exit, for a reason. */
function failureText(r) {
  if (r.error) return r.error.code === 'ENOENT' ? `${r.error.path ?? 'command'} not found` : r.error.message;
  const line = String(r.stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return line ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
}

/**
 * Whether steps can run in a user systemd scope here: `{ ok: true }`, or
 * `{ ok: false, why }`. Probed once per bl process.
 *
 * @returns {{ ok: boolean, why?: string }}
 */
export function scopeAvailable() {
  if (probed) return probed;
  if (process.platform !== 'linux') {
    probed = { ok: false, why: `user systemd scopes need Linux; this is ${process.platform}` };
    return probed;
  }
  const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 30_000,
  });
  probed =
    !r.error && r.status === 0
      ? { ok: true }
      : { ok: false, why: `\`systemd-run --user --scope --quiet --collect true\` failed: ${failureText(r)}` };
  return probed;
}

/** `F-70` → `f-70`: a unit id as it appears in a scope name. */
function unitSlug(unitId) {
  return String(unitId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
}

/**
 * The scope name for the `n`th scope bl process `pid` starts for `unitId`:
 * `bl-f-70-12345-3`.
 */
export function scopeUnitName(unitId, n, pid = process.pid) {
  return `bl-${unitSlug(unitId)}-${pid}-${n}`;
}

/**
 * The command and arguments that run `command args…` inside scope `unit`.
 * `systemd-run --scope` execs the command, so its stdio, environment, working
 * directory and exit status are the caller's.
 *
 * @returns {{ command: string, args: string[] }}
 */
export function scopedCommand(unit, command, args = []) {
  return {
    command: 'systemd-run',
    args: ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '-p', STOP_TIMEOUT, '--', command, ...args],
  };
}

/**
 * A `spawnSync` that runs its command inside scope `unit`: the `run` an agent
 * adapter's `spawn` takes. Captured streams go through files
 * (`spawnSyncFiles`), not pipes: `spawnSync` waits for every holder of a pipe
 * to close it, so a process the step left holding the command's stdout would
 * hang the call, and the cleanup that stops it would never run (seen at
 * implement: `bash -c 'setsid sleep 300 & exit 3'` with a piped stdout).
 */
export function scopedSpawn(unit) {
  return (command, args, options) => {
    const s = scopedCommand(unit, command, args);
    return spawnSyncFiles(s.command, s.args, options);
  };
}

/** Whether scope `unit` is active (running processes). */
export function scopeActive(unit) {
  return systemctl(['is-active', '--quiet', `${unit}.scope`]).status === 0;
}

/** Every pid in cgroup `dir` and the cgroups below it. */
function cgroupPids(dir) {
  const pids = [];
  try {
    for (const l of readFileSync(join(dir, 'cgroup.procs'), 'utf8').split('\n')) {
      const pid = Number.parseInt(l, 10);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
  } catch {
    return pids;
  }
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) pids.push(...cgroupPids(join(dir, e.name)));
    }
  } catch {
    // no sub-cgroups to read
  }
  return pids;
}

/** A process's command line, trimmed, from `/proc`; its `comm` when that is empty. */
function processCommand(pid) {
  let cmd = '';
  try {
    cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').trim();
    if (!cmd) cmd = `[${readFileSync(`/proc/${pid}/comm`, 'utf8').trim()}]`;
  } catch {
    cmd = '(exited)';
  }
  return cmd.length > COMMAND_MAX ? `${cmd.slice(0, COMMAND_MAX - 1)}…` : cmd;
}

/**
 * The processes still running in scope `unit`: `[{ pid, command }]`, `[]`
 * when the scope is gone (its command and everything it started exited, and
 * `--collect` removed it).
 *
 * @returns {{ pid: number, command: string }[]}
 */
export function scopeProcesses(unit) {
  if (!scopeActive(unit)) return [];
  const r = systemctl(['show', '-p', 'ControlGroup', '--value', `${unit}.scope`]);
  const cg = String(r.stdout ?? '').trim();
  if (r.status !== 0 || !cg) return [];
  return cgroupPids(`/sys/fs/cgroup${cg}`).map((pid) => ({ pid, command: processCommand(pid) }));
}

/**
 * Stop scope `unit`: SIGTERM to what is left, SIGKILL after the stop timeout.
 * `{ ok: true }` once the scope is no longer active; otherwise `{ ok: false,
 * output }` with why.
 *
 * @returns {{ ok: boolean, output?: string }}
 */
export function stopScope(unit) {
  const r = systemctl(['stop', `${unit}.scope`], 60_000);
  if (r.error || r.status !== 0) return { ok: false, output: failureText(r) };
  if (scopeActive(unit)) return { ok: false, output: `${unit}.scope is still active after the stop` };
  return { ok: true };
}

/**
 * The scopes of `unitId` whose bl is no longer running: leftovers of a bl that
 * crashed or was killed before it could stop them. The run's lock means no
 * live bl other than this one owns a scope of the unit.
 *
 * @returns {string[]}
 */
export function staleScopes(unitId) {
  const prefix = `bl-${unitSlug(unitId)}-`;
  const r = systemctl(['show', '-p', 'Id', '--value', `${prefix}*.scope`]);
  if (r.error || r.status !== 0) return [];
  const re = /^(\d+)-\d+\.scope$/;
  const out = [];
  for (const line of String(r.stdout ?? '').split('\n')) {
    const name = line.trim();
    if (!name.startsWith(prefix)) continue;
    const m = re.exec(name.slice(prefix.length));
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || isPidAlive(pid)) continue;
    out.push(name.slice(0, -'.scope'.length));
  }
  return out;
}
