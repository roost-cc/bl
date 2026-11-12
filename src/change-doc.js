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
 *   status: open             # open | merged | dropped
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
 * they are the plan's gate and budget, written before any branch exists. The
 * review state is the unit's transition log's (`reviewOf` in transition.js,
 * F-69 D5): before F-69 the document held it as `review_round` and
 * `review_status` (`REVIEW_FIELDS`), which bl reads only for a unit with no
 * log.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { FrontmatterError, listMembers, parseFrontmatter, serializeFrontmatter, warn } from './config.js';
import { extractSection, replaceSection } from './feature.js';
import { atomicWriteFile } from './atomic-write.js';
import { commitPaths } from './backlog-commit.js';
import { substituteVars, templatePath } from './template.js';
import { FlowError } from './flow.js';
import { transition } from './transition.js';

export const CHANGE_FILE = 'change.md';

/**
 * A change document's statuses (F-69 A3): the change, like a pull request, is
 * `open`, `merged` or `dropped` (closed without a merge). They are not a work
 * unit's statuses, which are `flow.json`'s.
 */
export const CHANGE_STATUSES = new Set(['open', 'merged', 'dropped']);

/** The change-document words before F-69 (A3), each with the word it reads as. */
export const LEGACY_CHANGE_STATUSES = { closed: 'dropped' };

/**
 * A change document's status: `open` when unset, and an old word
 * (`LEGACY_CHANGE_STATUSES`) read as its current one.
 * @param {object} fm  the document's frontmatter
 * @returns {string}
 */
export function changeStatus(fm) {
  const status = fm.status || 'open';
  return Object.hasOwn(LEGACY_CHANGE_STATUSES, status) ? LEGACY_CHANGE_STATUSES[status] : status;
}

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
 * highest-numbered one, else null. `{ n, path, doc }`. `read` parses one
 * document (`readChange`; the graph passes one that reuses the text it read).
 */
export function currentChange(unitDir, read = readChange) {
  const all = listChanges(unitDir);
  const docs = all.map((c) => ({ ...c, doc: read(c.path) }));
  for (let i = docs.length - 1; i >= 0; i--) {
    if (isOpenChange(docs[i].doc)) return docs[i];
  }
  return docs.at(-1) ?? null;
}

/** Whether a document (`readChange`; null for none) is an open change. */
export const isOpenChange = (doc) => doc != null && changeStatus(doc.fm) === 'open';

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
 * The review fields a change document held before F-69 (D5). bl no longer
 * writes them: it reads them only for a unit with no transition log
 * (`legacyLog`), `bl validate` reports them as a warning, and the migration
 * removes them.
 */
export const REVIEW_FIELDS = ['review_round', 'review_status'];

/**
 * Apply the outcome of an interactive fix session (`bl implement` on a unit
 * in `fixing`, F-68 D3): with `fixed: true`, record `in_review` by `fix` in
 * the unit's log (F-69 D3), the summary as its outcome, and commit the unit
 * file; otherwise, or when the log refuses the entry (a `FlowError`: the
 * unit moved during the session), the unit stays where it is, and bl prints
 * why. Any other error throws. `change` is
 * the unit's change document as the session found it, which places a unit
 * with no log (D4). Returns whether the fix was recorded.
 * @param {string} backlogRoot
 * @param {{ id: string, kind: "story" | "feature", indexPath: string }} unit
 * @param {{ structured: object|null, structuredError: string|null }} outcome
 * @param {{ fm: object } | null} [change]
 * @returns {Promise<boolean>}
 */
export async function applyFixOutcome(
  backlogRoot,
  { id, kind, indexPath },
  { structured, structuredError },
  change = null,
) {
  const fixed = Boolean(structured?.fixed);
  if (!structured) {
    warn(`no fix outcome (${structuredError}); ${id} stays in fixing`);
  } else if (!fixed) {
    warn(`${id}: ${structured.open} review item(s) still open; ${id} stays in fixing: ${structured.summary}`);
  }
  if (!fixed) return false;
  const opts = { by: 'fix', via: 'fix', outcome: structured.summary };
  try {
    if (!(await transition(backlogRoot, { kind, indexPath, change }, 'in_review', opts))) return false;
  } catch (e) {
    // The unit moved during the session (`NoEdgeError`), or its log is malformed.
    if (!(e instanceof FlowError)) throw e;
    warn(`${id}: the fix is not recorded in the transition log: ${e.message}`);
    return false;
  }
  await commitChangeDoc(backlogRoot, indexPath, `chore: ${id} review fixed`);
  return true;
}

