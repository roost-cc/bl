// The mock of the `stop` op: a story that no process holds.
import { createItems, engineBacklog } from '../helpers/engine-backlog.js';

const ctx = engineBacklog();
const [id] = await createItems(ctx, [{ type: 'story', state: { status: 'draft', run: 'idle' } }]);

export default { argv: [id], ctx };
