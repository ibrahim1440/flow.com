/**
 * «كم محل زرت؟» — what this tab knows about a field round's count between a save and the plan's next reload
 * (the plan-d17 race, 10 Nov 2026; D20.1 gate L1).
 *
 *   · only a CONFIRMED save (2xx) is remembered, with the server value the sheet was opened on (`base`);
 *   · a sheet opened before the plan has reloaded — the list still shows `base` — opens on the confirmed count;
 *     once the list shows anything else (it reloaded, or someone else changed it), the server's value wins;
 *   · a failed save is remembered too, so the sheet says it when opened again (on the server's value); the next
 *     change sends again;
 *   · cleared at sign-out (dashboard/layout handleLogout), so the next person in the same tab inherits nothing.
 */
type Confirmed = { count: number; base: number; seq: number };
/** How a save ended: `latest` — no newer save of the round was sent meanwhile (only the latest answer counts). */
export type SaveEnd = { ok: boolean; latest: boolean; count: number };
type Pending = { count: number; base: number; seq: number; done: Promise<SaveEnd> };
const confirmed = new Map<string, Confirmed>();
const pending = new Map<string, Pending>();
const failed = new Map<string, number>();
/** Per round: the sequence number of the last save sent, and its count (D20.1 R2-L2 — answers can come back out of order). */
const issued = new Map<string, { seq: number; count: number }>();
let nextSeq = 0;

/** The count a round's sheet opens on, given what the plan list shows for it now: a save still on its way (it is
 *  waited for, `roundPending`), else a confirmed one, while the list still shows the value it was made over. */
export function roundOpenValue(id: string, server: number | null | undefined): number {
  const s = server ?? 0;
  const p = pending.get(id);
  if (p && p.base === s) return p.count;
  const c = confirmed.get(id);
  return c && c.base === s ? c.count : s;
}

/** The save of this round still on its way, if any — a sheet opened on it learns how it ended. */
export const roundPending = (id: string): Pending | null => pending.get(id) ?? null;

/** The count of the last save sent for this round (in flight or answered), if any. */
export const roundLastSent = (id: string): number | null => issued.get(id)?.count ?? null;

/**
 * Track a save. It is the round's pending value until the server answers; only the answer to the LATEST save sent
 * counts — an older one landing late (a failure after a newer success, or after newer taps) changes nothing: it
 * neither confirms, nor fails, nor reverts.
 */
export function trackRoundSave(id: string, count: number, base: number, send: () => Promise<boolean>): Promise<SaveEnd> {
  const seq = ++nextSeq;
  issued.set(id, { seq, count });
  const done: Promise<SaveEnd> = send().catch(() => false).then((ok) => {
    const latest = issued.get(id)?.seq === seq;
    if (pending.get(id)?.seq === seq) pending.delete(id);
    if (latest) {
      if (ok) { if ((confirmed.get(id)?.seq ?? 0) < seq) confirmRoundSave(id, count, base, seq); }
      else { failRoundSave(id, count); issued.delete(id); } // R3-L1: a count that failed is not «already sent»
    } else if (ok && (confirmed.get(id)?.seq ?? 0) < seq) {
      // An older save that went through is still the server's latest known count until the newer one answers.
      confirmed.set(id, { count, base, seq });
    }
    return { ok, latest, count };
  });
  pending.set(id, { count, base, seq, done });
  return done;
}

/** A count that did not reach the server (null when the last save went through). */
export const roundFailedCount = (id: string): number | null => failed.get(id) ?? null;

export function confirmRoundSave(id: string, count: number, base: number, seq = ++nextSeq): void {
  confirmed.set(id, { count, base, seq });
  failed.delete(id);
}

export function failRoundSave(id: string, count: number): void {
  failed.set(id, count);
}

/** Sign-out: nothing of this person's counts survives in the tab. */
export function clearRoundCounts(): void {
  confirmed.clear();
  pending.clear();
  failed.clear();
  issued.clear();
}
