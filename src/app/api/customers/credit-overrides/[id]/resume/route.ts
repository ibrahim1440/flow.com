// GET /api/customers/credit-overrides/[id]/resume — Abu Fahd M1 / H2: the rep's own over-limit request, as the resume page
// shows it (what, which customer, how much, its status) and the request kept with it, to send again with one tap. Only the
// requester sees it (404 otherwise — nobody learns another rep's request exists).
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { expireCreditOverrides, mayOverrideCredit, resumeOf } from "@/lib/services/customers/credit-limit";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;
  await expireCreditOverrides(prisma);
  const r = await prisma.creditLimitOverride.findUnique({ where: { id }, select: { id: true, kind: true, amount: true, status: true, expiresAt: true, decisionNote: true, requestedById: true, usedOrderId: true, customer: { select: { id: true, name: true, nameAr: true } } } });
  if (!r || r.requestedById !== user.id) return NextResponse.json({ error: "الطلب غير موجود.", errorEn: "Request not found.", code: "NOT_FOUND" }, { status: 404 });
  const resume = await resumeOf(prisma, id);
  const heldOrder = resume?.path.match(/^\/api\/orders\/([^/]+)\/payment-hold$/)?.[1] ?? null;
  // Gate R5 B6: a held order's details only when it is the request's customer's and the requester's own (or theirs to
  // continue as a supervisor) — never another rep's order named in a stored path.
  const found = heldOrder ? await prisma.order.findUnique({ where: { id: heldOrder }, select: { id: true, orderNumber: true, paymentHold: true, status: true, customerId: true, ownerId: true } }) : null;
  const order = found && found.customerId === r.customer.id && (found.ownerId === user.id || mayOverrideCredit(user.permissions as never))
    ? { id: found.id, orderNumber: found.orderNumber, paymentHold: found.paymentHold, status: found.status } : null;
  // Gate R7: how a closed request closed — the system (the held order released), the rep (withdrawn), or a supervisor.
  const sys = r.status === "REJECTED" ? await prisma.hrAuditLog.findFirst({ where: { action: "CREDIT_OVERRIDE_REJECTED", after: { path: ["requestId"], equals: id } }, select: { after: true } }) : null;
  const closedBy = r.status === "WITHDRAWN" ? "WITHDRAWN" : (sys?.after as { system?: string } | null)?.system ? "SYSTEM" : null;
  return NextResponse.json({
    closedBy,
    id: r.id, kind: r.kind, amount: r.amount.toFixed(2), status: r.status, expiresAt: r.expiresAt, note: r.decisionNote,
    customer: { id: r.customer.id, name: r.customer.nameAr || r.customer.name }, usedOrderId: r.usedOrderId,
    resume: heldOrder && !order ? null : resume, heldOrder: order,
  });
}
