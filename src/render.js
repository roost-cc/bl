/**
 * render.js — the backlog's derived lists, rendered when read (F-79 D2).
 *
 * No committed file holds a derived list. Each page kind has generated
 * sections (`GENERATED_SECTIONS`), and `renderPage(graph, unit)` gives the
 * page's committed text with those sections placed in it. The sections are
 * pure functions of the graph (`loadBacklog()`, F-77):
 *
 *   root `index.md`  "Total backlog" line, Themes, Components, Priority
 *   component        Stories (open, `rankOf` order), Features (open)
 *   epic             Features
 *   theme            Epics, Features (those with no epic)
 *   feature          Stories (`orderStoriesByDeps` order), Tasks (if any)
 *   story            Tasks (if any)
 *
 * Every unit page sits two levels below the backlog root (F-49 D3), so a link
 * from one is `../../` and the target's root-relative path; a link from the
 * root is the path itself. `bl report` and `bl view` show pages through
 * `renderPage`; `bl validate` reads `GENERATED_SECTIONS`.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeComponentId, parseFrontmatter } from './config.js';
import { byRank } from './priority.js';
import { readAllTasks, tasksOf, taskTableRows } from './task.js';
import { readBlockers } from './blockers.js';

/**
 * A Markdown table, each column padded to its widest cell (at least 3).
 * @param {string[]} headers
 * @param {Array<Array<string | number>>} rows
 * @returns {string}
 */
export function formatTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length), 3));
  const pad = (s, w) => String(s ?? '').padEnd(w);
  const row = (r) => '| ' + headers.map((_, i) => pad(r[i], widths[i])).join(' | ') + ' |';
  const sep = '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |';
  return [row(headers), sep, ...rows.map(row)].join('\n');
}

// ---------------------------------------------------------------------------
// Layout: the one list of generated sections
// ---------------------------------------------------------------------------

/**
 * Each page kind's generated sections, in order, with where `upsertSection`
 * places one the committed text lacks: after `after` when the page has it,
 * else before `before` when the page has it, else at the end.
 */
const LAYOUT = {
  root: [
    { heading: 'Themes', before: 'Components' },
    { heading: 'Components', after: 'Themes' },
    { heading: 'Priority', after: 'Components' },
  ],
  component: [{ heading: 'Stories' }, { heading: 'Features', after: 'Stories' }],
  epic: [{ heading: 'Features', after: 'Outcome' }],
  theme: [
    { heading: 'Epics', after: 'Overview' },
    { heading: 'Features', after: 'Epics' },
  ],
  feature: [
    { heading: 'Stories', after: 'Acceptance' },
    { heading: 'Tasks', after: 'Stories' },
  ],
  story: [{ heading: 'Tasks', after: 'Dependencies' }],
};

/**
 * The `## ` headings each page kind renders (`root` is the backlog's
 * `index.md`). The root's "Total backlog" line is generated too
 * (`TOTAL_BACKLOG_RE`).
 * @type {Readonly<Record<"root" | "component" | "epic" | "theme" | "feature" | "story", readonly string[]>>}
 */
export const GENERATED_SECTIONS = Object.freeze(
  Object.fromEntries(Object.entries(LAYOUT).map(([kind, s]) => [kind, Object.freeze(s.map((x) => x.heading))])),
);

/** The unit kinds whose pages have generated sections (every kind but `root`). */
export const UNIT_PAGE_KINDS = Object.freeze(Object.keys(GENERATED_SECTIONS).filter((k) => k !== 'root'));

/**
 * Whether a section's body is a generated one: a Markdown table and blank
 * lines, nothing else. A hand-written section under the same heading (a
 * story's own `## Tasks` list with prose) is not, so `bl validate` and the
 * F-79 migration leave it.
 * @param {string | null} content  the section's body, as `extractSection` gives it
 */
export function isGeneratedBody(content) {
  const lines = (content ?? '').split('\n').filter((l) => l.trim() !== '');
  return lines.length > 0 && lines.every((l) => l.trimStart().startsWith('|'));
}

/** The root `index.md`'s generated "Total backlog" line. */
export const TOTAL_BACKLOG_RE = /^Total backlog: \d+ points across \d+ stories in \d+ \w+\.$/m;

// ---------------------------------------------------------------------------
// Links and cells
// ---------------------------------------------------------------------------

/** A root-relative path, linked from a unit page two levels down. */
const fromUnit = (relPath) => `../../${relPath}`;
const fromRoot = (relPath) => relPath;

/** `[<id>](<link>)` to a unit's page. */
const ref = (unit, link) => `[${unit.id}](${link(unit.relPath)})`;

/**
 * A story's component, linked, or its `component:` id bare when it names no
 * component directory (`bl validate` reports `component-unknown`), so no link
 * points at a missing file.
 */
