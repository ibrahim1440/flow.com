import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";
import { setDeviceStations } from "@/lib/services/station/admin";

// PUT {stationIds} — «يخدم أيضًا» (Workstations W3): the other stations this device may serve (the
// same iPad at the roaster and in QC). The device asks which station before the employee; the
// session is bound to the choice. The administrator role, step-up. Removing a link ends the
// device's sessions on that station.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "stations.device_stations", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  try {
    return NextResponse.json(await setDeviceStations(request, user, id, await body(request)), noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}
