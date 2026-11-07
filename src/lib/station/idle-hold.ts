/**
 * D12 R11 / gate R2-1 — the idle lock may be held (a roast in the drum, a basket waiting for the scale, writes waiting to
 * be sent), but never for ever: a hold lasts at most HOLD_CAP_FACTOR × the station's idle policy since the last touch.
 * Past the cap the lock proceeds as usual; queued writes stay bound to their employee and go when they sign in again.
 */
export const HOLD_CAP_FACTOR = 3;

/** On an idle timeout: lock now, or re-arm for `inMs` (held and still under the cap). */
export function idleDecision(held: boolean, sinceActivityMs: number, idleMs: number): { lock: true } | { lock: false; inMs: number } {
  const cap = HOLD_CAP_FACTOR * idleMs;
  if (!held || sinceActivityMs >= cap) return { lock: true };
  return { lock: false, inMs: Math.max(1_000, Math.min(idleMs, cap - sinceActivityMs)) };
}
