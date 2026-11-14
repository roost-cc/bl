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
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describeExit, runChild, runLongChild } from './child.js';

/** How long `systemctl stop` lets a scope's processes exit on SIGTERM before SIGKILL. */
const STOP_TIMEOUT = 'TimeoutStopSec=10s';

/**
 * Whether `pid` names a live process. Only `staleScopes` asks it, about the
 * bl that started a scope; no lock decides from a PID (F-104).
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A process's command line is trimmed to this many characters in a record. */
const COMMAND_MAX = 120;

let probed = null;

function systemctl(args, timeout = 30_000) {
  return runChild('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}

/**
 * The first line of a failed command's stderr, else `describeExit` of it,
 * for a reason. `what` names the command (`systemctl`).
 */
function failureText(r, what = 'systemctl') {
  if (r.error) return r.error.code === 'ENOENT' ? `${r.error.path ?? 'command'} not found` : r.error.message;
  const line = String(r.stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return line ?? describeExit(r, what);
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
  const r = runChild('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 30_000,
  });
  probed =
    !r.error && r.status === 0
      ? { ok: true }
      : {
          ok: false,
          why: `\`systemd-run --user --scope --quiet --collect true\` failed: ${failureText(r, 'systemd-run')}`,
        };
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
 * An asynchronous function that runs its command inside scope `unit` as a
 * long child (`runLongChild`, F-128 D4): the `run` an agent adapter's
 * headless `spawn` takes, and the test gate's scoped command. It resolves
 * when the command exits, though a process the step left still holds its
 * output file, so the cleanup that stops that process runs (seen at
 * implement: `bash -c 'setsid sleep 300 & exit 3'` with a piped stdout hung
 * a wait for the pipe to close).
 *
 * @returns {(command: string, args: readonly string[], options?: object) =>
 *   ReturnType<typeof runLongChild>}
 */
export function scopedSpawn(unit) {
  return async (command, args, options) => {
    const s = scopedCommand(unit, command, args);
    return runLongChild(s.command, s.args, options);
  };
}

/**
 * Whether scope `unit` is active (running processes). systemd says
 * `inactive` of a unit `--collect` has removed, and `failed` of one that
 * ended badly: both are false. Throws when systemctl cannot answer or answers
 * with no state, so a broken user manager is never read as "gone".
 */
export function scopeActive(unit) {
  const r = systemctl(['is-active', `${unit}.scope`]);
  if (!r.error && r.status === 0) return true;
  const state = String(r.stdout ?? '').trim();
  if (r.error || !state) throw new Error(`could not tell whether ${unit}.scope is active: ${failureText(r)}`);
  return !['inactive', 'failed'].includes(state);
}

/**
 * Whether read error `err` says the cgroup is gone: ENOENT when it was removed
 * before the open, ENODEV when the kernel removed it between the open and the
 * read (kernfs answers a read of a removed node with ENODEV).
 */
function cgroupGone(err) {
  return err?.code === 'ENOENT' || err?.code === 'ENODEV';
}

/**
 * Every pid in cgroup `dir` and the cgroups below it. A sub-cgroup that is
 * gone (`cgroupGone`) has no processes; any other read failure throws.
 */
function cgroupPids(dir) {
  const pids = [];
  for (const l of readFileSync(join(dir, 'cgroup.procs'), 'utf8').split('\n')) {
    const pid = Number.parseInt(l, 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      pids.push(...cgroupPids(join(dir, e.name)));
    } catch (err) {
      if (!cgroupGone(err)) throw err;
    }
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
 * `--collect` removed it). Throws when the scope may still be running but its
 * processes cannot be listed: a failed or empty `ControlGroup` query, or an
 * unreadable cgroup. A cgroup gone by the time it is read (`cgroupGone`) is
 * rechecked.
 *
 * @returns {{ pid: number, command: string }[]}
 */
export function scopeProcesses(unit) {
  if (!scopeActive(unit)) return [];
  const r = systemctl(['show', '-p', 'ControlGroup', '--value', `${unit}.scope`]);
  const cg = String(r.stdout ?? '').trim();
  if (r.error || r.status !== 0 || !cg.startsWith('/')) {
    if (!scopeActive(unit)) return [];
    throw new Error(`could not read ${unit}.scope's control group: ${cg ? `\`${cg}\`` : failureText(r)}`);
  }
  let pids;
  try {
    pids = cgroupPids(`/sys/fs/cgroup${cg}`);
  } catch (e) {
    if (cgroupGone(e) && !scopeActive(unit)) return [];
    throw new Error(`could not list ${unit}.scope's processes: ${e?.message ?? e}`);
  }
  return pids.map((pid) => ({ pid, command: processCommand(pid) }));
}

/**
 * Stop scope `unit`: SIGTERM to what is left, SIGKILL after the stop timeout.
 * `{ ok: true }` once the scope is no longer active; otherwise `{ ok: false,
 * output }` with why. A scope whose last process exited between the listing
 * and the stop is gone, and `systemctl stop` fails with "not loaded": that is
 * a success, not a reason to escalate. A check after the stop that cannot
 * answer is a failure, whatever the stop returned.
 *
 * @returns {{ ok: boolean, output?: string }}
 */
export function stopScope(unit) {
  const r = systemctl(['stop', `${unit}.scope`], 60_000);
  const stopFailed = r.error || r.status !== 0;
  let active;
  try {
    active = scopeActive(unit);
  } catch (e) {
    return { ok: false, output: stopFailed ? `${failureText(r)}; ${e.message}` : e.message };
  }
  if (!active) return { ok: true };
  return { ok: false, output: stopFailed ? failureText(r) : `${unit}.scope is still active after the stop` };
}

/**
 * The scopes of `unitId` whose bl is no longer running: leftovers of a bl that
 * crashed or was killed before it could stop them. The run's lock means no
 * live bl other than this one owns a scope of the unit. Each scope's name
 * holds the pid of the bl that started it (`scopeUnitName`). Throws when
 * systemctl cannot list them: an unknown list is not an empty one.
 *
 * @returns {string[]}
 */
export function staleScopes(unitId) {
  const prefix = `bl-${unitSlug(unitId)}-`;
  const r = systemctl(['show', '-p', 'Id', '--value', `${prefix}*.scope`]);
  if (r.error || r.status !== 0) throw new Error(`could not list ${prefix}*.scope: ${failureText(r)}`);
  const re = /^(\d+)-\d+\.scope$/;
  const out = [];
  for (const line of String(r.stdout ?? '').split('\n')) {
    const name = line.trim();
    if (!name.startsWith(prefix)) continue;
    const m = re.exec(name.slice(prefix.length));
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid && !isPidAlive(pid)) out.push(name.slice(0, -'.scope'.length));
  }
  return out;
}
