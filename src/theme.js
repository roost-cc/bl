/**
 * theme.js — the value axis above features: themes and epics (F-51 D1).
 *
 * A theme is a value area that never finishes, in `themes/<slug>/index.md`;
 * its `repos:` place standalone stories (a chore, a bug, an update) whose
 * component's repo it lists. An epic is an outcome under one theme that
 * finishes, in `epics/E<nn>-<slug>/index.md`, numbered from E50 (E00–E49
 * were components, F-49 D2). A feature names its `theme:` and, optionally,
 * its `epic:`; a story reaches both through its feature.
 *
 * A theme's `brief:` lists the documents an agent reads before working in it
 * (F-53 D4), each a path relative to the backlog's parent directory with an optional
 * `#anchor`; the feature refine and run prompts list it. Its `## State` is a
 * hand-readable log that `bl merge F-<n>` appends to and `bl sync` leaves
 * alone.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { atomicWriteFile } from './atomic-write.js';
import { join, relative } from 'path';
import { frontmatterSkipped, listMembers, parseFrontmatterOf, warn, THEMES_DIR, EPICS_DIR } from './config.js';
import { appendSectionLine } from './feature.js';

/** A theme id: a lowercase slug. */
export const THEME_ID_RE = /^[a-z][a-z0-9-]*$/;

/** The first epic number; lower `E<n>` ids were components (F-49 D2). */
export const FIRST_EPIC_NUM = 50;

/** An epic's statuses, derived by `bl sync`: done once every feature is. */
export const EPIC_STATUSES = ['open', 'done'];

export function themesRoot(config) {
  return join(config.backlogRoot, THEMES_DIR);
}

export function epicsRoot(config) {
  return join(config.backlogRoot, EPICS_DIR);
}

/**
 * Normalise an epic ID like "E50", "E-50", "e-050" to `E50`. An id below
 * E50 is an old component's, not an epic's, so it is null.
 * @returns {{ num: string, id: string, dirPrefix: string } | null}
 */
export function normalizeEpicId(raw) {
  const m = String(raw ?? '')
    .trim()
    .match(/^[Ee]-?(\d+)$/);
  if (!m) return null;
  const num = m[1].replace(/^0+/, '') || '0';
  if (num.length < 3 && Number(num) < FIRST_EPIC_NUM) return null;
  return { num, id: `E${num}`, dirPrefix: `E${num}` };
}

/**
 * A parsed list of names (`repos: [a, b]`, F-62 D2) as its string members, or
 * null when the value is not a sequence: `repos: []` is an empty list, an
 * absent or empty `repos:` is no list. A scalar, a mapping or a member that
 * is not a string throws `FrontmatterListError`, which `bl validate`
 * reports as `frontmatter-list`.
 * @returns {string[] | null}
 */
export function parseNameList(raw) {
  if (raw == null || raw === '') return null;
  return listMembers(raw)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A `brief:` list as `parseNameList` reads one, its members trimmed but none
 * dropped: a blank member is `bl validate`'s `theme-brief`.
 * @returns {string[] | null}
 */
function parseBriefList(raw) {
  if (raw == null || raw === '') return null;
  return listMembers(raw).map((s) => s.trim());
}

// parseFrontmatter matches LF fences only; a CRLF file is still a unit.
function readFm(indexPath) {
  return parseFrontmatterOf(readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n'), indexPath).fm;
}

/** Directories directly under `root` whose name passes `test`, each with an index.md. */
function unitDirs(root, test) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root).sort()) {
    if (!test(entry)) continue;
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const indexPath = join(dir, 'index.md');
    if (!existsSync(indexPath)) continue;
    out.push({ entry, dir, indexPath });
  }
  return out;
}

/**
 * Every theme under `themes/`. A theme's id is its directory name; a
 * `theme_id:` that differs is `bl validate`'s `id-dir-mismatch`.
 * `brief` is null when the theme has no `brief:` list.
 * @returns {Array<{ id: string, title: string, repos: string[] | null,
 *   brief: string[] | null, themeEntry: string, themeDir: string,
 *   indexPath: string, relPath: string, fm: object }>}
 */
export function readAllThemes(config) {
  const dirs = unitDirs(themesRoot(config), (e) => THEME_ID_RE.test(e));
  return dirs
    .filter((d) => !frontmatterSkipped(config, d.indexPath))
    .map(({ entry, dir, indexPath }) => {
      const fm = readFm(indexPath);
      return {
        id: entry,
        title: fm.title ?? '',
        repos: parseNameList(fm.repos),
        brief: parseBriefList(fm.brief),
        themeEntry: entry,
        themeDir: dir,
        indexPath,
        relPath: relative(config.backlogRoot, indexPath),
        fm,
      };
    });
}

/**
 * Every epic under `epics/`. Its id is its directory's `E<nn>`; its
 * `features:` and `status:` are what `bl sync` last derived.
 * @returns {Array<{ id: string, title: string, theme: string, status: string,
 *   features: string[], epicEntry: string, epicDir: string,
 *   indexPath: string, relPath: string, fm: object }>}
 */
export function readAllEpics(config) {
  const dirs = unitDirs(epicsRoot(config), (e) => /^E\d+/.test(e));
  return dirs
    .filter((d) => !frontmatterSkipped(config, d.indexPath))
    .map(({ entry, dir, indexPath }) => {
      const fm = readFm(indexPath);
      return {
        id: `E${entry.match(/^E(\d+)/)[1]}`,
        title: fm.title ?? '',
        theme: String(fm.theme ?? '').trim(),
        status: fm.status ?? 'open',
        features: parseNameList(fm.features) ?? [],
        epicEntry: entry,
        epicDir: dir,
        indexPath,
        relPath: relative(config.backlogRoot, indexPath),
        fm,
      };
    });
}

