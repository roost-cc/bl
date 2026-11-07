/**
 * agents.js — print the backlog AGENTS.md reference, the plain-writing guide
 * and, inside a backlog, each dictionary its backlog.json lists (F-82 D8).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dictionariesOf, exitStatus, findBacklogRoot, loadConfig, showText, warn } from './config.js';
import { renderFragment } from './tool-guide.js';
import { renderDictionaryGuide } from './session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The backlog's config, or null outside a backlog. */
function backlogConfig() {
  let backlogRoot;
  try {
    backlogRoot = findBacklogRoot();
  } catch {
    return null;
  }
  return loadConfig({ backlogRoot });
}

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: bl agents

Prints the backlog system reference (AGENTS.md) for agents and humans, followed by the
plain-writing guide (prompts/_plain-writing.md) that every bl prompt carries. Inside a backlog,
the guide's {{dictionaryGuide}} slot names the dictionaries backlog.json "dictionaries" lists,
and the contents of each one follow, under "## Dictionary: <path>".`);
    process.exit(0);
  }

  const config = backlogConfig();
  const reference = readFileSync(join(__dirname, 'AGENTS.md'), 'utf8');
  const writing = renderFragment('_plain-writing', { dictionaryGuide: renderDictionaryGuide(config) });
  const parts = [reference.trimEnd(), writing];
  for (const path of dictionariesOf(config)) {
    // A listed file that cannot be read is `bl validate`'s `dictionary-file`
    // error; the reference and the other dictionaries still print.
    let content;
    try {
      content = readFileSync(path, 'utf8').trimEnd();
    } catch (e) {
      warn(`backlog.json "dictionaries" lists ${path}, which cannot be read (${e.code ?? e.message})`);
      continue;
    }
    parts.push(`## Dictionary: ${path}\n\n${content}`);
  }
  process.exitCode = exitStatus(showText(`${parts.join('\n\n')}\n`));
}
