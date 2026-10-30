/**
 * change-doc.js — the change document (F-42 Design D5).
 *
 * A unit's change is recorded in `change.md` next to its `index.md`:
 * `index.md` is the plan, `change.md` grows until the change is merged.
 * `bl run` and `bl implement` create it with the branch; a unit that never
 * ran has none. The frontmatter holds what the plan used to carry as run
 * state:
 *
 *   ---
 *   change_of: F-42          # the unit; must match the directory
 *   status: open             # open | merged | closed
 *   review_round: 0
 *   review_status:           # pending | fixed | addressed
 *   repos:
 *     - repo: bl
 *       branch: f42-…
 *       pr: 123              # empty without a forge
 *       url: https://…/pull/123
 *       merged:              # merge commit on main, written by bl merge
 *   ---
 *
 * The body has four sections, in this order: `## Description` (written by
 * `bl run`; the PR body), `## Gate` (one line per gate run), `## Review Log`
 * (session blocks, newest first, written by the review prompts) and
 * `## Merge` (written by `bl merge`). A unit that needs a second change gets
 * `change-2.md`; bl works on the highest-numbered open one.
 *
 * `approved`, `review_rounds_max` and the `tokens_*` fields (`tokens_by_step`
 * among them) stay on the spec:
 * they are the plan's gate and budget, written before any branch exists.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { FrontmatterError, listMembers, parseFrontmatter, serializeFrontmatter, warn } from './config.js';
import { extractSection, replaceSection } from './feature.js';
import { atomicWriteFile } from './atomic-write.js';
import { commitPaths } from './backlog-commit.js';
import { substituteVars, templatePath } from './template.js';

export const CHANGE_FILE = 'change.md';

export const CHANGE_STATUSES = new Set(['open', 'merged', 'closed']);

/** The body sections, in the order a document holds them. */
export const CHANGE_SECTIONS = ['Description', 'Gate', 'Review Log', 'Merge'];

/** The spec keys the change document took over; no `index.md` may carry one. */
export const RUN_STATE_KEYS = ['branch', 'pr', 'review_round', 'review_status'];

/** Every `repos:` entry is written with these keys, in this order. */
const REPO_FIELDS = ['repo', 'branch', 'pr', 'url', 'merged'];

/** `change.md` for the first change of a unit, `change-<n>.md` for the n-th. */
export function changePath(unitDir, n = 1) {
  return join(unitDir, n > 1 ? `change-${n}.md` : CHANGE_FILE);
}