/**
 * Commit the change document at `path` (or the files at `path`, a list) in
 * the backlog, skipped when the backlog is not a git repository; a failed
 * commit is a warning.
 */
async function commitChangeDoc(backlogRoot, path, message) {
  if (!existsSync(join(backlogRoot, '.git'))) return;
  const rels = [path].flat().map((p) => relative(backlogRoot, p));
  const c = await commitPaths(backlogRoot, rels, message);
  if (!c.committed) warn(`${rels.join(', ')} is written but not committed (${c.error ?? 'nothing to commit'})`);
}

/**
 * A new document from `templates/change.md`: `status: open`, one
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
 * no open document (none yet, or the last one merged or dropped) the next
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
  if (cur && isOpenChange(cur.doc)) {
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
export async function openUnitChange(backlogRoot, { id, title, indexPath }, branch, repoNames) {
  const names = repoNames.filter((r, i) => r && repoNames.indexOf(r) === i);
  const res = ensureChange(backlogRoot, dirname(indexPath), {
    changeOf: id,
    title,
    repos: names.map((repo) => ({ repo, branch })),
  });
  if (res.changed) {
    await commitChangeDoc(
      backlogRoot,
      res.path,
      `chore: ${id} change ${res.created ? 'opened' : 'updated'} on ${branch}`,
    );
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
 * One `## Gate` line, the shape every gate writer uses:
 * `- <date> · <repo> · <command> · <verdict>[ (<detail>)][ · commit <sha>]`.
 * `command` is written as given (a code span, or a placeholder such as
 * `(no test plugin)`); `detail` is, for example, `attempt 2`; `commit` is the
 * commit the gate ran on, when it ran on one (F-96 D3).
 * @param {{ date: string, repo: string, command: string, verdict: string,
 *   detail?: string, commit?: string }} p
 * @returns {string}
 */
export function gateLine({ date, repo, command, verdict, detail = '', commit = '' }) {
  return `- ${date} · ${repo} · ${command} · ${verdict}${detail ? ` (${detail})` : ''}${commit ? ` · commit ${commit}` : ''}`;
}

/**
 * Add `line` to `## Gate` in the unit's current change document and commit
 * it, as `message`. Returns the path written, or null when the unit has no
 * change document. A failed commit is a warning.
 * @param {string} backlogRoot
 * @param {string | null} unitDir
 * @param {string} line
 * @param {string} message
 * @returns {Promise<{ path: string } | null>}
 */
export async function addGateLine(backlogRoot, unitDir, line, message) {
  const cur = currentChange(unitDir);
  if (!cur?.doc) return null;
  cur.doc.body = appendSection(cur.doc.body, 'Gate', line);
  writeChange(backlogRoot, cur.path, cur.doc);
  await commitChangeDoc(backlogRoot, cur.path, message);
  return { path: cur.path };
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
 * The verb that moves an open change on: `merge` once its unit is
 * `ready_for_merge` (F-69 D5), else `run` (`bl review`'s summary line, `bl
 * inbox`'s change items). `status` is the unit's, with its review position
 * (`statusOf` with its change document). `reviewEnd` refines it by the session counts:
 * `ready_for_merge` with an open Must fix/Should fix box gives `bl review`,
 * not `bl merge`.
 */
export function changeNextVerb(status) {
  return status === 'ready_for_merge' ? 'merge' : 'run';
}

/**
 * What the rest of bl reads off a unit's current change: `repo`'s branch, PR
 * and URL (a story passes its one repo; a feature none, so its first
 * `repos:` entry, the lead repo's, F-52 D3), and the body the Review Log
 * lives in. Every field is empty when the unit has no change
 * document. `read` as for `currentChange`.
 */
export function unitChange(unitDir, repo = '', read = readChange) {
  const cur = currentChange(unitDir, read);
  const doc = cur?.doc ?? null;
  const primary = (repo && doc?.repos.find((r) => r.repo === repo)) || doc?.repos[0] || {};
  return {
    changePath: cur?.path ?? null,
    changeNum: cur?.n ?? 0,
    change: doc,
    branch: primary.branch ?? '',
    pr: primary.pr ?? '',
    prUrl: primary.url ?? '',
    changeBody: doc?.body ?? '',
  };
}
