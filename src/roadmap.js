/**
 * roadmap.js — the backlog's road map (F-53 D2, B1–B5).
 *
 * `backlog/roadmap.md` is one page: its YAML frontmatter indexes the entries,
 *
 *   entries:
 *     - title: Invite process engine
 *       added: 2026-09-28
 *       status: planned
 *
 * and its body holds the preamble and one `## <title>` section per entry.
 * The fields are informational (B4): a status is set by hand, and nothing in
 * bl derives it, gates on it or refuses because of it (B5). `bl validate`
 * checks the file's shape only, and `bl next` never reads it (B2).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { FrontmatterError, listValue, parseFrontmatterOf } from './config.js';
import { extractSection, sectionHeadings } from './feature.js';

/** The file's name, at the backlog root. */
export const ROADMAP_FILE = 'roadmap.md';

/** An entry's statuses (B4), set by hand and never checked for meaning. */
export const ROADMAP_STATUSES = ['planned', 'in_progress', 'ready', 'done'];

/** An entry's keys, each a non-empty string. */
const ENTRY_KEYS = ['title', 'added', 'status'];

export function roadmapPath(config) {
  return join(config.backlogRoot, ROADMAP_FILE);
}

/**
 * Read `roadmap.md`, or null when it is missing. `entries` is the
 * `entries:` value as parsed (`[]` when absent or empty), not checked:
 * `findRoadmapFindings` says what is wrong with it. Throws
 * `FrontmatterError` when the frontmatter is not YAML.
 * @returns {{ entries: any, fm: object, body: string, indexPath: string } | null}
 */
export function readRoadmap(config) {
  const indexPath = roadmapPath(config);
  if (!existsSync(indexPath)) return null;
  const content = readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
  const { fm, body } = parseFrontmatterOf(content, indexPath);
  return { entries: fm.entries == null || fm.entries === '' ? [] : fm.entries, fm, body, indexPath };
}

/**
 * The roadmap findings (F-53 D2). Only the shape is checked, never what a
 * status means (B4):
 *   - `roadmap-file` (error): the file is missing, its frontmatter is not
 *     YAML, `entries:` is not a list of mappings, or an entry lacks `title`,
 *     `added` or `status`, or has a status outside `ROADMAP_STATUSES`.
 *   - `roadmap-section` (error): an entry with no `## <title>` section, or a
 *     `## ` section that no entry names.
 * @param {object} config
 */
export function findRoadmapFindings(config) {
  const findings = [];
  const err = (code, message) => findings.push({ severity: 'error', code, message, location: ROADMAP_FILE });
  let roadmap;
  try {
    roadmap = readRoadmap(config);
  } catch (e) {
    if (!(e instanceof FrontmatterError)) throw e;
    err('roadmap-file', FrontmatterError.text(e.reason, e.line, e.column, null));
    return findings;
  }
  if (!roadmap) {
    err('roadmap-file', `${ROADMAP_FILE} is missing; the road map lives in its "entries:" frontmatter and sections`);
    return findings;
  }
  const list = listValue(roadmap.entries);
  if (list == null) {
    err('roadmap-file', `"entries:" is not a list`);
    return findings;
  }
  const titles = new Set();
  list.forEach((entry, i) => {
    const at = `"entries:" entry ${i + 1}`;
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      err('roadmap-file', `${at} is not a mapping with ${ENTRY_KEYS.map((k) => `"${k}"`).join(', ')}`);
      return;
    }
    const named = typeof entry.title === 'string' && entry.title.trim() ? `${at} (${entry.title.trim()})` : at;
    for (const key of ENTRY_KEYS) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') err('roadmap-file', `${named} has no "${key}"`);
    }
    const status = typeof entry.status === 'string' ? entry.status.trim() : '';
    if (status && !ROADMAP_STATUSES.includes(status)) {
      err('roadmap-file', `${named} has status "${status}", not one of ${ROADMAP_STATUSES.join(', ')}`);
    }
    if (typeof entry.title !== 'string' || !entry.title.trim()) return;
    const title = entry.title.trim();
    titles.add(title);
    if (extractSection(roadmap.body, title) == null) {
      err('roadmap-section', `${named} has no "## ${title}" section`);
    }
  });
  for (const heading of sectionHeadings(roadmap.body)) {
    if (!titles.has(heading)) err('roadmap-section', `"## ${heading}" has no entry in "entries:"`);
  }
  return findings;
}