function componentCell(story, link) {
  if (story.component) return ref(story.component, link);
  return normalizeComponentId(story.fm.component ?? '')?.id ?? '';
}

/** `<closed>/<total>` over units by their `done`. */
const doneOfTotal = (units) => `${units.filter((u) => u.done).length}/${units.length}`;

/** `<closed points>/<total points>` over a feature's stories. */
function pointsDoneOfTotal(stories) {
  const sum = (list) => list.reduce((n, s) => n + s.points, 0);
  return `${sum(stories.filter((s) => s.done))}/${sum(stories)}`;
}

/** An epic's or theme's Features table. */
function featuresTable(features) {
  return formatTable(
    ['ID', 'Title', 'Status', 'Stories', 'Points'],
    features.map((f) => [ref(f, fromUnit), f.title, f.status, doneOfTotal(f.stories), pointsDoneOfTotal(f.stories)]),
  );
}

/**
 * A feature's or story's Tasks table (F-65 D1), or null when it has no task.
 * A `blockers.json` that cannot be read is `bl validate`'s to report; the
 * table then shows no holds.
 */
function tasksTable(graph, unit) {
  if (unit.tasks.length === 0) return null;
  const own = tasksOf(unit.id, readAllTasks({ backlogRoot: graph.root, backlogGraph: graph }));
  let edges = [];
  try {
    edges = readBlockers(graph.root).edges;
  } catch {
    // Reported by bl validate (blockers-json).
  }
  const { headers, rows } = taskTableRows(own, edges, graph.flow, fromUnit);
  return formatTable(headers, rows);
}

// ---------------------------------------------------------------------------
// Sections per page kind
// ---------------------------------------------------------------------------

/**
 * One renderer per page kind (`root` is the backlog's `index.md`): its
 * generated sections as `{ <heading>: <Markdown> }`; a heading mapped to null
 * is left out of the page.
 * @type {Record<string, (graph: import("./backlog-graph.js").BacklogGraph, unit: any) => Record<string, string | null>>}
 */
export const SECTIONS = Object.freeze({
  root(graph) {
    const openFeatures = (t) => t.features.filter((f) => !f.done).length;
    const entryOf = new Map(graph.ranked.map((e) => [e.unit, e]));
    return {
      Themes: formatTable(
        ['Theme', 'Title', 'Epics', 'Open features'],
        [...graph.themes.values()].map((t) => [ref(t, fromRoot), t.title, t.epics.length, openFeatures(t)]),
      ),
      // No points: a component is a label and never finishes (F-49 D4).
      Components: formatTable(
        ['ID', 'Title', 'Repo', 'Home', 'Open', 'Done'],
        [...graph.components.values()].map((c) => {
          const open = c.stories.filter((s) => !s.done).length;
          return [ref(c, fromRoot), c.title, c.repo, c.home ? 'yes' : '', open, c.stories.length - open];
        }),
      ),
      // The open units in `priority.md`'s order (F-78 D1): ranked first, by
      // their entry's position, then the unranked tail, marked.
      Priority: formatTable(
        ['Rank', 'ID', 'Type', 'Title', 'Status', 'Points', 'Components'],
        graph.priority.map((u) => [
          entryOf.get(u)?.position ?? 'unranked',
          ref(u, fromRoot),
          u.kind === 'feature' ? 'feature' : u.type,
          u.title,
          u.status,
          u.points,
          u.kind === 'feature' ? u.components.map((c) => ref(c, fromRoot)).join(', ') : componentCell(u, fromRoot),
        ]),
      ),
    };
  },

  component(graph, c) {
    const open = c.stories.filter((s) => !s.done).sort(byRank((id) => graph.rankOf(id)));
    return {
      Stories: formatTable(
        ['ID', 'Type', 'Title', 'Points', 'Status'],
        open.map((s) => [ref(s, fromUnit), s.type, s.title, s.points, s.status]),
      ),
      Features: formatTable(
        ['ID', 'Title', 'Status', 'Stories here'],
        c.features
          .filter((f) => !f.done)
          .map((f) => [ref(f, fromUnit), f.title, f.status, f.stories.filter((s) => s.component === c).length]),
      ),
    };
  },

  epic(_graph, e) {
    return { Features: featuresTable(e.features) };
  },

  theme(_graph, t) {
    return {
      Epics: formatTable(
        ['ID', 'Title', 'Status', 'Features'],
        t.epics.map((e) => [ref(e, fromUnit), e.title, e.status, doneOfTotal(e.features)]),
      ),
      Features: featuresTable(t.features.filter((f) => !String(f.fm.epic ?? '').trim())),
    };
  },

  feature(graph, f) {
    return {
      Stories: formatTable(
        ['ID', 'Component', 'Type', 'Title', 'Points', 'Status'],
        f.stories.map((s) => [ref(s, fromUnit), componentCell(s, fromUnit), s.type, s.title, s.points, s.status]),
      ),
      Tasks: tasksTable(graph, f),
    };
  },

  story(graph, s) {
    return { Tasks: tasksTable(graph, s) };
  },
});

