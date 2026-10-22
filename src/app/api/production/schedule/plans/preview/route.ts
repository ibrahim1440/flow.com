import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { planPreview } from "@/lib/services/schedule/schedule-db";
import { readJson, requireScheduleView, scheduleError } from "@/lib/services/schedule/http";
import { parsePlanBody } from "@/lib/services/schedule/body";

/**
 * POST /api/production/schedule/plans/preview — «تخطيط الدفعات» (RM7, Figma 403:2650), read-only: the
 * inputs (§5.1), the target split against the proposed one and «البديل» (§5.2), the rules (§5.3–§5.6) and
 * the slots the plan would reserve (§5.4). Body: { productId, roasterId?, operatorId?, split?,
 * overrideGreenKg?, slots? }. Nothing is written.
 */
export async function POST(request: Request) {
  const { can, error } = await requireScheduleView();
  if (error) return error;
  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const req = parsePlanBody(body);
  if (req instanceof NextResponse) return req;
  try {
    return NextResponse.json({ ...(await planPreview(prisma, req)), can });
  } catch (err) {
    return scheduleError(err);
  }
}
