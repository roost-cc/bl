/**
 * report-cmd.js — `bl report`: the backlog progress report (F-40 Design D1,
 * D5).
 *
 *   bl report [--out <dir>] [--since <YYYY-MM-DD>] [--charts <adapter>] [--json]
 *
 * Writes `<backlog>/reports/` (or `--out`): `index.md`, `data.json`, a
 * `.gitignore` holding `*`, so the output ignores itself and a run leaves
 * `git status` clean, and whatever files the chart adapter returns
 * (`--charts`, Design D4; `vega-lite` by default, which writes none). A
 * run writes the whole report into a directory beside the output, then swaps
 * it for the last run's, so a failed run leaves the last report whole; a
 * directory that holds files but no such `.gitignore` is not a report's and
 * is refused. stdout is the path of `index.md`, or with `--json` the data and
 * nothing written. Like `bl history` it only reads git objects and the
 * working tree: no activity log, no commit, and no lock but the output's own
 * (`.<dir>.lock` beside it), which keeps two runs from swapping at once.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { loadConfig, parseArgs, warn } from './config.js';
import { acquirePidLock, releasePidLock } from './pid-lock.js';
import { formatBacklogMarkdown } from './sync.js';
import { adapter, adapterNames, DEFAULT_ADAPTER, pathsClash, renderCharts } from './chart.js';
import './chart-adapters/vega-lite.js';
import { buildHistory } from './history.js';
import { buildReport, renderMarkdown } from './report.js';

/** The output directory under the backlog root, and what marks one as a report's. */
export const REPORTS_DIR = 'reports';
export const REPORT_GITIGNORE = '*\n';

/** The files a run writes itself, which no adapter file may replace. */
const OWN_FILES = new Set(['.gitignore', 'data.json', 'index.md']);

const HELP = `Usage: bl report [--out <dir>] [--since <YYYY-MM-DD>] [--charts <adapter>] [--json]

The backlog progress report: stories, features, epics and points by status;
progress per theme, epic, feature and component; throughput per week; lead
and cycle time; work item age; agent cost per unit and per point, and token
efficiency; burn-up, flow, throughput and cost charts. Built from bl
history's daily snapshots.

Writes ${REPORTS_DIR}/index.md, ${REPORTS_DIR}/data.json and ${REPORTS_DIR}/.gitignore (*)
in the backlog repo, replacing the last run's files, and prints the path of
index.md. Nothing is committed.

Options:
  --out <dir>        Write the report there instead (its links assume
                     <backlog>/${REPORTS_DIR}/)
  --since <date>     Only history from this date (YYYY-MM-DD)
  --charts <name>    The chart adapter (default ${DEFAULT_ADAPTER}; registered:
                     ${adapterNames().join(', ')})
  --json             Print data.json to stdout and write nothing`;

/**
 * Throw unless `dir` is missing, empty, or a report directory (its
 * `.gitignore` is `REPORT_GITIGNORE`), which a run may replace.
 */
export function checkReportDir(dir) {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  const marker = join(dir, '.gitignore');
  const ours = existsSync(marker) && readFileSync(marker, 'utf8') === REPORT_GITIGNORE;
  if (!ours && readdirSync(dir).length > 0) {
    throw new Error(`${dir} holds files and is not a report directory (no .gitignore holding *); not clearing it`);
  }
}

/**
 * Write the report for `data` as `dir`, its charts drawn by the adapter
 * `charts` (the adapter's files under `dir`), its page formatted through the
 * backlog's markdown format plugin, as `bl sync` formats the indexes.
 *
 * The whole report is written and formatted in `.<dir>.new` beside `dir`
 * (its `.gitignore` first, so git ignores it), then swapped in by two
 * renames: the last report to `.<dir>.old`, the new one to `dir`. A
 * failure before the swap leaves the last report as it was; one between the
 * renames moves the last report back, and if that fails too it stays in
 * `.<dir>.old`, which the next run (any process) moves back before it
 * stages. `.<dir>.lock` keeps a second run from writing until the first is
 * done; that run fails naming the holder. The lock is released whatever
 * cleanup throws.
 * @returns {string} the path of `index.md`
 */
