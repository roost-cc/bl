/**
 * edit.js — open a story, component, feature or task file in $VISUAL/$EDITOR/vi.
 */

import { editorCommand, loadConfig, parseArgs, runEditor } from './config.js';
import { findUnitFile } from './unit-file.js';

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    const editor = editorCommand();
    console.log(`Usage: bl edit <id> [options]

Arguments:
  <id>                Story, component, feature, or task ID (e.g. S34, C10, F3, T5)

Options:
  --help              Show this help

Opens the file in ${editor} ($VISUAL → $EDITOR → vi).`);
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

  const result = runEditor(hit.indexPath);
  process.exit(result.status ?? 0);
}
