/**
 * edit.js — open a story, component, feature, epic, theme or task file in
 * $VISUAL/$EDITOR/vi: the committed file, never the rendered page.
 */

import { reportExit } from './child.js';
import { editorCommand, loadConfig, parseArgs, runEditor } from './config.js';
import { findUnitFile } from './unit-file.js';

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    const editor = editorCommand();
    console.log(`Usage: bl edit <id> [options]

Arguments:
  <id>                Story, component, feature, epic, or task ID, or a theme slug
                      (e.g. S34, C10, F3, E69, T5, backlog)

Options:
  --help              Show this help

Opens the committed file in ${editor} ($VISUAL → $EDITOR → vi). It holds no
generated table; bl view shows the page with them.`);
    process.exit(0);
  }

  const rawId = args.positional[0];
  if (!rawId) {
    console.error('Usage: bl edit <id>');
    process.exit(1);
  }

  const hit = findUnitFile(rawId, loadConfig());
  if ('error' in hit) {
    console.error(hit.error);
    process.exit(1);
  }

  // exitCode, not exit(): exit() right after a write to a pipe can drop it.
  process.exitCode = reportExit(editorCommand(), runEditor(hit.indexPath));
}
