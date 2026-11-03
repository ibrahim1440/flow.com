import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { PlanError, moveItem, riyadhIso } from "@/lib/services/sales/plans";

type Params = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "غير موجود.", errorEn: "Not found." }, { status: 404 });

/**
 * PATCH /api/sales/plan/items/:id { checked? | manualDone? | plannedDay? } — on an item of the caller's OWN plan (theirs or
 * one the supervisor put there): tick a free item, enter the progress of a custom number, or move an item to another day
 * («أجّلها»; null = «هالأسبوع»). A planned action is never ticked here — recording it is what makes it done.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const { id } = await params;
    const item = await prisma.salesPlanItem.findUnique({ where: { id }, select: { id: true, employeeId: true, kind: true, metric: true } });
    if (!item || item.employeeId !== user.id) return notFound();
    const body = (await request.json().catch(() => ({}))) as { checked?: unknown; manualDone?: unknown; plannedDay?: unknown };
    if (item.kind === "CHECK" && typeof body.checked === "boolean") {
      await prisma.salesPlanItem.update({ where: { id }, data: { checkedAt: body.checked ? new Date() : null } });
    } else if (item.kind === "GOAL" && item.metric === "CUSTOM" && body.manualDone !== undefined) {
      const n = Number(String(body.manualDone).replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: "الإنجاز رقم موجب.", errorEn: "Progress is a non-negative number." }, { status: 400 });
      await prisma.salesPlanItem.update({ where: { id }, data: { manualDone: Math.round(n * 100) / 100 } });
    } else if (item.kind !== "GOAL" && body.plannedDay !== undefined) {
      await prisma.$transaction((tx) => moveItem(tx, id, body.plannedDay ? String(body.plannedDay) : null, riyadhIso(new Date())));
    } else {
      return NextResponse.json({ error: "ما يتعدّل هذا البند هنا.", errorEn: "This item cannot be changed here." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof PlanError) return NextResponse.json({ error: e.ar, errorEn: e.message }, { status: e.status });
    return handleDomainError(e);
  }
}

/** DELETE /api/sales/plan/items/:id — the rep removes an item they put in their plan. What the supervisor put there stays. */
export async function DELETE(_request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const { id } = await params;
    const item = await prisma.salesPlanItem.findUnique({ where: { id }, select: { employeeId: true, source: true } });
    if (!item || item.employeeId !== user.id) return notFound();
    if (item.source !== "SELF") return NextResponse.json({ error: "هذا من المشرف، ما ينحذف.", errorEn: "Your supervisor put this here." }, { status: 403 });
    await prisma.salesPlanItem.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) { return handleDomainError(e); }
}