/** Every change document of a unit, `[{ n, path }]`, lowest number first. */
export function listChanges(unitDir) {
  let names;
  try {
    names = readdirSync(unitDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = name.match(/^change(?:-([2-9]|[1-9]\d+))?\.md$/);
    if (m) out.push({ n: m[1] ? parseInt(m[1], 10) : 1, path: join(unitDir, name) });
  }
  return out.sort((a, b) => a.n - b.n);
}

/**
 * The change document bl works on: the highest-numbered open one, else the
 * highest-numbered one, else null. `{ n, path, doc }`.
 */
export function currentChange(unitDir) {
  const all = listChanges(unitDir);
  const read = all.map((c) => ({ ...c, doc: readChange(c.path) }));
  for (let i = read.length - 1; i >= 0; i--) {
    if (isOpen(read[i].doc)) return read[i];
  }
  return read.at(-1) ?? null;
}

const isOpen = (doc) => doc != null && (doc.fm.status || 'open') === 'open';

/**
 * The unit id a change directory belongs to: `F-42` for `F42-…`, `S-890` for
 * `S890-…`, null for anything else.
 */
export function unitIdOfDir(unitDir) {
  const m = basename(unitDir).match(/^([FS])(\d+)(?:-|$)/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * The name a change goes by outside the backlog (the feature tag, the release
 * manifest): `F-42` for the first change, `F-42.2` for the second.
 */
export function changeName(unitId, n = 1) {
  return n > 1 ? `${unitId}.${n}` : unitId;
}

/**
 * Parse a change document. `fm` holds the other keys, `repos` the entries of
 * its `repos:` sequence (`fm.repos`; `{ repo, branch, pr, url, merged }`, all
 * strings), `body` everything after the frontmatter with LF line ends, and
 * `eol` the line end the text was written with, so a CRLF document is written
 * back as CRLF. A `repos:` that is not a list of mappings throws
 * `FrontmatterListError`.
 */
export function parseChange(text) {
  const raw = String(text ?? '');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const { fm, body } = parseFrontmatter(raw.replace(/\r\n/g, '\n'));
  const repos = listMembers(fm.repos, 'repos', { member: 'a mapping' });
  delete fm.repos;
  return { fm, repos, body, eol };
}

/**
 * A parsed document back to text through `serializeFrontmatter`, `repos:`
 * last in the frontmatter and each entry's keys in `REPO_FIELDS` order.
 */
export function serializeChange({ fm, repos = [], body = '', eol = '\n' }) {
  const entries = repos.map((r) => {
    const keys = [...REPO_FIELDS, ...Object.keys(r).filter((k) => !REPO_FIELDS.includes(k))];
    return Object.fromEntries(keys.map((k) => [k, r[k] ?? '']));
  });
  const { repos: _, ...rest } = fm;
  const text = serializeFrontmatter({ ...rest, repos: entries }) + body;
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

/**
 * The parsed document at `path`, or null when there is none. A
 * `FrontmatterError` names the file.
 */
export function readChange(path) {
  if (!existsSync(path)) return null;
  try {
    return parseChange(readFileSync(path, 'utf8'));
  } catch (e) {
    throw e instanceof FrontmatterError ? e.withFile(path) : e;
  }
}

/** Write `doc` to `path` atomically, staging under the backlog's `.bl/tmp/`. */
export function writeChange(backlogRoot, path, doc) {
  atomicWriteFile(backlogRoot, path, serializeChange(doc));
}

/** Read, change through `mutate(doc)`, and write back. Returns the document. */
export function updateChange(backlogRoot, path, mutate) {
  const doc = readChange(path);
  if (!doc) throw new Error(`no change document at ${path}`);
  mutate(doc);
  writeChange(backlogRoot, path, doc);
  return doc;
}

/**
 * A new document from `templates/change.md`: `status: open`, round 0, one
 * `repos:` entry per `{ repo, branch }`. `change_of:` is set on the parsed
 * frontmatter (F-62 D3); `{{changeOf}}` and `{{title}}` are filled in the body.
 */
export function newChange({ changeOf, title = '', repos = [] }) {
  const doc = parseChange(readFileSync(templatePath('change'), 'utf8'));
  doc.fm.change_of = changeOf;
  doc.body = substituteVars(doc.body, { changeOf, title });
  doc.repos = [];
  for (const r of repos) setRepo(doc, r.repo, { branch: r.branch ?? '' });
  return doc;
}

/** The `repos:` entry for `repo`, created when missing, with `fields` set. */
export function setRepo(doc, repo, fields = {}) {
  let entry = doc.repos.find((r) => r.repo === repo);
  if (!entry) {
    entry = { repo, branch: '', pr: '', url: '', merged: '' };
    doc.repos.push(entry);
  }
  for (const [k, v] of Object.entries(fields)) entry[k] = v == null ? '' : String(v);
  return entry;
}

/**
 * Make sure the unit has an open change document naming every repo in
 * `repos` (`[{ repo, branch }]`). The current open document gains the
 * entries it lacks, and an entry without a branch gets the one given; with
 * no open document (none yet, or the last one merged or closed) the next
 * number is created. The entries take the order of `repos`, so a resumed
 * document's first entry is the lead repo of the order derived now (F-52
 * D3); an entry `repos` does not name keeps its place after them. Writes
 * only when something changed.
 *
 * @returns {{ path: string, doc: object, created: boolean, changed: boolean }}
 */
export function ensureChange(backlogRoot, unitDir, { changeOf, title = '', repos = [] }) {
  const cur = currentChange(unitDir);
  let path;
  let doc;
  let created = false;
  if (cur && isOpen(cur.doc)) {
    ({ path, doc } = cur);
  } else {
    path = changePath(unitDir, cur ? cur.n + 1 : 1);
    doc = newChange({ changeOf, title });
    created = true;
  }
  let changed = created;
  for (const r of repos) {
    const entry = doc.repos.find((e) => e.repo === r.repo);
    if (!entry) {
      setRepo(doc, r.repo, { branch: r.branch ?? '' });
      changed = true;
    } else if (!entry.branch && r.branch) {
      entry.branch = r.branch;
      changed = true;
    }
  }
  const names = repos.map((r) => r.repo);
  const rank = (e) => (names.includes(e.repo) ? names.indexOf(e.repo) : names.length);
  const ordered = doc.repos
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map(({ e }) => e);
  if (ordered.some((e, i) => e !== doc.repos[i])) {
    doc.repos = ordered;
    changed = true;
  }
  if (changed) writeChange(backlogRoot, path, doc);
  return { path, doc, created, changed };
}

/**
 * `ensureChange` for a unit whose branch is being created (`bl run`,
 * `bl implement`): one entry per repo in `repoNames`, on `branch`, and a
 * backlog commit of the document when it changed (skipped when the backlog
 * is not a git repository; a failed commit is a warning).
 */
export function openUnitChange(backlogRoot, { id, title, indexPath }, branch, repoNames) {
  const names = repoNames.filter((r, i) => r && repoNames.indexOf(r) === i);
  const res = ensureChange(backlogRoot, dirname(indexPath), {
    changeOf: id,
    title,
    repos: names.map((repo) => ({ repo, branch })),
  });
  if (res.changed && existsSync(join(backlogRoot, '.git'))) {
    const rel = relative(backlogRoot, res.path);
    const c = commitPaths(backlogRoot, [rel], `chore: ${id} change ${res.created ? 'opened' : 'updated'} on ${branch}`);
    if (!c.committed) warn(`${rel} is written but not committed (${c.error ?? 'nothing to commit'})`);
  }
  return res;
}

/**
 * Record a merge in the unit's current change document: each repo's
 * `merged:` commit (`commits` is `{ <repo>: <sha> }`), one `## Merge` line per
 * repo then the `extra` lines, and `status: merged`. Returns the path
 * written, or null when the unit has no change document.
 */
export function recordMerge(backlogRoot, unitDir, { commits, date, extra = [] }) {
  const cur = currentChange(unitDir);
  if (!cur?.doc) return null;
  const { doc } = cur;
  const lines = [];
  for (const [repo, sha] of Object.entries(commits)) {
    setRepo(doc, repo, { merged: sha });
    lines.push(`- ${date} · ${repo} · merged ${sha}`);
  }
  lines.push(...extra);
  doc.fm.status = 'merged';
  if (lines.length > 0) doc.body = appendSection(doc.body, 'Merge', lines.join('\n'));
  writeChange(backlogRoot, cur.path, doc);
  return cur.path;
}

/**
 * Add `text` to the `## <name>` section of a change body, creating the
 * section in its place among `CHANGE_SECTIONS` when it is missing. Gate and
 * Merge lines go at the end of their list; a Review Log session goes first
 * (newest first); a Description paragraph goes at the end.
 */
export function appendSection(body, name, text) {
  const block = String(text ?? '').replace(/\s+$/, '');
  const existing = extractSection(body, name);
  if (existing != null) {
    const kept = existing.trim();
    let merged = block;
    if (kept && name === 'Review Log') merged = `${block}\n\n${kept}`;
    else if (kept && name === 'Description') merged = `${kept}\n\n${block}`;
    else if (kept) merged = `${kept}\n${block}`;
    return replaceSection(body, name, merged);
  }
  const later = CHANGE_SECTIONS.slice(CHANGE_SECTIONS.indexOf(name) + 1);
  for (const next of later) {
    const m = body.match(new RegExp(`^##[ \\t]+${next}[ \\t]*\\r?\\n`, 'm'));
    if (m) return `${body.slice(0, m.index)}## ${name}\n\n${block}\n\n${body.slice(m.index)}`;
  }
  const head = body.replace(/\s+$/, '');
  return `${head}${head ? '\n\n' : ''}## ${name}\n\n${block}\n`;
}

/**
 * The verb that moves an open change on: `merge` once its review is
 * `addressed`, else `run` (`bl review`'s summary line, `bl inbox`'s change
 * items).
 */
export function changeNextVerb(reviewStatus) {
  return reviewStatus === 'addressed' ? 'merge' : 'run';
}

/**
 * What the rest of bl reads off a unit's current change: `repo`'s branch, PR
 * and URL (a story passes its one repo; a feature none, so its first
 * `repos:` entry, the lead repo's, F-52 D3), the review state, and the body
 * the Review Log lives in. Every field is empty when the unit has no change
 * document.
 */
export function unitChange(unitDir, repo = '') {
  const cur = currentChange(unitDir);
  const doc = cur?.doc ?? null;
  const primary = (repo && doc?.repos.find((r) => r.repo === repo)) || doc?.repos[0] || {};
  return {
    changePath: cur?.path ?? null,
    changeNum: cur?.n ?? 0,
    change: doc,
    branch: primary.branch ?? '',
    pr: primary.pr ?? '',
    prUrl: primary.url ?? '',
    reviewStatus: doc?.fm.review_status ?? '',
    reviewRoundRaw: doc?.fm.review_round ?? '',
    changeBody: doc?.body ?? '',
  };
}
