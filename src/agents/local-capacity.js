/**
 * local-capacity.js — ask the local model server whether it is up (S-1371).
 *
 * `LocalProvider.capacity()` awaits `probeLocalServer` in the bl process. It
 * asks `<url>/health` (llama-server answers 200 once the model is loaded, 503
 * while it loads) and resolves to `{ ok: true, status: 200 }` for any HTTP
 * answer, or `{ ok: false, code: "...", error: "..." }` when there is none.
 * `code` is `ECONNREFUSED` when nothing listens on the port, `TIMEOUT` when
 * the deadline passed, else the error's own code.
 */

/** How long the health request may take before it is abandoned. */
export const LOCAL_CAPACITY_TIMEOUT_MS = 2_000;

/** The health URL of the server at `url`: `<url>/health`. */
export function healthUrl(url) {
  return `${String(url).replace(/\/+$/, '')}/health`;
}

/**
 * GET `<url>/health` within `timeoutMs`. Never rejects.
 * @param {{ url: string, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: true, status: number } | { ok: false, code: string|null, error: string }>}
 */
export async function probeLocalServer({ url, timeoutMs = LOCAL_CAPACITY_TIMEOUT_MS }) {
  try {
    const res = await fetch(healthUrl(url), { signal: AbortSignal.timeout(timeoutMs) });
    // Drop the body so the connection closes now.
    await res.body?.cancel();
    return { ok: true, status: res.status };
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      return { ok: false, code: 'TIMEOUT', error: `no answer within ${timeoutMs / 1000}s` };
    }
    const cause = error?.cause;
    return { ok: false, code: cause?.code ?? null, error: cause?.message ?? error?.message ?? String(error) };
  }
}
