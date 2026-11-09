import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { PlanError, addItem, addItems, riyadhIso } from "@/lib/services/sales/plans";

/**
 * POST /api/sales/plan/items { kind: ACTION|CHECK, metric?, customerId?, plannedDay?, plannedTime?, label?, date? } — the rep
 * puts one thing in their OWN plan («أضف لخطتي»), or { items: [...] } several («خطّط أسبوعك»): a visit, a call, a quotation, a collection or a sample for a customer of theirs,
 * or a free item. It is done when the rep records it (services/sales/plans.ts `matchPlan`), never ticked by hand.
 */
export async function POST(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // D16 «خطّط أسبوعك › ثبّت خطتي»: { items: [...] } adds several at once (a twin is skipped, not refused).
    if (Array.isArray(body.items)) {
      const list = body.items as Record<string, unknown>[];
      for (const it of list) {
        if (it && typeof it.customerId === "string" && it.customerId && !(await customerInScope(user, it.customerId))) {
          return NextResponse.json({ error: "العميل غير موجود.", errorEn: "Customer not found." }, { status: 404 });
        }
      }
      const out = await prisma.$transaction((tx) => addItems(tx, { employeeId: user.id, actorId: user.id, source: "SELF" }, list, riyadhIso(new Date())));
      return NextResponse.json({ ok: true, ...out }, { status: 201 });
    }
    if (typeof body.customerId === "string" && body.customerId && !(await customerInScope(user, body.customerId))) {
      return NextResponse.json({ error: "العميل غير موجود.", errorEn: "Customer not found." }, { status: 404 });
    }
    const row = await prisma.$transaction((tx) => addItem(tx, { employeeId: user.id, actorId: user.id, source: "SELF" }, body, riyadhIso(new Date())));
    return NextResponse.json({ ok: true, id: row.id }, { status: 201 });
  } catch (e) {
    if (e instanceof PlanError) return NextResponse.json({ error: e.ar, errorEn: e.message, code: e.code }, { status: e.status });
    return handleDomainError(e);
  }
}
