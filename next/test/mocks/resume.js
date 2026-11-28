// The mock of the `resume` op: an idle story whose next box is uTop's `refine`, which the fake agent step runs.
import { createItems, definedSteps, engineBacklog } from '../helpers/engine-backlog.js';
import { UTOP_STEPS } from '../helpers/flow-fixture.js';

const ctx = { ...engineBacklog({ 'defined-steps.yaml': definedSteps() }), catalogue: UTOP_STEPS };
const [id] = await createItems(ctx, [{ type: 'story', state: { status: 'draft', run: 'idle', next: 'refine' } }]);

export default { argv: [id], ctx };
