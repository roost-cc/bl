/**
 * release.js — what `bl merge F-n` leaves once every repo is pushed (F-42
 * Design D5): an annotated tag on each touched repo's merge commit, and a
 * release manifest in the backlog.
 *
 * Repos may be out of step on `main` for a while; what must never happen is
 * promoting an out-of-step set to production. So production is promoted only
 * from an immutable, named set of commits made at merge time:
 *
 * - the tag (`F-42`, `F-42.2` for a second change) is created on every
 *   touched repo first and pushed last, and a failed push takes back the
 *   tags this run made, local and remote. A tag is a pointer for finding a
 *   feature's commits from git alone, not a completion signal: a remote may
 *   refuse the take-back, and the error then names the tags left, which a
 *   re-run completes. The manifest is the release;
 * - `releases/F-42.json` records the `main` commit of every repo whose
 *   `backlog.json` `repos` entry sets `deployable: true`, touched or not.
 *   That is configuration (tenet 6): every entry must set `deployable`
 *   (`loadConfig` refuses one that does not), never a default.
 *
 * A story merged alone gets neither.
 */

import { spawnSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from './atomic-write.js';

export const RELEASES_DIR = 'releases';

/** `git <args>` in `cwd`: `{ status, stdout, stderr }`, status 127 when git could not start. */
export function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: r.error ? 127 : (r.status ?? 1),
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? r.error?.message ?? ''),
  };
}

/**
 * The repos a release manifest records: the names of the `backlog.json`
 * `repos` entries with `deployable: true`, in `repos` order (F-51 D4).
 */
export function deployableRepos(config) {
  return Object.values(config.repos ?? {})
    .filter((r) => r.deployable === true)
    .map((r) => r.name);
}

/**
 * Tag each `{ repoName, repoPath, commit }` with an annotated `tag`, then
 * push every tag. A tag that already names the same commit is kept (a
 * re-run); one that names another commit stops before anything is pushed.
 * Any failure takes back what this run published: the remote tags it pushed
 * where the remote had none, and the local tags it made. A tag, remote or
 * local, is deleted only while it is still the tag object this run made, so
 * one another caller published or replaced meanwhile stays. A rollback step
 * that fails is named in `error`.
 *
 * @returns {{ ok: boolean, error?: string, tagged: string[] }}
 */
export function tagRepos(repos, tag, message, run = git) {
  const lines = message.split('\n');
  const msgArgs = ['-m', lines[0], ...(lines.length > 1 ? ['-m', lines.slice(1).join('\n').trim()] : [])];
  const tagged = [];
  const made = new Map();
  const pushed = [];
  const fail = (error) => {
    const left = [];
    for (const r of pushed) {
      const d = run(r.repoPath, [
        'push',
        `--force-with-lease=refs/tags/${tag}:${r.object}`,
        'origin',
        `:refs/tags/${tag}`,
      ]);
      if (d.status !== 0) left.push(`${r.repoName} remote (${d.stderr.trim()})`);
    }
    for (const r of repos.filter((x) => tagged.includes(x.repoName))) {
      const d = run(r.repoPath, ['update-ref', '-d', `refs/tags/${tag}`, made.get(r.repoName)]);
      if (d.status !== 0) left.push(`${r.repoName} local (${d.stderr.trim()})`);
    }
    return {
      ok: false,
      error: left.length ? `${error}; rollback left tag ${tag} on: ${left.join(', ')}` : error,
      tagged: [],
    };
  };
  for (const r of repos) {
    const want = run(r.repoPath, ['rev-parse', '--verify', `${r.commit}^{commit}`]);
    if (want.status !== 0) return fail(`${r.repoName}: ${r.commit} is not a commit`);
    const have = run(r.repoPath, ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]);
    if (have.status === 0) {
      if (have.stdout.trim() !== want.stdout.trim()) {
        return fail(`${r.repoName}: tag ${tag} already names ${have.stdout.trim().slice(0, 12)}, not ${r.commit}`);
      }
      continue;
    }
    const t = run(r.repoPath, ['tag', '-a', tag, want.stdout.trim(), ...msgArgs]);
    if (t.status !== 0) return fail(`${r.repoName}: git tag ${tag} failed: ${t.stderr.trim()}`);
    const o = run(r.repoPath, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
    if (o.status !== 0) return fail(`${r.repoName}: tag ${tag} is gone after git tag`);
    made.set(r.repoName, o.stdout.trim());
    tagged.push(r.repoName);
  }
  // Which remotes already have the tag (an earlier run's): a rollback
  // never deletes those.
  const onRemote = new Set();
  for (const r of repos) {
    const l = run(r.repoPath, ['ls-remote', 'origin', `refs/tags/${tag}`]);
    if (l.status !== 0) return fail(`${r.repoName}: git ls-remote origin failed: ${l.stderr.trim()}`);
    if (l.stdout.trim()) onRemote.add(r.repoName);
  }
  for (const r of repos) {
    const obj = run(r.repoPath, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
    if (obj.status !== 0) return fail(`${r.repoName}: tag ${tag} is gone before its push`);
    const p = run(r.repoPath, ['push', 'origin', `refs/tags/${tag}`]);
    if (p.status !== 0) return fail(`${r.repoName}: git push of tag ${tag} failed: ${p.stderr.trim()}`);
    if (!onRemote.has(r.repoName)) pushed.push({ ...r, object: obj.stdout.trim() });
  }
  return { ok: true, tagged };
}

/**
 * The `main` commit of each named repo as the shared remote has it. The
 * local checkout is never a stand-in: a repo whose `origin` cannot be read,
 * or answers without exactly one full `refs/heads/main` line, is an error.
 *
 * @returns {{ commits: Record<string, string>, errors: string[] }}
 */
export function mainCommits(config, names, run = git) {
  const commits = {};
  const errors = [];
  for (const name of names) {
    const repoPath = config.reposByName[name];
    const remote = run(repoPath, ['ls-remote', 'origin', 'refs/heads/main']);
    const out = remote.stdout.trim();
    const m = remote.status === 0 ? /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/main$/.exec(out) : null;
    if (m) commits[name] = m[1];
    else if (remote.status !== 0)
      errors.push(`${name}: origin main unreadable (${remote.stderr.trim() || 'git ls-remote failed'})`);
    else errors.push(`${name}: origin has no single main commit (got ${JSON.stringify(out)})`);
  }
  return { commits, errors };
}

/**
 * Write `releases/<name>.json` in the backlog and return its backlog-relative
 * path.
 */
export function writeReleaseManifest(backlogRoot, { name, feature, title, date, change, repos }) {
  const rel = join(RELEASES_DIR, `${name}.json`);
  mkdirSync(join(backlogRoot, RELEASES_DIR), { recursive: true });
  const manifest = { release: name, feature, title, date, change, repos };
  atomicWriteFile(backlogRoot, join(backlogRoot, rel), `${JSON.stringify(manifest, null, 2)}\n`);
  return rel;
}
