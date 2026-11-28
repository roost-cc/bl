// A child process that runs one flow invocation on a backlog of `engineBacklog`, for a test that
// runs it under a pseudo-terminal (F-141 D9): an interactive agent session needs the process's
// terminal, which the test process may not have.
//
//   node flow-child.js <backlog dir> <item id> <start box> <result file>
//
// It loads the backlog's configuration with `$HOME` the backlog's parent, as `engineBacklog` does,
// builds the flow set with the real step catalogue, runs the `run` entry from the start box, and
// writes the result, or `{ crash: <message> }`, as JSON to the result file: its stdout is the
// terminal. Its `{{#bl}}` runner gives `[<line>]`, as the tests' runner does.
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { buildFlowSet } from '../../engine/flow-set.js';
import { runFlow } from '../../engine/runner.js';
import { STEPS } from '../../steps/index.js';
import { load } from './config-fixture.js';
import { UTOP_STEPS } from './flow-fixture.js';

const [backlogDir, id, start, resultFile] = process.argv.slice(2);
const home = dirname(backlogDir);
const config = load({ home, backlogDir, operatorDir: join(home, '.config', 'bl') });
const catalogue = { ...UTOP_STEPS, ...STEPS };
const ctx = {
  backlogDir,
  config,
  flowSet: buildFlowSet(config, catalogue, backlogDir),
  bl: async (/** @type {string} */ line) => `[${line}]`,
};
const result = await runFlow(ctx, { id, start, by: 'operator', entry: 'run', catalogue }).catch((error) => ({
  crash: error.message,
}));
writeFileSync(resultFile, JSON.stringify(result));
