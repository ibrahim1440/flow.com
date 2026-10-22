"use client";
import { createContext, useContext } from "react";
import type { Lang } from "@/lib/i18n/translations";
import type { Permissions } from "@/lib/auth-shared";

export type StationUser = { id: string; name: string; role: string; permissions: Permissions; preferredLanguage: Lang };
type Ctx = { user: StationUser; signOut: (reason?: string) => Promise<void> };
export const StationCtx = createContext<Ctx | null>(null);
export const useStation = () => useContext(StationCtx)!;

/** Station drafts live in sessionStorage only (D14); a sign-out leaves none behind for the next person. */
export function clearStationDrafts() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith("hq.station.")) sessionStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

export function loginUrl(reason?: string) {
  const next = typeof window !== "undefined" ? window.location.pathname : "/station/roasting";
  return `/login?next=${encodeURIComponent(next)}${reason ? `&reason=${reason}` : ""}`;
}

