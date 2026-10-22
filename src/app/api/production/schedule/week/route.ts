import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { weekView } from "@/lib/services/schedule/schedule-db";
import { dayParam, requireScheduleView, scheduleError } from "@/lib/services/schedule/http";

/**
 * GET /api/production/schedule/week?from=YYYY-MM-DD&days=3&lane=YYYY-MM-DD — «المحامص والأسبوع»
 * (RM8, Figma 407:3005): load per production roaster and day (booked / available slots), the lanes of
 * one day side by side, operator conflicts among live slots, and the green distribution per coffee.
 * Lanes are every production roaster in service — one lane with one roaster; nothing is invented.
 */
export async function GET(request: Request) {
  const { can, error } = await requireScheduleView();
  if (error) return error;
  const sp = new URL(request.url).searchParams;
  const from = dayParam(sp.get("from"));
  const lane = dayParam(sp.get("lane") ?? from);
  const days = Math.min(7, Math.max(1, Number(sp.get("days") ?? 3) || 3));
  if (!from || !lane) return NextResponse.json({ error: "تاريخ غير صالح.", errorEn: "Invalid date.", code: "INVALID_DATE" }, { status: 400 });
  try {
    return NextResponse.json({ ...(await weekView(prisma, from, days, lane)), can });
  } catch (err) {
    return scheduleError(err);
  }
}
