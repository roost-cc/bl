/**
 * agent-failure.js — what an escalation for a failed headless step says
 * (S-1140): the step, the time, each configuration with a capacity reading
 * taken at escalation time, one cause line and the ordered steps that fix that
 * cause.
 *
 * Pure: no I/O, and no agent names (F-64 D1). Agent-specific facts (a check
 * command, a billing page) come from the adapter's `remediation()`.
 */

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
 * @param {{ out: { kind: string, until: string|null } | null,
 *   reading: { state: string, until: Date|string|null, windows?: object[], message?: string } | null }} c
 */
export function classifyCause({ out, reading }) {
  const kind = out?.kind ?? null;
  const zero = usedUp(reading);
  if (kind === 'spend' || (reading?.state === 'unavailable' && reading.until == null && zero.length === 0)) {
    return { cause: 'spend', line: 'spend cap reached', until: null };
  }
  const readUntil = reading?.state === 'unavailable' ? timeMs(reading.until) : NaN;
  const outUntil = kind === 'session' || kind === 'weekly' ? timeMs(out.until) : NaN;
  const until = Number.isFinite(readUntil) ? readUntil : outUntil;
  if (Number.isFinite(until)) {
    const names = zero.length ? ` (${zero.join(', ')} at 0%)` : '';
    return { cause: 'window', line: `quota window used up until ${localTime(until)}${names}`, until };
  }
  if (kind === 'capacity' && reading?.state === 'available') {
    return { cause: 'overloaded', line: 'provider overloaded, your quota is fine', until: null };
  }
  if (kind === 'capacity' && reading?.state === 'unknown') {
    return { cause: 'overloaded', line: 'provider overloaded; quota could not be read', until: null };
  }
  return { cause: 'unknown', line: 'unknown', until: null };
}

/** `agent model`, or `agent (agent default)` when the configuration names no model. */
export function configurationName({ agent, model }) {
  return `${agent} ${model ?? '(agent default)'}`;
}

/** The line of one configuration, then its reading's window lines, indented. */
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
  if (r.state === 'unknown') return [head, `  - capacity: unknown — ${r.message || 'no reason given'}`];
  return [
    head,
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
 * refusal bl recognised: its cause is always `unknown`.
 *
 * @param {{ step: string, failedAt: Date|number|string, roleKey: string, resumeHint: string,
 *   configurations: object[], error?: string|null }} f
 * @returns {{ cause: string, causeLine: string, text: string }}
 */
export function describeFailure({ step, failedAt, roleKey, resumeHint, configurations, error = null }) {
  const configs = configurations.map((c) => ({ ...c, error }));
  let chosen = null;
  if (error == null) {
    const classified = configs.filter((c) => c.out).map((c) => ({ c, ...classifyCause(c) }));
    for (const cause of CAUSE_ORDER) {
      const found = classified.filter((x) => x.cause === cause);
      if (found.length === 0) continue;
      // The window that comes back first is the one worth waiting for.
      chosen = cause === 'window' ? found.reduce((a, b) => (b.until < a.until ? b : a)) : found[0];
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
    const passed = chosen.until <= new Date(failedAt).getTime();
    first = passed
      ? ['The reset has passed; check with `bl capacity`.']
      : [`Wait until the reset, ${localTime(chosen.until)}.`, capacity];
  } else if (cause === 'spend') first = [`Raise the spend limit or buy credits on ${usagePage(who)}.`, capacity];
  else
    first = [
      `Run \`bl capacity\`${check ? `, and \`${check}\`` : `, and check ${usagePage(who)}`}.`,
      'Fix what that shows.',
    ];
  const steps = [...first, clear, resume];
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
