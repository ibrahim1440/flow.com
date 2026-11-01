import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { inScope } from "@/lib/services/invoicing/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sales/invoices/:id/qoyod/pdf — Qoyod's PDF of the document, for its viewers (in their customer scope). */
export async function GET(_request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions)) return forbidden();
  const { id } = await params;
  const c = await prisma.salesInvoiceQoyod.findUnique({ where: { invoiceId: id }, select: { filename: true, mimeType: true, content: true, invoice: { select: { customerId: true } } } });
  if (!c || !(await inScope(user, c.invoice.customerId))) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
  return new Response(new Uint8Array(c.content), {
    headers: {
      "Content-Type": c.mimeType, "Content-Disposition": `inline; filename="${c.filename}"`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    },
  });
}
