/**
 * agent-failure.js — what an escalation for a failed headless step says
 * (S-1140): the step, the time, each configuration with a capacity reading
 * taken at escalation time, one cause line and the ordered steps that fix that
 * cause.
 *
 * Pure: no I/O, and no agent names (F-64 D1). Agent-specific facts (a check
 * command, a billing page) come from the adapter's `remediation()`.
 */

import { configurationLabel } from './config.js';

/**
 * `value` (an ISO string, a Date or epoch milliseconds) as local wall-clock
 * time for the operator: "2026-10-13 18:11 America/Los_Angeles".
 */
export function localTime(value) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) return String(value);
  const zone = Temporal.Now.timeZoneId();
  const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
  const p = (n) => String(n).padStart(2, '0');
  return `${z.year}-${p(z.month)}-${p(z.day)} ${p(z.hour)}:${p(z.minute)} ${zone}`;
}

/** The causes, in the order the cause line picks them. */
const CAUSE_ORDER = ['spend', 'window', 'overloaded', 'unknown'];

const timeMs = (v) => (v == null ? NaN : new Date(v).getTime());

/** The window names at 0% in `reading`. */
const usedUp = (reading) => (reading?.windows ?? []).filter((w) => w.remainingPercent <= 0).map((w) => w.name);

/**
 * The cause of one refused configuration: its out-list entry `out` (`kind`
 * from the refusal, or `quota` from a reading) and the capacity `reading`
 * taken at escalation time. Returns `{ cause, line, until }`: `cause` is
 * `spend`, `window`, `overloaded` or `unknown`; `line` is the operator's
 * words; `until` is the reset (epoch ms) of a used-up window, else null.
 *
 * A reading outranks a `session` or `weekly` refusal: a reading `available`
 * is never a used-up window, and a reading `unavailable` with a window at 0%
 * or a reset time is one. A reading
 * `unavailable` is a spend cap only when it says so (`spend: true`); one that
 * is neither (a local server that refused the connection) gives `unknown`.
 * A `session` or `weekly` refusal is a used-up window only when no reading
 * says otherwise (none, or `unknown`).
 *
 * @param {{ out: { kind: string, until: string|null } | null,
 *   reading: { state: string, until: Date|string|null, windows?: object[], message?: string, spend?: true } | null }} c
 */
export function classifyCause({ out, reading }) {
  const kind = out?.kind ?? null;
  const state = reading?.state ?? null;
  const zero = usedUp(reading);
  if (kind === 'spend' || (state === 'unavailable' && reading.spend === true)) {
    return { cause: 'spend', line: 'spend cap reached', until: null };
  }
  const readWindow = state === 'unavailable' && (zero.length > 0 || Number.isFinite(timeMs(reading.until)));
  const refusedWindow = (kind === 'session' || kind === 'weekly') && (state == null || state === 'unknown');
  if (readWindow || refusedWindow) {
    // The reading's reset when it holds a time, else the refusal's.
    const sources = readWindow ? [reading.until, out?.until] : [out.until];
    const until = sources.map(timeMs).find(Number.isFinite) ?? null;
    const names = zero.length ? ` (${zero.join(', ')} at 0%)` : '';
    const when = until == null ? ', no reset time' : ` until ${localTime(until)}`;
    return { cause: 'window', line: `quota window used up${when}${names}`, until };
  }
  if (kind === 'capacity' && reading?.state === 'available') {
    return { cause: 'overloaded', line: 'provider overloaded, your quota is fine', until: null };
  }
  if (kind === 'capacity' && reading?.state === 'unknown') {
    return { cause: 'overloaded', line: 'provider overloaded; quota could not be read', until: null };
  }
  return { cause: 'unknown', line: 'unknown', until: null };
}

/** `configurationLabel`'s name, with `(agent default)` when the configuration names no model. */
function configurationName(c) {
  return `${configurationLabel(c)}${c.model == null ? ' (agent default)' : ''}`;
}

/**
 * The line of one configuration, then its reading, indented: an `unknown` or
 * `unavailable` reading's message (the evidence for a spend cause), then the
 * window lines.
 */
function configurationLines(c) {
  const name = configurationName(c);
  if (c.excluded)
    return [
      `- ${name}: excluded — it ran ${c.excluded.join(', ')} in this run, and the reviewer is never the implementer`,
    ];
  if (c.headless === false) return [`- ${name}: its agent has no headless mode`];
  const head = !c.out
    ? `- ${name}${c.error == null ? ': not tried' : ''}`
    : `- ${name}: ${c.out.kind} — ${c.out.message} (${c.out.scope === 'account' ? `every ${c.out.agent} configuration` : 'this configuration'}; ${c.out.until == null ? 'no reset time' : `until ${localTime(c.out.until)}`})`;
  const r = c.reading;
  if (!r) return [head];
  const said = `  - capacity: ${r.state} — ${r.message || 'no reason given'}`;
  if (r.state === 'unknown') return [head, said];
  return [
    head,
    ...(r.state === 'unavailable' ? [said] : []),
    ...(r.windows ?? []).map(
      (w) =>
        `  - ${w.name}: ${w.remainingPercent}% left, ${w.resetsAt == null ? 'no reset time' : `resets ${localTime(w.resetsAt)}`}`,
    ),
  ];
}

