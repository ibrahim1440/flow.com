/**
 * Ctrl K «فتحتها مؤخرًا» (batch 24 WP-A): the last 8 records this browser opened — a customer, a deal,
 * a quotation, a lead. Per device and per account (the key carries the account id); storage may be
 * unavailable (private window, blocked site data), in which case the list is simply empty.
 * Only what the viewer already opened is remembered, and opening it again still goes through the
 * record's own page and API, which re-check the access.
 */
export type RecentKind = "customer" | "deal" | "quote" | "lead";
export type RecentRecord = { kind: RecentKind; id: string; title: string; titleEn?: string; sub?: string | null; href: string; at?: number };

const KEY = "hq.recentRecords.v1";
export const RECENT_MAX = 8;
const EVENT = "hq-recent-change";

const keyOf = (uid: string) => `${KEY}.${uid}`;

function read(uid: string): RecentRecord[] {
  try {
    const raw = window.localStorage.getItem(keyOf(uid));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as RecentRecord[]).filter((r) => r && typeof r.id === "string" && typeof r.href === "string").slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

/** Newest first, one row per record. */
export function mergeRecent(list: RecentRecord[], r: RecentRecord, now = Date.now()): RecentRecord[] {
  return [{ ...r, at: now }, ...list.filter((x) => !(x.kind === r.kind && x.id === r.id))].slice(0, RECENT_MAX);
}

export function rememberRecent(uid: string | null | undefined, r: RecentRecord): void {
  if (typeof window === "undefined" || !uid) return;
  try {
    window.localStorage.setItem(keyOf(uid), JSON.stringify(mergeRecent(read(uid), r)));
    window.dispatchEvent(new Event(EVENT));
  } catch { /* storage unavailable */ }
}

export function readRecent(uid: string | null | undefined): RecentRecord[] {
  if (typeof window === "undefined" || !uid) return [];
  return read(uid);
}

export const RECENT_EVENT = EVENT;

/** Sign-out (council fix round 1): this device forgets every account's recent records — none outlives the session. */
export function clearRecent(): void {
  try {
    const ls = window.localStorage;
    for (let i = ls.length - 1; i >= 0; i--) { const k = ls.key(i); if (k && k.startsWith(`${KEY}.`)) ls.removeItem(k); }
    window.dispatchEvent(new Event(EVENT));
  } catch { /* storage unavailable: nothing to clear */ }
}
