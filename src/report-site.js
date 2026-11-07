/**
 * report-site.js — the backlog's documentation root, built by `bl report`
 * (F-79 D4).
 *
 * `writeSite` writes `<stage>/site/`: one complete root in the sense of
 * docs.roost.cc's guide ("What a repo provides"), which the site copies as
 * it is. In it:
 *
 *   - the published set (`PUBLISHED`) copied from the backlog, timestamps kept;
 *   - every page with a generated section (`GENERATED_SECTIONS`) and the root
 *     `index.md` rendered through `renderPage`, formatted through the
 *     backlog's markdown format plugin, each with its committed file's
 *     timestamp;
 *   - the progress report under `reports/`, so its URL and its `../` links
 *     stay as they are.
 *
 * Nothing else is copied: no `.bl/`, no config, no change in the backlog.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { dirname, join, sep } from 'path';
import { COMPONENTS_DIR, EPICS_DIR, STORIES_DIR, THEMES_DIR } from './config.js';
import { FEATURES_DIR } from './feature.js';
import { PRIORITY_FILE } from './priority.js';
import { UNIT_PAGE_KINDS, renderPage } from './render.js';
import { ROADMAP_FILE } from './roadmap.js';
import { formatBacklogMarkdown } from './sync.js';
import { TASKS_DIR } from './task.js';

/** The root's directory under a report's directory. */
export const SITE_DIR = 'site';

/** The backlog's hand-written documents; bl names no other path under it. */
const DOCS_DIR = 'docs';

/**
 * What the root copies from the backlog: what docs.roost.cc published before
 * F-79, plus `tasks/`, which the Tasks tables link.
 */
export const PUBLISHED = Object.freeze([
  STORIES_DIR,
  THEMES_DIR,
  EPICS_DIR,
  COMPONENTS_DIR,
  FEATURES_DIR,
  TASKS_DIR,
  DOCS_DIR,
  ROADMAP_FILE,
  PRIORITY_FILE,
]);

/**
 * Copy `from` to `to` with every symlink, at any depth, resolved to what it
 * points at, so `to` holds no symlink and no later write in it (a rendered
 * page, the formatter, a timestamp) follows one out of the stage. Timestamps
 * are kept. A `from` that does not exist is left out. A link that points at
 * nothing, or whose real path is outside `boundary`, fails naming it; one back
 * at a directory being copied is a loop, and is left out, as the docs site
 * does. (`cpSync`'s `dereference` resolves only `from` itself.)
 * @param {string} from
 * @param {string} to
 * @param {string} boundary  the real path that every copied path must resolve inside
 * @param {Set<string>} [copying]  the real paths of the directories being copied
 */
function copyResolved(from, to, boundary, copying = new Set()) {
  try {
    lstatSync(from);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  let real;
  try {
    real = realpathSync(from);
  } catch (e) {
    throw new Error(`bl report: ${from} is a symlink that points to nothing (${e.code})`);
  }
  if (real !== boundary && !real.startsWith(boundary + sep)) {
    throw new Error(`bl report: ${from} is a symlink to ${real}, outside ${boundary}`);
  }
  const st = statSync(real);
  if (st.isDirectory()) {
    if (copying.has(real)) return;
    mkdirSync(to);
    for (const name of readdirSync(from)) {
      copyResolved(join(from, name), join(to, name), boundary, new Set([...copying, real]));
    }
  } else {
    copyFileSync(from, to);
  }
  utimesSync(to, st.atime, st.mtime);
}

/**
 * Write the backlog's documentation root at `<stageDir>/site`.
 * @param {{ backlogRoot: string }} config
 * @param {import("./backlog-graph.js").BacklogGraph} graph
 * @param {string} stageDir     the report's staged directory
 * @param {string[]} reportFiles the report's files, relative to `stageDir`, copied to `site/reports/`
 * @returns {string} the root's path
 */
export function writeSite(config, graph, stageDir, reportFiles) {
  const site = join(stageDir, SITE_DIR);
  mkdirSync(site);
  const backlog = realpathSync(graph.root);
  for (const name of PUBLISHED) copyResolved(join(graph.root, name), join(site, name), backlog);

  // Each rendered page with the committed file it stands for (null: none).
  const pages = [{ path: join(site, 'index.md'), text: renderPage(graph, null), source: join(graph.root, 'index.md') }];
  for (const kind of UNIT_PAGE_KINDS) {
    for (const unit of graph.list(kind)) {
      const text = renderPage(graph, unit);
      // A page with nothing generated (a story with no task) is its copy already.
      if (text !== unit.text()) pages.push({ path: join(site, unit.relPath), text, source: unit.file });
    }
  }
  for (const page of pages) writeFileSync(page.path, page.text);
  formatBacklogMarkdown(config, new Set(pages.map((p) => p.path)));
  for (const { path, source } of pages) {
    if (!existsSync(source)) continue;
    const st = statSync(source);
    utimesSync(path, st.atime, st.mtime);
  }

  const stage = realpathSync(stageDir);
  for (const file of reportFiles) {
    const to = join(site, 'reports', file);
    mkdirSync(dirname(to), { recursive: true });
    copyResolved(join(stageDir, file), to, stage);
  }
  return site;
}
