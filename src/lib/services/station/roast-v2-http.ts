import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { readRoastRequestKey } from "@/lib/services/roast-idempotency";
import type { V2Actor } from "./roast-v2";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

/**
 * Roasting station v2 — the HTTP layer of /api/station/roasting/v2/* (P0: the data core; the screens come with D12).
 * Every route runs the station guard first (a paired device, or the personal ERP session, with production › start_batch —
 * requireStation, the station's own rule); a supervisor's actions (a discard's review, a spill's write-off, the discard
 * list) and the roaster's flag then need the ERP sub-privilege too. Every write carries an Idempotency-Key where the service needs one.
 */
export type V2Ctx = { actor: V2Actor; stationRoasterId: string | null };
type GuardUser = { id: string; name: string; role: string; permissions: Permissions; sessionId?: string | null; authTime?: Date | string };

/** The floor's context, after the route's own `await requireStation()` (the guard stays the route's first statement). */
export function v2Floor(user: GuardUser, station: { roasterId: string | null } | null | undefined): V2Ctx {
  const stationRoasterId = station?.roasterId ?? null;
  return { actor: { ...actorOf(user), stationRoasterId }, stationRoasterId };
}

/** A supervisor's action: after the station guard, the ERP sub-privilege too (403 otherwise). */
export function v2Supervisor(user: GuardUser, sub: "manage_schedule" | "manage_roasters", station?: { roasterId: string | null } | null): { ctx: V2Ctx; error: null } | { ctx: null; error: NextResponse } {
  if (!hasSubPrivilege(user.permissions, "production", sub)) {
    return { ctx: null, error: NextResponse.json({ error: "هذا الإجراء للمشرف.", errorEn: "This action is a supervisor's.", code: "SUPERVISOR_REQUIRED" }, { status: 403 }) };
  }
  // On a paired device the supervisor is bound to the device's roaster too (L1); at the desk (no device) nothing changes.
  const stationRoasterId = station?.roasterId ?? null;
  return { ctx: { actor: { ...actorOf(user), stationRoasterId }, stationRoasterId }, error: null };
}

export function actorOf(user: GuardUser): V2Actor {
  // D16: the station assignment's «مشرف» flag (a paired device's StationActor) makes a report supervisor.
  const supervisor = (user as { supervisor?: unknown }).supervisor === true;
  return { id: user.id, name: user.name, role: user.role, permissions: user.permissions, sessionId: user.sessionId ?? undefined, authTime: user.authTime, supervisor };
}

/** The Idempotency-Key header (or null — the service refuses a missing key where it needs one). */
export function v2Key(request: Request): string | null {
  const r = readRoastRequestKey(request);
  return r.ok ? r.key : null;
}

export async function v2Body(request: Request): Promise<Record<string, unknown>> {
  const b = await request.json().catch(() => ({}));
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

/** A service result, or its coded refusal with every fact it carries (e.g. `unweighed` on BASKET_NEEDS_WEIGHING). */
export async function v2Run<T>(fn: () => Promise<T>, okStatus = 200, created?: (r: T) => boolean): Promise<NextResponse> {
  try {
    const r = await fn();
    return NextResponse.json(r, { status: created && created(r) ? 201 : okStatus, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err && typeof err === "object" && "_appCode" in err && "errorEn" in err) {
      const { _appCode, message, ...rest } = err as unknown as { _appCode: number; message: string } & Record<string, unknown>;
      return NextResponse.json({ error: message, ...rest }, { status: _appCode, headers: { "Cache-Control": "no-store" } });
    }
    return handleDomainError(err);
  }
}
