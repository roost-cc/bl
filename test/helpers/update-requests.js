/**
 * update-requests.js — every malformed input class of an update story's
 * request state (F-50 D8), with the message `updateRequestProblem` gives.
 */

/** @type {Array<[object, RegExp]>} */
export const MALFORMED_UPDATE_REQUESTS = [
  [{ update_request: 'drpo' }, /"drpo" is not one of approve, drop/],
  [{ update_request: '' }, /is not one of/],
  [{ update_request: ['drop'] }, /is not one of/],
  [{ update_request: { drop: true } }, /is not one of/],
  [{ update_request: 1 }, /is not one of/],
  [{ update_request: 'drop' }, /drop without a non-empty update_request_reason/],
  [{ update_request: 'drop', update_request_reason: '   ' }, /drop without a non-empty/],
  [{ update_request: 'drop', update_request_reason: '' }, /drop without a non-empty/],
  [{ update_request: 'drop', update_request_reason: ['not now'] }, /drop without a non-empty/],
  [{ update_request: 'drop', update_request_reason: 42 }, /drop without a non-empty/],
  [{ update_request: 'approve', update_request_reason: 'not applicable' }, /reason on update_request: approve/],
  [{ update_request_reason: 'orphan' }, /reason without update_request: drop/],
];
