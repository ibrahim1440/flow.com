"use client";
// «مساحة عملي» — the badge, fetched at most once a minute per tab and shared by the sidebar and the
// workspace tabs (one request, not one per component or per navigation). Fails quietly.
import { useEffect, useState } from "react";

export type WsBadge = { count: number; tasks: number; approvals: number; hasTeam?: boolean };

const MIN_GAP = 60_000;
let last: WsBadge | null = null;
let lastAt = 0;
let inflight: Promise<WsBadge | null> | null = null;

export function loadWsBadge(): Promise<WsBadge | null> {
  if (Date.now() - lastAt < MIN_GAP) return Promise.resolve(last);
  if (inflight) return inflight;
  inflight = fetch("/api/workspace/badge", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((b: WsBadge | null) => { if (b && typeof b.count === "number") { last = b; lastAt = Date.now(); } return last; })
    .catch(() => last)
    .finally(() => { inflight = null; });
  return inflight;
}

/** The badge, refreshed on `key` change (a navigation) and every two minutes, never more than once a minute. */
export function useWsBadge(enabled: boolean, key?: string): WsBadge | null {
  const [b, setB] = useState<WsBadge | null>(last);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => void loadWsBadge().then((v) => { if (alive) setB(v); });
    load();
    const t = setInterval(load, 120_000);
    return () => { alive = false; clearInterval(t); };
  }, [enabled, key]);
  return b;
}
