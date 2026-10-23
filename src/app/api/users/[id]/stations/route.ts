import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireAdminAction, requireModule } from "@/lib/auth-server";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";
import { setUserStations, userStations } from "@/lib/services/station/admin";

// UR-13 «محطات العمل» (Figma 601:1344 / 610:5512). GET — any holder of «إدارة المستخدمين» (as the
// profile): per active station, allowed, supervisor, the module privilege it needs and «الآن» (can
// sign in, or why not: no station PIN UR-S18, no module privilege UR-S17, locked, the admin role).
// PUT {stations: [{stationId, allowed, supervisor}], reason?} — the administrator role, step-up; never
// one's own; never the admin role (D12). Removing access ends a live session at that station.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireModule("employees");
  if (error) return error;
  const { id } = await params;
  try {
    const r = await userStations(id);
    if (!r) return NextResponse.json({ error: "المستخدم غير موجود.", errorEn: "User not found." }, { status: 404 });
    return NextResponse.json(r, noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "users.stations", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  try {
    return NextResponse.json(await setUserStations(request, user, id, await body(request)), noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}
