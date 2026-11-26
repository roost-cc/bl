/**
 * The op schema gate test (F-138 D4, D-461): each op in `OPS` runs on mock
 * data, and each record it gives must hold to the op's `schema`.
 *
 * An op's mock is `next/test/mocks/<op>.js`, whose default export is
 * `{ argv, ctx }`: the arguments as typed, which the op's `args` parse, and
 * the context of the run. A registered op with no mock file fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import { addArgs } from '../commands/args.js';
import { Parser } from '../commands/dispatch.js';
import { OPS } from '../commands/ops/index.js';
import { recordsOf } from '../commands/output.js';
import { mkTempDir } from './helpers/tempdir.js';

const MOCKS = fileURLToPath(new URL('mocks', import.meta.url));

/** One ajv instance for the whole test (F-136 D5). */
const ajv = new Ajv2020({ strict: true, allErrors: true });

/**
 * The faults of each op in `ops` on its mock in `mocksDir`: one line per
 * missing mock, failed parse or record that breaks the op's schema.
 * @param {Readonly<Record<string, import('../commands/ops/index.js').Op>>} ops
 * @param {string} mocksDir
 * @returns {Promise<string[]>}
 */
async function opFaults(ops, mocksDir) {
  const faults = [];
  for (const [name, op] of Object.entries(ops)) {
    const mock = join(mocksDir, `${name}.js`);
    if (!existsSync(mock)) {
      faults.push(`${name}: no mock file ${name}.js`);
      continue;
    }
    const { argv, ctx } = (await import(pathToFileURL(mock).href)).default;
    const parser = new Parser({ prog: name });
    addArgs(parser, op.args);
    let args;
    try {
      args = parser.parse_args(argv);
    } catch (error) {
      faults.push(`${name}: the mock's argv does not parse: ${error.exit?.stderr ?? error.message}`);
      continue;
    }
    const validate = ajv.compile(op.schema);
    let index = 0;
    for await (const record of recordsOf(await op.run(args, ctx))) {
      if (!validate(record)) faults.push(`${name}: record ${index}: ${ajv.errorsText(validate.errors)}`);
      index += 1;
    }
  }
  return faults;
}

for (const [name, op] of Object.entries(OPS)) {
  test(`op ${name}: each record of its mock run holds to its schema`, async () => {
    assert.deepEqual(await opFaults({ [name]: op }, MOCKS), []);
  });
}

test('the check fails on an op whose record breaks its schema and on an op with no mock', async () => {
  const schema = {
    type: 'object',
    properties: { id: { type: 'string' }, points: { type: 'integer' } },
    required: ['id'],
    additionalProperties: false,
  };
  const ops = {
    good: { args: { ids: { nargs: '*' } }, schema, run: (args) => args.ids.map((id) => ({ id, points: 1 })) },
    broken: {
      args: {},
      schema,
      run: async function* () {
        yield { id: 'S-1' };
        yield { id: 'S-2', points: 'three' };
      },
    },
    unmocked: { args: {}, schema, run: () => ({ id: 'S-1' }) },
  };
  const mocks = mkTempDir('bl-op-mocks-');
  writeFileSync(join(mocks, 'good.js'), "export default { argv: ['S-1', 'S-2'], ctx: {} };\n");
  writeFileSync(join(mocks, 'broken.js'), 'export default { argv: [], ctx: {} };\n');
  assert.deepEqual(await opFaults(ops, mocks), [
    'broken: record 1: data/points must be integer',
    'unmocked: no mock file unmocked.js',
  ]);
});