export function writeReport(config, dir, data, charts = DEFAULT_ADAPTER) {
  const { markdownById, files } = renderCharts(data.charts, charts);
  // `renderCharts` returns normalized paths, as `OWN_FILES` names them.
  const clash = files.find((f) => [...OWN_FILES].some((own) => pathsClash(f.path, own)));
  if (clash) throw new Error(`chart adapter ${charts}: file ${clash.path} would replace the report's own`);
  checkReportDir(dir);
  const beside = (suffix) => join(dirname(dir), `.${basename(dir)}.${suffix}`);
  mkdirSync(dirname(dir), { recursive: true });
  const lock = beside('lock');
  const token = `${process.pid}\n${new Date().toISOString()}\nbl report\n`;
  const taken = acquirePidLock(lock, token);
  if (!taken.content)
    throw new Error(`another bl report (pid ${taken.holder}) is writing ${dir}; try again when it is done`);
  const stage = beside('new');
  const old = beside('old');
  try {
    // Checked again under the lock: another run may have written it meanwhile.
    checkReportDir(dir);
    recoverReport(dir, old);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage);
    writeFileSync(join(stage, '.gitignore'), REPORT_GITIGNORE);
    writeFileSync(join(stage, 'data.json'), JSON.stringify(data, null, 2) + '\n');
    for (const file of files) {
      const path = join(stage, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    writeFileSync(join(stage, 'index.md'), renderMarkdown(data, markdownById));
    formatBacklogMarkdown(config, new Set([join(stage, 'index.md')]));

    if (existsSync(dir)) renameSync(dir, old);
    try {
      renameSync(stage, dir);
    } catch (e) {
      if (existsSync(old)) {
        try {
          renameSync(old, dir);
        } catch {
          throw new Error(`${e.message}; the last report is kept in ${old}, and the next run restores it`);
        }
      }
      throw e;
    }
    rmSync(old, { recursive: true, force: true });
    return join(dir, 'index.md');
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true });
    } finally {
      releasePidLock(lock, token);
    }
  }
}

/**
 * Before a run stages, under the lock: `old`, left by a run that failed
 * during or after its swap, is the last report while `dir` holds none (its
 * `.gitignore`), and is moved back; once `dir` is a report, `old` is an
 * older one and is removed. `dir` has passed `checkReportDir`, so without
 * a marker it is missing or empty.
 */
function recoverReport(dir, old) {
  if (!existsSync(old)) return;
  if (existsSync(join(dir, '.gitignore'))) {
    rmSync(old, { recursive: true, force: true });
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(old, dir);
}

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.since != null && (args.since === true || !/^\d{4}-\d{2}-\d{2}$/.test(String(args.since)))) {
    console.error('bl report: --since needs a date, YYYY-MM-DD');
    process.exit(1);
  }
  if (args.out === true || (args.out != null && String(args.out).trim() === '')) {
    console.error('bl report: --out needs a directory');
    process.exit(1);
  }
  if (args.charts === true || (args.charts != null && String(args.charts).trim() === '')) {
    console.error('bl report: --charts needs an adapter name');
    process.exit(1);
  }
  const charts = args.charts != null ? String(args.charts) : DEFAULT_ADAPTER;
  try {
    adapter(charts);
  } catch (e) {
    console.error(`bl report: ${e.message}`);
    process.exit(1);
  }
  const config = loadConfig();
  let data;
  try {
    data = buildReport(buildHistory(config, { since: args.since ?? '' }), config);
  } catch (e) {
    console.error(`bl report: ${e.message}`);
    process.exit(1);
  }
  if (data.unreadable > 0) warn(`${data.unreadable} index.md blob(s) could not be read and were skipped`);
  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const dir = args.out != null ? resolve(String(args.out)) : join(config.backlogRoot, REPORTS_DIR);
  let page;
  try {
    page = writeReport(config, dir, data, charts);
  } catch (e) {
    console.error(`bl report: ${e.message}`);
    process.exit(1);
  }
  console.log(page);
}
