// A child process that runs one flow invocation on a backlog of `engineBacklog`, for a test that
// runs it under a pseudo-terminal (F-141 D9): an interactive agent session needs the process's
// terminal, which the test process may not have; and for a test that signals a suspended flow or
// a running step (F-152 D3, D7).
//
//   node flow-child.js <backlog dir> <item id> <entry, or resume> <result file> [wake] [hang]
//
// It loads the backlog's configuration with `$HOME` the backlog's parent, as `engineBacklog` does,
// builds the flow set with the real step catalogue, runs the entry `entry` or a resume, and writes
// the result, or `{ crash: <message> }`, as JSON to the result file: its stdout is the terminal. Its `{{#bl}}` runner gives `[<line>]`, as the tests' runner does. With
// `wake`, it suspends at a gate with `waitForWake`. With `hang`, its `agent` step prints
// `running <box>` on stderr and never returns. With either, it ends on SIGINT and SIGTERM through
// `exitOnSignal`, as `bl` does.
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { buildFlowSet } from '../../engine/flow-set.js';
import { runFlow } from '../../engine/runner.js';
import { waitForWake } from '../../engine/wake.js';
import { exitOnSignal } from '../../lib/signal-exit.js';
import { STEPS } from '../../steps/index.js';
import { load } from './config-fixture.js';
import { UTOP_STEPS } from './flow-fixture.js';

const [backlogDir, id, entry, resultFile, ...flags] = process.argv.slice(2);
const wake = flags.includes('wake');
const hang = flags.includes('hang');
const home = dirname(backlogDir);
const config = load({ home, backlogDir, operatorDir: join(home, '.config', 'bl') });
/** An `agent` step that runs until a signal ends the process. */
const hanging = {
  ...UTOP_STEPS.agent,
  run: (/** @type {{ box: string }} */ step) => {
    process.stderr.write(`running ${step.box}\n`);
    return new Promise(() => setInterval(() => {}, 1 << 30));
  },
};
const catalogue = { ...UTOP_STEPS, ...STEPS, ...(hang ? { agent: hanging } : {}) };
const ctx = {
  backlogDir,
  config,
  flowSet: buildFlowSet(config, catalogue, backlogDir),
  bl: async (/** @type {string} */ line) => `[${line}]`,
};
if (wake || hang) exitOnSignal();
const result = await runFlow(ctx, {
  id,
  by: 'operator',
  ...(entry === 'resume' ? { resume: true } : { entry }),
  catalogue,
  ...(wake ? { wake: waitForWake } : {}),
}).catch((error) => ({
  crash: error.message,
}));
writeFileSync(resultFile, JSON.stringify(result));
