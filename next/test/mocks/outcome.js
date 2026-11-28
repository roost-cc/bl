// The mock of the `outcome` op: a story waiting at uTop's `wait_implement` box, and a success with a note.
import { createItems, engineBacklog } from '../helpers/engine-backlog.js';

const ctx = engineBacklog();
const [id] = await createItems(ctx, [
  { type: 'story', state: { status: 'in_progress', run: 'waiting: wait_implement' } },
]);

export default { argv: [id, 'success', 'the operator checked it'], ctx };
