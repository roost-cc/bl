/**
 * prepare-worker.js — run one headless prep (`bl run`'s) in its own process,
 * so a test can race two of them: `node prepare-worker.js story|feature <backlog>`.
 * Exits as the prep does (1 on a strict failure).
 */

import { loadConfig, normalizeId } from '../../src/config.js';
import { findStoryDir } from '../../src/story.js';
import { prepareStoryRun } from '../../src/workon.js';
import { prepareFeatureWorktree } from '../../src/feature-cmd.js';
import { findFeature, normalizeFeatureId } from '../../src/feature.js';

const [kind, backlog] = process.argv.slice(2);
process.env.BL_BACKLOG_DIR = backlog;
const config = loadConfig({ backlogRoot: backlog });
if (kind === 'story') {
  const parsed = normalizeId('S-7');
  prepareStoryRun(parsed, findStoryDir(parsed, config), config, {});
} else {
  prepareFeatureWorktree(config, findFeature(normalizeFeatureId('F-1'), config));
}
