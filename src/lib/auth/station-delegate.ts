// Workstations W2 — the in-process hand-over from a station route to an existing ERP handler.
//
// The ERP APIs refuse a STATION session (src/lib/auth/session.ts checkSession, and the scope check
// in getUserWithPermissions). The roasting station still records a roast through the one roast
// POST the ERP uses (idempotency, capacity, operators, schedule — one implementation, H7/H12). So
// the station route /api/station/roasting/record runs the WHOLE station guard first
// (src/lib/services/station/guard.ts: device → station session bound to that device → station
// access → module privilege → never a privileged key) and then calls the ERP handler inside
// runAsStationActor: for that call only, getUserWithPermissions answers with the guarded station
// employee (privileged keys stripped, never the admin role — D12). Nothing outside that call sees
// it (AsyncLocalStorage is per async context), and no token or header can set it.
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionUser } from "@/lib/auth-server";
import { isAdminRole } from "@/lib/station/access";

const store = new AsyncLocalStorage<SessionUser>();

export function runAsStationActor<T>(actor: SessionUser & { scope: "STATION" }, fn: () => Promise<T>): Promise<T> {
  if (isAdminRole(actor.role) || actor.privileged) throw new Error("runAsStationActor: a station actor is never the admin role or privileged.");
  return store.run(actor, fn);
}

export function stationDelegate(): SessionUser | null {
  return store.getStore() ?? null;
}
