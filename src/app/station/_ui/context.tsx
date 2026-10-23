"use client";
import { createContext, useContext } from "react";
import type { Lang } from "@/lib/i18n/translations";
import type { Permissions } from "@/lib/auth-shared";

export type StationUser = { id: string; name: string; role: string; permissions: Permissions; preferredLanguage: Lang };
/** A paired station device (Workstations W2): its station, as GET /api/station/device returns it. */
export type StationInfo = { id: string; name: string; type: string; place: string | null; roaster: { id: string; name: string; status: string } | null; home: string | null };
type Ctx = {
  user: StationUser;
  /** W1: the personal ERP session at a browser; W2: a station session on a paired device. */
  mode: "personal" | "device";
  station: StationInfo | null;
  /** Personal: sign out of the ERP. Device: the station session ended (back to the tiles). */
  signOut: (reason?: string) => Promise<void>;
  /** «قفل»: personal → sign out; device → S4 for this employee. */
  lock: () => Promise<void>;
  /** «تبديل الموظف»: personal → sign out; device → S5 (the handover of an active task). */
  switchEmployee: () => void;
};
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

export function loginUrl(reason?: string, next?: string) {
  const path = next ?? (typeof window !== "undefined" ? window.location.pathname : "/station/roasting");
  return `/login?next=${encodeURIComponent(path === "/station" ? "/station/roasting" : path)}${reason ? `&reason=${reason}` : ""}`;
}
