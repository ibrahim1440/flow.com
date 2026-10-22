import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { affectedSlots } from "@/lib/services/schedule/schedule-db";
import { requireScheduleView, scheduleError } from "@/lib/services/schedule/http";

/**
 * GET /api/production/schedule/impact?roasterId=… — the planned slots a status change of this roaster
 * from now would return to the work queue (RM4b «N خانات مخططة تتأثر · أول 3»). Read-only.
 */
export async function GET(request: Request) {
  const { error } = await requireScheduleView();
  if (error) return error;
  const roasterId = new URL(request.url).searchParams.get("roasterId");
  if (!roasterId) return NextResponse.json({ error: "حدّد المحمصة.", errorEn: "Give roasterId.", code: "INVALID_QUERY" }, { status: 400 });
  try {
    return NextResponse.json(await affectedSlots(prisma, roasterId));
  } catch (err) {
    return scheduleError(err);
  }
}
