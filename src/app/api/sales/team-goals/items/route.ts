import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { PlanError, addItem, riyadhIso } from "@/lib/services/sales/plans";

/**
 * POST /api/sales/team-goals/items { employeeId, kind, metric?, customerId?, plannedDay?, label? } — the supervisor
 * (sales › lead_assign) puts an action or a free item in a rep's plan. The rep sees it marked «من المشرف · <name>» and
 * cannot delete it; it is done the same way as the rep's own (by the rep recording it).
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("sales", "lead_assign");
  if (error) return error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const rep = typeof body.employeeId === "string" ? await prisma.employee.findFirst({ where: { id: body.employeeId, active: true }, select: { id: true } }) : null;
    if (!rep) return NextResponse.json({ error: "المندوب غير موجود.", errorEn: "Rep not found." }, { status: 404 });
    const row = await prisma.$transaction((tx) => addItem(tx, { employeeId: rep.id, actorId: user.id, source: "ADMIN" }, body, riyadhIso(new Date())));
    return NextResponse.json({ ok: true, id: row.id }, { status: 201 });
  } catch (e) {
    if (e instanceof PlanError) return NextResponse.json({ error: e.ar, errorEn: e.message, code: e.code }, { status: e.status });
    return handleDomainError(e);
  }
}