/** Where the operator raises a limit or reads usage: the adapter's page, else its own usage page. */
const usagePage = (c) =>
  c?.remediation?.billingUrl ? c.remediation.billingUrl : `${c?.agent ?? 'the agent'}'s own usage page`;

/**
 * The text of a failed headless step's escalation details, and its cause.
 *
 * `configurations` lists the role's configurations in priority order, each
 * `{ agent, model, out, reading, remediation, excluded, headless }`: `out`
 * its out-list entry or null, `reading` the capacity reading taken at
 * escalation time or null (none was taken), `remediation` the adapter's
 * `{ checkCommand, billingUrl }` or null, `excluded` the steps it ran as the
 * implementer (F-64 D4) or null, `headless` false when its agent has no
 * headless mode. `error` is the raw error of a session that failed without a
 * refusal bl recognised: its cause is always `unknown`. `escalates` is false
 * when the caller stops without writing `## Escalation` (a `bl review` round
 * abort): the steps then have no step that clears it.
 *
 * @param {{ step: string, failedAt: Date|number|string, roleKey: string, resumeHint: string,
 *   configurations: object[], error?: string|null, escalates?: boolean }} f
 * @returns {{ cause: string, causeLine: string, text: string }}
 */
export function describeFailure({
  step,
  failedAt,
  roleKey,
  resumeHint,
  configurations,
  error = null,
  escalates = true,
}) {
  const configs = configurations.map((c) => ({ ...c, error }));
  let chosen = null;
  if (error == null) {
    const classified = configs.filter((c) => c.out).map((c) => ({ c, ...classifyCause(c) }));
    for (const cause of CAUSE_ORDER) {
      const found = classified.filter((x) => x.cause === cause);
      if (found.length === 0) continue;
      // The window that comes back first is the one worth waiting for; one
      // with no reset time comes last.
      const resetMs = (x) => x.until ?? Infinity;
      chosen = cause === 'window' ? found.reduce((a, b) => (resetMs(b) < resetMs(a) ? b : a)) : found[0];
      break;
    }
  }
  const cause = chosen?.cause ?? 'unknown';
  const causeLine = error != null ? 'unknown — not a capacity refusal bl recognised' : (chosen?.line ?? 'unknown');
  const who = chosen?.c ?? configs.find((c) => !c.excluded) ?? configs[0];
  const check = who?.remediation?.checkCommand;
  const resume = `Run \`${resumeHint}\`.`;
  const clear = 'Clear `## Escalation` to `None.`.';
  const capacity = "Run `bl capacity` to read the configuration's quota windows again.";
  let first;
  if (cause === 'overloaded')
    first = ['Wait about 30 minutes: the provider is overloaded, and it usually recovers.', capacity];
  else if (cause === 'window') {
    if (chosen.until == null) first = [capacity];
    else if (chosen.until <= new Date(failedAt).getTime()) first = ['The reset has passed; check with `bl capacity`.'];
    else first = [`Wait until the reset, ${localTime(chosen.until)}.`, capacity];
  } else if (cause === 'spend') first = [`Raise the spend limit or buy credits on ${usagePage(who)}.`, capacity];
  else
    first = [
      `Run \`bl capacity\`${check ? `, and \`${check}\`` : `, and check ${usagePage(who)}`}.`,
      'Fix what that shows.',
    ];
  const steps = [...first, ...(escalates ? [clear] : []), resume];
  const alternatives = [];
  if (cause === 'overloaded') alternatives.push(`add another configuration to "${roleKey}" in backlog.json`);
  if (cause === 'window') alternatives.push(`add a configuration of another agent to "${roleKey}" in backlog.json`);
  if (configs.some((c) => c.excluded))
    alternatives.push('add a "review_agent" configuration that did not implement this run');
  const text = [
    `Step: ${step}, failed at ${localTime(failedAt)}.`,
    '',
    `Configurations (backlog.json "${roleKey}", in priority order):`,
    '',
    ...configs.flatMap(configurationLines),
    ...(error != null ? ['', `Error: ${error}`] : []),
    '',
    `Cause: ${causeLine}`,
    '',
    'Next steps:',
    '',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    ...(alternatives.length ? ['', `Alternative: ${alternatives.join('; or ')}.`] : []),
  ].join('\n');
  return { cause, causeLine, text };
}
