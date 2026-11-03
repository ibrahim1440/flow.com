import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";

/**
 * PATCH /api/sales/plan/items/:id { checked?, manualDone? } — the rep ticks one of their own checklist items, or enters
 * the progress of one of their CUSTOM goals (their own, or a management one set for them). Nothing else changes here.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const { id } = await params;
    const item = await prisma.salesPlanItem.findUnique({ where: { id }, select: { id: true, employeeId: true, kind: true, metric: true } });
    if (!item || item.employeeId !== user.id) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found." }, { status: 404 });
    const body = (await request.json().catch(() => ({}))) as { checked?: unknown; manualDone?: unknown };
    if (item.kind === "CHECK" && typeof body.checked === "boolean") {
      await prisma.salesPlanItem.update({ where: { id }, data: { checkedAt: body.checked ? new Date() : null } });
    } else if (item.kind === "GOAL" && item.metric === "CUSTOM" && body.manualDone !== undefined) {
      const n = Number(String(body.manualDone).replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: "الإنجاز رقم موجب.", errorEn: "Progress is a non-negative number." }, { status: 400 });
      await prisma.salesPlanItem.update({ where: { id }, data: { manualDone: Math.round(n * 100) / 100 } });
    } else {
      return NextResponse.json({ error: "ما يتعدّل هذا البند هنا.", errorEn: "This item cannot be changed here." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) { return handleDomainError(e); }
}
