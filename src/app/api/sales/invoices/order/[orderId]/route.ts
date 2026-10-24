import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { abilities, canViewInvoices, canCreateInvoices } from "@/lib/services/invoicing/access";
import { inScope } from "@/lib/services/invoicing/http";
import { orderInvoicing } from "@/lib/services/invoicing/service";
import { invError } from "@/lib/services/invoicing/refusals";

type Ctx = { params: Promise<{ orderId: string }> };

/** GET — the order's invoicing picture per line (ordered, delivered, drafted, issued, left; the price source) and its invoices. */
export async function GET(_request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions) && !canCreateInvoices(user.permissions)) return forbidden();
  try {
    const { orderId } = await params;
    const facts = await orderInvoicing(prisma, orderId);
    if (!facts || !(await inScope(user, facts.order.customerId))) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
    const invoices = await prisma.salesInvoice.findMany({ where: { orderId, kind: "INVOICE" }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, grandTotal: true, createdAt: true } });
    return NextResponse.json({ ...facts, invoices: invoices.map((i) => ({ ...i, grandTotal: i.grandTotal.toFixed(2) })), can: abilities(user.permissions) });
  } catch (err) {
    return invError(err);
  }
}
