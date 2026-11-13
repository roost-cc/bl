/**
 * escalation.js — the text of an escalation bl writes on its own, in the shape
 * of `prompts/_escalation.md`: the rule at stake, how it works, the problem,
 * why the agents can't fix it, the decision and the details (S-897).
 *
 * Pure: no I/O.
 */

/** A fence longer than any backtick run in `text`, so the text cannot close it. */
export function fenced(text, lang = 'text') {
  const s = String(text ?? '');
  const longest = Math.max(2, ...(s.match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${s}\n${f}`;
}

/** `text` as an inline code span, its fence longer than any backtick run inside. */
export function codeSpan(text) {
  const s = String(text ?? '');
  const fence = '`'.repeat(Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length)) + 1);
  return fence.length > 1 ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}

/**
 * One decision: an optional lead line (which findings it is about, when there
 * are several decisions), the lettered options, then the question.
 *
 * @typedef {{ lead?: string, options: Array<{ letter: string, text: string }>, question: string }} Decision
 */

/**
 * The six bold-headed blocks of an escalation, joined by blank lines.
 *
 * @param {{ rule: string, how: string[], problem: string, why: string,
 *   decisions: Decision[], details: string[] }} e `how` is rendered as
 *   numbered steps; `details` is a list of lines, written as they are.
 * @returns {string}
 */
export function escalationText({ rule, how, problem, why, decisions, details }) {
  const decision = (d) =>
    [d.lead, d.options.map((o) => `- ${o.letter}. ${o.text}`).join('\n'), d.question].filter(Boolean).join('\n\n');
  return [
    `**The rule at stake:** ${rule}`,
    `**How it works:**\n\n${how.map((step, i) => `${i + 1}. ${step}`).join('\n')}`,
    `**The problem:** ${problem}`,
    `**Why the agents can't fix it:** ${why}`,
    `**The decision:**\n\n${decisions.map(decision).join('\n\n')}`,
    `**Details:**\n\n${details.length ? details.join('\n') : 'None.'}`,
  ].join('\n\n');
}
