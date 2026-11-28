// The mock of the `force` op: an idle story whose status is set to `implemented`, with a note.
import { createItems, engineBacklog } from '../helpers/engine-backlog.js';

const ctx = engineBacklog();
const [id] = await createItems(ctx, [{ type: 'story', state: { status: 'in_progress', run: 'idle' } }]);

export default { argv: [id, '/status', 'implemented', 'the operator checked it'], ctx };
