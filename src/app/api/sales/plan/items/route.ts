import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { PlanError, addItem, riyadhIso } from "@/lib/services/sales/plans";

/**
 * POST /api/sales/plan/items { kind: ACTION|CHECK, metric?, customerId?, plannedDay?, label?, date? } — the rep puts one
 * item in their OWN plan («خطّط بند»): a visit, a call, a quotation, a collection or a sample for a customer of theirs,
 * or a free item. It is done when the rep records it (services/sales/plans.ts `matchPlan`), never ticked by hand.
 */
export async function POST(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.customerId === "string" && body.customerId && !(await customerInScope(user, body.customerId))) {
      return NextResponse.json({ error: "العميل غير موجود.", errorEn: "Customer not found." }, { status: 404 });
    }
    const row = await prisma.$transaction((tx) => addItem(tx, { employeeId: user.id, actorId: user.id, source: "SELF" }, body, riyadhIso(new Date())));
    return NextResponse.json({ ok: true, id: row.id }, { status: 201 });
  } catch (e) {
    if (e instanceof PlanError) return NextResponse.json({ error: e.ar, errorEn: e.message }, { status: e.status });
    return handleDomainError(e);
  }
}
