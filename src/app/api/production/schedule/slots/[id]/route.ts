import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { moveSlot } from "@/lib/services/schedule/schedule-db";
import { readJson, scheduleError } from "@/lib/services/schedule/http";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/production/schedule/slots/[id] — move a planned (or missed) slot and / or give it to another
 * operator («نقل الخانة» / «إسناد إلى …», RM8). Body: { startsAt?, operatorId? }. production ›
 * manage_schedule. Re-checked like a new slot in one transaction: future, working hours, maintenance,
 * the operator assigned to the roaster (422), machine and operator overlap (409 SLOT_CONFLICT).
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("production", "manage_schedule");
  if (error) return error;
  const { id } = await params;
  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const startsAt = typeof body.startsAt === "string" ? body.startsAt : undefined;
  const operatorId = typeof body.operatorId === "string" && body.operatorId ? body.operatorId : undefined;
  if (!startsAt && !operatorId) return NextResponse.json({ error: "حدّد الوقت أو المشغّل.", errorEn: "Give startsAt or operatorId.", code: "INVALID_BODY" }, { status: 400 });
  try {
    const row = await prisma.$transaction((tx) => moveSlot(tx, id, { startsAt, operatorId }, { id: user.id, name: user.name }), TX_OPTS);
    return NextResponse.json({ slot: { id: row.id, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), operatorId: row.operatorId } });
  } catch (err) {
    return scheduleError(err);
  }
}
