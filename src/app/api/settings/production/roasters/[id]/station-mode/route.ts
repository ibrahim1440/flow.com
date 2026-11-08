import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { readObject } from "@/lib/services/settings/http";
import { v2Run } from "@/lib/services/station/roast-v2-http";
import { setStationMode } from "@/lib/services/station/roast-v2";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/settings/production/roasters/[id]/station-mode {stationMode: "V1" | "V2"} — «طريقة المحطة» on the roaster's
 * settings page: the desk's switch (no station session, no station scope), for production › manage_roasters or the
 * admin role (through requireAdminAction with a step-up, as the roaster's other settings writes). The service keeps every guard (an open problem, V2 roasts not weighed, a V1 slot being roasted → 409 with
 * errorAr / errorEn) and writes AuthAuditLog ROASTER_STATION_MODE plus the roaster's change history.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role === "admin") {
    // The admin role (which holds every privilege by role): the admin-role gate, as the roaster's other settings writes
    // (a verified individual, a fresh step-up).
    const refused = await requireAdminAction(user, "settings.production", { stepUp: true });
    if (refused) return refused;
  } else if (!hasSubPrivilege(user.permissions, "production", "manage_roasters")) {
    return NextResponse.json({ error: "تغيير طريقة المحطة لمن يملك إدارة الحمّاصات.", errorEn: "Changing the station needs the roaster-management privilege.", code: "MANAGE_ROASTERS_REQUIRED" }, { status: 403 });
  }
  const { id } = await params;
  const { body, error: bodyErr } = await readObject(request);
  if (bodyErr) return bodyErr;
  const actor = { id: user.id, name: user.name, role: user.role, permissions: user.permissions, sessionId: user.sessionId ?? undefined, authTime: user.authTime, stationRoasterId: null };
  return v2Run(() => setStationMode(actor, id, body.stationMode, "desk"));
}