/**
 * The generated sections of a page, in order, as `{ heading, content }`
 * (those mapped to null left out). `unit` null is the root `index.md`.
 * @param {import("./backlog-graph.js").BacklogGraph} graph
 * @param {any} unit  a story, feature, component, epic or theme unit, or null
 * @returns {{ heading: string, content: string }[]}
 */
export function renderSections(graph, unit) {
  const kind = unit ? unit.kind : 'root';
  const content = SECTIONS[kind](graph, unit);
  return LAYOUT[kind].filter((s) => content[s.heading] != null).map((s) => ({ ...s, content: content[s.heading] }));
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasSection(body, heading) {
  return new RegExp(`^## ${escapeRe(heading)}\\n`, 'm').test(body);
}

/**
 * Replace the body of `## <heading>` with `content`, or create the section
 * (after `## <after>` when that exists, else before `## <before>` when that
 * exists, else at the end). A section that ends the file takes the trailing
 * blank lines with it. Function replacers throughout, so `$` in a title never
 * turns into a backreference.
 */
function upsertSection(body, heading, content, { after, before } = {}) {
  // The section body runs to the next `## ` (keeping the newline before it)
  // or to the end of the file (taking the trailing whitespace). A heading
  // starts a line, so a deeper `### <heading>` is never taken for it.
  const END = `(?:(\\n)(?=## )|\\s*(?![\\s\\S]))`;
  const re = new RegExp(`^(## ${escapeRe(heading)}\\n)([\\s\\S]*?)${END}`, 'm');
  if (re.test(body)) {
    return body.replace(re, (_m, head, _old, nl) => `${head}\n${content}\n${nl ?? ''}`);
  }
  if (after) {
    const afterRe = new RegExp(`^(## ${escapeRe(after)}\\n[\\s\\S]*?)${END}`, 'm');
    if (afterRe.test(body)) {
      return body.replace(afterRe, (_m, prev, nl) => `${prev.trimEnd()}\n\n## ${heading}\n\n${content}\n${nl ?? ''}`);
    }
  }
  if (before && hasSection(body, before)) {
    return body.replace(new RegExp(`^## ${escapeRe(before)}\\n`, 'm'), (m) => `## ${heading}\n\n${content}\n\n${m}`);
  }
  return `${body.trimEnd()}\n\n## ${heading}\n\n${content}\n`;
}

/**
 * `body` with its "Total backlog" line: open stories, their points, and the
 * components. The line replaces one the committed text has, else follows the
 * first `# ` heading, else starts the body.
 */
function withTotalLine(graph, body) {
  const open = [...graph.stories.values()].filter((s) => !s.done);
  const points = open.reduce((n, s) => n + s.points, 0);
  const line = `Total backlog: ${points} points across ${open.length} stories in ${graph.components.size} components.`;
  if (TOTAL_BACKLOG_RE.test(body)) return body.replace(TOTAL_BACKLOG_RE, () => line);
  const heading = body.match(/^# .*\n/m);
  if (!heading) return `${line}\n\n${body.trimStart()}`;
  const at = heading.index + heading[0].length;
  return `${body.slice(0, at)}\n${line}\n\n${body.slice(at).trimStart()}`;
}

/**
 * A page as read: its committed text with its generated sections (and, for
 * the root, its "Total backlog" line) placed where `upsertSection` places
 * them. The frontmatter and every hand-written section are kept as written.
 * `unit` null is the root `index.md`, rendered from nothing when it is
 * missing.
 * @param {import("./backlog-graph.js").BacklogGraph} graph
 * @param {any} unit  a story, feature, component, epic or theme unit, or null
 * @returns {string}
 */
export function renderPage(graph, unit) {
  const { text, body: committed } = unit ? { text: unit.text(), body: unit.body() } : rootText(graph);
  const head = text.slice(0, text.length - committed.length);
  let body = unit ? committed : withTotalLine(graph, committed);
  for (const s of renderSections(graph, unit)) {
    body = upsertSection(body, s.heading, s.content, s);
  }
  return head + (head ? body : body.trimStart());
}

/** The root `index.md`'s text (LF line ends) and body; both empty when it is missing. */
function rootText(graph) {
  let text;
  try {
    text = readFileSync(join(graph.root, 'index.md'), 'utf8').replace(/\r\n/g, '\n');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { text: '', body: '' };
  }
  return { text, body: parseFrontmatter(text).body };
}
