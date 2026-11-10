// GET /api/sales/direct-sale/[orderId] — the owner's view of their direct sale's discount approval (the page after
// «الخصم انرفض»): the state, the refusal note, the asked discount and the threshold for a resubmission.
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { discountThreshold } from "@/lib/services/sales/quote-settings";

type Params = { params: Promise<{ orderId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { orderId } = await params;
  try {
    const o = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, status: true, ownerId: true, discountApprovalStatus: true, requestedDiscountPercent: true, discountRejectionNote: true, customer: { select: { name: true, nameAr: true } } },
    });
    if (!o || o.ownerId !== user.id) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    // D20 (أبو فهد B2): after the approval, a transfer still without its receipt — the page asks for it.
    const due = await prisma.salesCollection.findFirst({
      where: { orderId: o.id, submittedById: user.id, paymentMethod: "BANK_TRANSFER", status: "PENDING_VERIFICATION", evidence: { none: {} } },
      select: { id: true, opportunityId: true },
    });
    return NextResponse.json({
      receiptDue: due ? { collectionId: due.id, dealId: due.opportunityId } : null,
      id: o.id, orderNumber: o.orderNumber, status: o.status, discountApproval: o.discountApprovalStatus,
      requestedDiscountPercent: o.requestedDiscountPercent?.toString() ?? null, rejectionNote: o.discountRejectionNote,
      customer: { name: o.customer.name, nameAr: o.customer.nameAr }, threshold: (await discountThreshold(prisma)).toString(),
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
