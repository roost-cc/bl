/**
 * The outcome objects the fake agents of the loop tests return (F-68 D2):
 * the verifier's (`schemas/review.json`), the fix round's (`fix.json`) and a
 * self-review's (`self-review.json`). The loop decides from them and writes
 * `review_round` and `review_status` itself, so a fake agent leaves those
 * fields alone.
 */

/** A verifier's outcome: one Must fix item when `pending`, none otherwise. */
export function reviewOutcome({
  pending = false,
  must = pending ? 1 : 0,
  should = 0,
  nits = 0,
  escalated = false,
} = {}) {
  return { summary: must + should > 0 ? 'open items' : 'clean', must, should, nits, escalated };
}

/** A fix round that checked off every item. */
export const FIX_OUTCOME = Object.freeze({ summary: 'fixed every item', fixed: true, open: 0 });

/** A self-review that found nothing to correct. */
export const SELF_REVIEW_OUTCOME = Object.freeze({ summary: 'nothing to correct', ok: true, changed: false });

/**
 * The outcome a fake agent returns for `promptName` when its behaviour
 * returned none: the fix round's and the self-reviews'. The verifier has no
 * default; its behaviour returns `reviewOutcome(...)`.
 */
export function defaultOutcome(promptName) {
  if (promptName === 'feature-workon-review') return FIX_OUTCOME;
  if (promptName === 'feature-self-review' || promptName === 'feature-fix-self-review') return SELF_REVIEW_OUTCOME;
  return null;
}
