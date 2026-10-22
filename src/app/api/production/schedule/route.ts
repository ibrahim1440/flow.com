import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { dayBoard } from "@/lib/services/schedule/schedule-db";
import { dayParam, requireScheduleView, scheduleError } from "@/lib/services/schedule/http";

/**
 * GET /api/production/schedule?date=YYYY-MM-DD — «جدول التحميص · اليوم» (RM6, Figma 399:2339): every
 * production roaster's lane for one Riyadh day (working window, maintenance, slots, recorded batches),
 * the coming slots with planned green beside the actual weights, and the day's counts. MISSED is
 * derived on read. The production module (read-only; ROASTERS.md §6) or the admin role.
 */
export async function GET(request: Request) {
  const { can, error } = await requireScheduleView();
  if (error) return error;
  const day = dayParam(new URL(request.url).searchParams.get("date"));
  if (!day) return NextResponse.json({ error: "تاريخ غير صالح.", errorEn: "Invalid date.", code: "INVALID_DATE" }, { status: 400 });
  try {
    return NextResponse.json({ ...(await dayBoard(prisma, day)), can });
  } catch (err) {
    return scheduleError(err);
  }
}
