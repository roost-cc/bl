/**
 * bl-next-fixture-ops.js — `next/bin/bl-next` with fixture ops in place of
 * `OPS`, which F-138 leaves empty. `main.test.js` runs it with `node` to check
 * a command's output end to end.
 *
 *   - `story`: one record, `{ id, title }`.
 *   - `stories`: a record set from an async iterable, one record per id.
 */

import { main } from '../../commands/main.js';

const STORY_SCHEMA = { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } };

const ops = Object.freeze({
  story: {
    args: { id: { help: 'the story' } },
    schema: STORY_SCHEMA,
    run: (args) => ({ id: args.id, title: `Story ${args.id}` }),
  },
  stories: {
    args: { ids: { nargs: '*', help: 'the stories' } },
    schema: STORY_SCHEMA,
    run: async function* (args) {
      for (const id of args.ids) yield { id, title: `Story ${id}` };
    },
  },
});

process.exitCode = await main(process.argv.slice(2), { ops });
