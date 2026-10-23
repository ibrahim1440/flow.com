import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";
import { createStation, stationsOverview } from "@/lib/services/station/admin";

// Workstations W2 — «أجهزة المحطات» (Figma UR-14 607:4521 / 613:6626). The administrator role only.
// GET: the stations, their devices (active, pending, revoked), the station policy and the production
// roasters a roasting station may name. POST {name, type, place?, roasterId?}: adds a station (step-up).
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "stations.view");
  if (refused) return refused;
  try {
    return NextResponse.json(await stationsOverview(), noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "stations.create", { stepUp: true });
  if (refused) return refused;
  try {
    const s = await createStation(request, user, await body(request));
    return NextResponse.json({ id: s.id, name: s.name, type: s.type, place: s.place, roasterId: s.roasterId }, { status: 201, ...noStore });
  } catch (e) {
    return usersErrorResponse(e);
  }
}
