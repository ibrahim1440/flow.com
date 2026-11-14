// P2 ب9 / UXM-02 (owner decision, approved Figma 7أ/7ب): an unsaved direct sale, sample or lead form is kept on THIS device
// (localStorage) so a slip — a tab tap, a closed tab — does not lose it.
//   · kept 24 hours from its last change, then dropped unread;
//   · gate R1 (B1): the key names its USER (hq-draft:<userId>:<form>) and the stored draft carries it — a draft is
//     restored only to the person who wrote it;
//   · removed at EVERY sign-out (clearAllDrafts): the menu, the idle guard, the shell/station sign-out buttons, and the
//     login page itself (every expiry / revocation / idle path ends there), so the next person on a shared phone never
//     sees it;
//   · never the receipt image (the callers pass only text fields).
// Pure helpers over a Storage — the unit tests pass a fake one. Every access is guarded: a private window or a full
// storage just means no draft.
export const DRAFT_PREFIX = "hq-draft:";
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

type Stored<T> = { v: 1; at: number; user: string; data: T };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function store(s?: Store | null): Store | null {
  if (s) return s;
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** The storage key of `user`'s draft of form `name` (no user → no draft at all). */
export const draftKey = (user: string, name: string) => `${DRAFT_PREFIX}${user}:${name}`;

export function saveDraft<T>(user: string | null | undefined, name: string, data: T, now = Date.now(), s?: Store | null): void {
  const st = store(s);
  if (!st || !user) return;
  try { st.setItem(draftKey(user, name), JSON.stringify({ v: 1, at: now, user, data } satisfies Stored<T>)); } catch { /* full / blocked: no draft */ }
}

/** The draft, or null when there is none, it is unreadable, or it is older than 24 hours (then it is removed). */
/** `user`'s draft, or null when there is none, it is unreadable, someone else's, or older than 24 hours (then removed). */
export function loadDraft<T>(user: string | null | undefined, name: string, now = Date.now(), s?: Store | null): { at: number; data: T } | null {
  const st = store(s);
  if (!st || !user) return null;
  const key = draftKey(user, name);
  try {
    const raw = st.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as Stored<T>;
    if (!p || p.v !== 1 || p.user !== user || typeof p.at !== "number" || now - p.at > DRAFT_TTL_MS || now < p.at - 60_000) { st.removeItem(key); return null; }
    return { at: p.at, data: p.data };
  } catch {
    try { st.removeItem(key); } catch { /* ignore */ }
    return null;
  }
}

export function clearDraft(user: string | null | undefined, name: string, s?: Store | null): void {
  const st = store(s);
  if (!st || !user) return;
  try { st.removeItem(draftKey(user, name)); } catch { /* ignore */ }
}

/** Sign-out (any path): every draft of this device goes — every user's, and the pre-R1 unkeyed ones. */
export function clearAllDrafts(s?: Store | null): void {
  const st = store(s);
  if (!st) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k && k.startsWith(DRAFT_PREFIX)) keys.push(k); }
    for (const k of keys) st.removeItem(k);
  } catch { /* ignore */ }
}
