import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { approvePlan, scheduleCan } from "@/lib/services/schedule/schedule-db";
import { actorOf, readJson, scheduleError } from "@/lib/services/schedule/http";
import { parsePlanBody } from "@/lib/services/schedule/body";

/**
 * POST /api/production/schedule/plans — «اعتماد الخطة» (RM7). production › manage_schedule (ROASTERS.md §6;
 * never a role default). Body: the preview's, plus expectedGreenKg (the «الأخضر للتخطيط» the planner saw;
 * 409 PLAN_STALE if it moved) and reason (required for a quantity decision, §5.3). One transaction under
 * the schedule lock: the preview is recomputed and every slot re-checked — limits, nominal, working hours,
 * maintenance, the operator assigned to the roaster (422 OPERATOR_NOT_ASSIGNED), machine and operator
 * overlap (409 SLOT_CONFLICT). Reserves slots only: no batch, no stock movement, no order change (§5.9).
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("production", "manage_schedule");
  if (error) return error;
  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const req = parsePlanBody(body);
  if (req instanceof NextResponse) return req;
  if (typeof body.expectedGreenKg !== "string") return NextResponse.json({ error: "أرسل الأخضر للتخطيط كما ظهر.", errorEn: "Give expectedGreenKg as shown.", code: "INVALID_BODY" }, { status: 400 });
  try {
    const out = await prisma.$transaction((tx) => approvePlan(tx, { ...req, expectedGreenKg: body.expectedGreenKg as string, reason: typeof body.reason === "string" ? body.reason : null }, actorOf(user, scheduleCan(user))), TX_OPTS);
    return NextResponse.json(out, { status: 201 });
  } catch (err) {
    return scheduleError(err);
  }
}
