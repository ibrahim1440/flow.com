import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { todaySlotsFor } from "@/lib/services/schedule/schedule-db";
import { requireScheduleView, scheduleError } from "@/lib/services/schedule/http";

/**
 * GET /api/production/schedule/today?roasterId=…&mine=1 — today's live slots (Riyadh), optionally of one
 * roaster and / or of the signed-in operator. For the roasting station's queue (R1) after the station
 * branch is merged; read-only, the production module.
 */
export async function GET(request: Request) {
  const { user, error } = await requireScheduleView();
  if (error) return error;
  const sp = new URL(request.url).searchParams;
  try {
    const slots = await todaySlotsFor(prisma, { roasterId: sp.get("roasterId") ?? undefined, operatorId: sp.get("mine") === "1" ? user.id : undefined });
    return NextResponse.json({ slots });
  } catch (err) {
    return scheduleError(err);
  }
}
