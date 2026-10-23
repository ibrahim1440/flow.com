import { NextResponse } from "@/lib/api-response";
import { readRoastRequestKey } from "@/lib/services/roast-idempotency";
import { requireStationContext } from "./guard";
import { runAsStationActor } from "@/lib/auth/station-delegate";
import type { SessionUser } from "@/lib/auth-server";
import type { StationTab } from "@/lib/station/device";

/**
 * Every roasting-station API. On a paired station device (Workstations W2): the device, the station
 * session bound to it, the station assignment, production › start_batch and never a privileged key
 * (./guard.ts, H8). Off a device: the W1 personal ERP session and production › start_batch, the
 * sub-privilege «تسجيل دفعة» itself requires — unchanged. The server computes everything; the
 * station sends raw inputs only. `station` is the device's station (null for a personal session):
 * its roaster is the only roaster the device works on.
 */
export async function requireStation() {
  return requireStationContext("ROASTING");
}

/** Station writes must carry an Idempotency-Key (S6: the status of an interrupted write is asked by key). */
export function requiredKey(request: Request): { key: string; error: null } | { key: null; error: NextResponse } {
  const r = readRoastRequestKey(request);
  if (!r.ok) return { key: null, error: NextResponse.json({ error: r.message, errorEn: r.en }, { status: 400 }) };
  if (!r.key) return { key: null, error: NextResponse.json({ error: "مفتاح التكرار مطلوب لكل إجراء من المحطة.", errorEn: "An Idempotency-Key is required for every station action.", code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 }) };
  return { key: r.key, error: null };
}

/**
 * Workstations W4 — every packaging-station API: the same guard with the tab's own privilege
 * («التعبئة»: packaging at edit; «تجهيز الطلبات»: dispatch at edit). Without a tab (the station's own
 * reads) either one. Off a device: the personal ERP session with the same privilege.
 */
export async function requirePackagingStation(tab?: StationTab) {
  return requireStationContext("PACKAGING", tab);
}

/**
 * Run an ERP handler for the station (single source: the station never re-implements it). A
 * personal session calls it as it is (it runs its own guard on the ERP session); a paired device
 * runs it as the guarded station employee (runAsStationActor) — the ERP route itself still refuses
 * any STATION session sent to it over HTTP.
 */
export async function asStation<T>(ctx: { mode: "device" | "personal"; user: SessionUser }, fn: () => Promise<T>): Promise<T> {
  if (ctx.mode === "device") return runAsStationActor(ctx.user as SessionUser & { scope: "STATION" }, fn);
  return fn();
}
