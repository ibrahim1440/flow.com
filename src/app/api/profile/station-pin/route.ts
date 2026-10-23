import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { isAdminRole } from "@/lib/station/access";
import { setOwnStationPin } from "@/lib/services/station/pin";

// Workstations W2 — «رمز المحطة» in «ملفي» (the existing self-set PIN flow, re-pointed to the
// station PIN; J-6: the person sets it, the administrator never sees or issues one).
//
// GET — whether a station PIN is set, when, whether it is locked on a device (D7), and the stations
// the person may sign in at (UR-13), so the profile can say where it works.
// PUT {currentPin?, newPin} — sets or changes it. Changing needs the current station PIN; setting the
// first one (or after the administrator's reset, UR-04) needs a recent PASSWORD step-up instead (the
// identity check, UR-S18). Six digits; NOT unique across employees and never looked up (J-2): it is
// checked only against the employee chosen on the station's tiles. Never the admin role (D12).
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  const [pin, stations] = await Promise.all([
    prisma.stationPin.findUnique({ where: { employeeId: user.id }, select: { setAt: true, attempts: { where: { lockedAt: { not: null } }, select: { lockedAt: true } } } }),
    prisma.stationAssignment.findMany({ where: { employeeId: user.id, station: { status: "ACTIVE" } }, select: { station: { select: { name: true } } } }),
  ]);
  return NextResponse.json({
    set: !!pin, setAt: pin?.setAt.toISOString() ?? null, locked: (pin?.attempts.length ?? 0) > 0,
    stations: stations.map((s) => s.station.name), admin: isAdminRole((await prisma.employee.findUnique({ where: { id: user.id }, select: { role: true } }))?.role),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  return setOwnStationPin(request, user);
}
