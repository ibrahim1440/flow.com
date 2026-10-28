import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";
import { updateStation } from "@/lib/services/station/admin";

// PATCH {name?, place?, roasterId?, locationId?, status?: "ACTIVE" | "RETIRED", reason?} — edit or retire a station
// (locationId, 20261117090000: where it draws from and books into; null = the production site)
// (a retired station's devices are refused and its sessions end). The administrator role, step-up.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "stations.update", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  try {
    const s = await updateStation(request, user, id, await body(request));
    return NextResponse.json({ id: s.id, name: s.name, place: s.place, roasterId: s.roasterId, locationId: s.locationId, status: s.status }, noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}