/** The theme with id `slug`, or null. */
export function findTheme(slug, config) {
  const id = String(slug ?? '').trim();
  if (!THEME_ID_RE.test(id)) return null;
  return readAllThemes(config).find((t) => t.id === id) ?? null;
}

/**
 * The epic `parsed` names (`normalizeEpicId`), or null. When two
 * directories claim the id, the first wins.
 */
export function findEpic(parsed, config) {
  if (!parsed) return null;
  return (
    readAllEpics(config).find(
      (e) => e.epicEntry === parsed.dirPrefix || e.epicEntry.startsWith(`${parsed.dirPrefix}-`),
    ) ?? null
  );
}

/**
 * The next epic number: one past the highest `E<nn>` directory under
 * `epics/`, and never below E50. A BigInt, so a number past 2^53 does not
 * round onto an existing epic.
 * @returns {bigint}
 */
export function findNextEpicNum(config) {
  let max = BigInt(FIRST_EPIC_NUM - 1);
  for (const { entry } of unitDirs(epicsRoot(config), (e) => /^E\d+/.test(e))) {
    const n = BigInt(entry.match(/^E(\d+)/)[1]);
    if (n > max) max = n;
  }
  return max + 1n;
}

/**
 * A `brief:` entry split at its first `#`: `file`, relative to the
 * backlog's parent directory, and `anchor` (empty when there is none).
 * @returns {{ file: string, anchor: string }}
 */
export function splitBriefEntry(entry) {
  const text = String(entry ?? '').trim();
  const i = text.indexOf('#');
  return i < 0 ? { file: text, anchor: '' } : { file: text.slice(0, i), anchor: text.slice(i + 1) };
}

/**
 * The `{{themeBrief}}` of a feature's refine and run prompts (F-53 D4): one
 * `- <roostDir>/<file>` line per `brief:` entry of theme `themeId`, with its
 * anchor, or a one-line note when there is none to list.
 */
export function themeBriefList(config, themeId) {
  const id = String(themeId ?? '').trim();
  if (!id) return '(none: the feature names no theme)';
  let theme;
  try {
    theme = findTheme(id, config);
  } catch (e) {
    return `(none: theme \`${id}\` could not be read: ${e.message})`;
  }
  if (!theme) return `(none: theme \`${id}\` has no themes/${id}/index.md)`;
  // A blank entry is reported by `bl validate`, not listed.
  const brief = (theme.brief ?? []).filter(Boolean);
  if (!brief.length) return `(none: theme \`${id}\` lists no brief)`;
  return brief
    .map((entry) => {
      const { file, anchor } = splitBriefEntry(entry);
      return `- \`${join(config.roostDir, file)}\`${anchor ? `, section \`#${anchor}\`` : ''}`;
    })
    .join('\n');
}

/**
 * `bl merge F-<n>` (F-53 D4): append `- <date>: F-<n> done (<title>).` to
 * the `## State` of the feature's theme, created at the end when absent,
 * replacing the file atomically with its frontmatter byte for byte, so a
 * failed write leaves it as it was. The caller
 * holds the merge's mark-done backlog lock. A feature with no theme, or a
 * theme that cannot be read, is a warning, never a failed merge: the repos
 * are merged by then.
 * @param {object} config
 * @param {{ id: string, title: string, theme?: string }} feature
 * @param {string} stamp  the merge date, `YYYY-MM-DD`
 * @returns {string | null} the theme file's backlog-relative path when written
 */
export function recordThemeState(config, feature, stamp) {
  const id = String(feature.theme ?? '').trim();
  let theme;
  try {
    theme = id ? findTheme(id, config) : null;
  } catch (e) {
    warn(`theme ${id}'s ## State not updated for ${feature.id}: ${e.message}`);
    return null;
  }
  if (!theme) {
    warn(
      `${feature.id} names ${id ? `theme "${id}", which has no themes/${id}/index.md` : 'no theme'}, so no ## State records it`,
    );
    return null;
  }
  try {
    const content = readFileSync(theme.indexPath, 'utf8').replace(/\r\n/g, '\n');
    const { body } = parseFrontmatterOf(content, theme.indexPath);
    const fmText = content.slice(0, content.length - body.length);
    const next = fmText + appendSectionLine(body, 'State', `- ${stamp}: ${feature.id} done (${feature.title}).`);
    if (next === content) return null;
    atomicWriteFile(config.backlogRoot, theme.indexPath, next);
  } catch (e) {
    warn(`theme ${id}'s ## State not updated for ${feature.id}: ${e.message}`);
    return null;
  }
  return theme.relPath;
}

/**
 * The themes a story belongs to (F-51 D1): its feature's theme, else, for a
 * story with no feature, every theme whose `repos` lists its component's
 * repo.
 * @param {{ feature?: string, componentRepo?: string }} story
 * @param {Map<string, { theme?: string }>} featuresById  feature id → `{ theme }`
 * @param {Array<{ id: string, repos: string[] | null }>} themes
 * @returns {string[]}
 */
export function themesOfStory(story, featuresById, themes) {
  if (story.feature) {
    const theme = featuresById.get(story.feature)?.theme;
    return theme ? [theme] : [];
  }
  if (!story.componentRepo) return [];
  return themes.filter((t) => (t.repos ?? []).includes(story.componentRepo)).map((t) => t.id);
}
