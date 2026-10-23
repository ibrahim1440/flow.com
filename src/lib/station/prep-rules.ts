// Workstations W4 — the pure rules of the packaging station (no database, no server): the order's
// state at the preparation tab (the order STATUS wins, src/lib/order-stage.ts), whether a claim is
// live, and how far the packaging-material shelf goes. Shared by the services and the unit tests.
import { statusOverride } from "@/lib/order-stage";

export type PrepOrderState = "hold" | "ready" | "preparing" | "prepared" | "partial" | "waiting" | "handed";
export type PrepTotals = { outstanding: number; prepared: number; picked: number; handedOff: number; remaining: number; readyToPick: number; waiting: number };

/** A live claim: ACTIVE and not past its expiry («إبقاء … لي» ends by itself). */
export function claimLive(c: { status: string; expiresAt: Date | null }, now = Date.now()): boolean {
  return c.status === "ACTIVE" && (!c.expiresAt || c.expiresAt.getTime() > now);
}

/** The order's state at the station, by the owner's rule: the status first, then the lines. */
export function prepState(status: string, t: PrepTotals, hasClaim: boolean): PrepOrderState {
  if (statusOverride(status) === "hold") return "hold";
  if (t.remaining === 0 && t.picked > 0) return "prepared";
  if (t.remaining === 0 && t.handedOff > 0) return "handed";
  if (t.remaining > 0 && (hasClaim || t.picked > 0)) return "preparing";
  if (t.remaining > 0 && t.readyToPick >= t.remaining) return "ready";
  if (t.readyToPick > 0) return "partial";
  return "waiting";
}

/**
 * How many packages the material shelf allows, from the server preview's own figures (required for
 * `packages`, available): min over the materials of ⌊available ÷ per package⌋. Pure.
 */
export function maxPackagesFor(packages: number, materials: readonly { required: number; available: number }[]): number {
  if (!(packages > 0)) return 0;
  let max = packages;
  for (const m of materials) {
    const per = m.required / packages;
    if (per > 0) max = Math.min(max, Math.floor((m.available + 1e-9) / per));
  }
  return Math.max(0, max);
}

/** P5 / the notification: the first material short in a server preview, or null. */
export function firstShortage(materials: readonly { label: string; required: number; available: number; missing: number; materialItemId: string }[]) {
  const m = materials.find((x) => x.missing > 0);
  return m ? { materialItemId: m.materialItemId, material: m.label, required: m.required, available: m.available } : null;
}
