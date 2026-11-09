import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { PlanError, moveItem, removeItem, riyadhIso } from "@/lib/services/sales/plans";
import { markPlanMeeting } from "@/lib/workspace/server/appointments";

type Params = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "غير موجود.", errorEn: "Not found." }, { status: 404 });

/**
 * PATCH /api/sales/plan/items/:id { checked? | manualDone? | plannedDay? (+ plannedTime?) } — on an item of the caller's OWN plan (theirs or
 * one the supervisor put there): tick a free item, enter the progress of a custom number, or move an item to another day
 * («أجّلها»; null = «هالأسبوع»). A planned action is never ticked here — recording it is what makes it done.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const { id } = await params;
    const item = await prisma.salesPlanItem.findUnique({ where: { id }, select: { id: true, employeeId: true, kind: true, metric: true, category: true, appointmentId: true } });
    if (!item || item.employeeId !== user.id) return notFound();
    const body = (await request.json().catch(() => ({}))) as { checked?: unknown; manualDone?: unknown; plannedDay?: unknown; plannedTime?: unknown; shopsVisited?: unknown };
    // D16: a free item, or a planned sample («وش صار؟ › أرسلتها» — handed over in person, no shipment record), is ticked here.
    if ((item.kind === "CHECK" || (item.kind === "ACTION" && item.metric === "SAMPLES")) && typeof body.checked === "boolean") {
      // D17: a field round's outcome — «كم محل زرت؟» — comes with its tick («خلصت الجولة»).
      let shopsVisited: number | null | undefined;
      if (item.category === "FIELD_ROUND" && body.shopsVisited !== undefined) {
        const n = body.shopsVisited === null || body.shopsVisited === "" ? null : Number(body.shopsVisited);
        if (n !== null && (!Number.isInteger(n) || n < 0 || n > 999)) return NextResponse.json({ error: "عدد المحلات من 0 إلى 999.", errorEn: "Shops visited: 0–999." }, { status: 400 });
        shopsVisited = n;
      }
      const checked = body.checked;
      await prisma.$transaction(async (tx) => {
        await tx.salesPlanItem.update({ where: { id }, data: { checkedAt: checked ? new Date() : null, ...(shopsVisited !== undefined ? { shopsVisited } : {}) } });
        // D17: the rep's own invited meeting is DONE for the colleagues too (and open again on «تراجع»).
        if (item.appointmentId) await markPlanMeeting(tx, user.id, item.appointmentId, checked);
      });
    } else if (item.category === "FIELD_ROUND" && body.shopsVisited !== undefined && body.checked === undefined) {
      // D17 (Abu Fahd): «كم محل زرت؟» is kept as the rep counts — closing the sheet or a reload loses nothing.
      const n = body.shopsVisited === null || body.shopsVisited === "" ? null : Number(body.shopsVisited);
      if (n !== null && (!Number.isInteger(n) || n < 0 || n > 999)) return NextResponse.json({ error: "عدد المحلات من 0 إلى 999.", errorEn: "Shops visited: 0–999." }, { status: 400 });
      await prisma.salesPlanItem.update({ where: { id }, data: { shopsVisited: n } });
    } else if (item.kind === "GOAL" && item.metric === "CUSTOM" && body.manualDone !== undefined) {
      const n = Number(String(body.manualDone).replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: "الإنجاز رقم موجب.", errorEn: "Progress is a non-negative number." }, { status: 400 });
      await prisma.salesPlanItem.update({ where: { id }, data: { manualDone: Math.round(n * 100) / 100 } });
    } else if (item.kind !== "GOAL" && body.plannedDay !== undefined) {
      await prisma.$transaction((tx) => moveItem(tx, id, body.plannedDay ? String(body.plannedDay) : null, riyadhIso(new Date()), body.plannedTime));
    } else {
      return NextResponse.json({ error: "ما يتعدّل هذا هنا.", errorEn: "This item cannot be changed here." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof PlanError) return NextResponse.json({ error: e.ar, errorEn: e.message, code: e.code }, { status: e.status });
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
    await prisma.$transaction((tx) => removeItem(tx, id, user.id));
    return NextResponse.json({ ok: true });
  } catch (e) { return handleDomainError(e); }
}
