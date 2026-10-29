import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { jsonBody } from "@/lib/accounting/http";
import { inScope } from "@/lib/services/invoicing/http";
import { returnRequest } from "@/lib/services/invoicing/requests";
import { invError } from "@/lib/services/invoicing/refusals";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });

/**
 * POST /api/sales/invoices/:id/return {reasonCode, reason} — «إعادة إلى المبيعات» (council Q-F3): a requested draft goes
 * back to Sales with a reason code (PRICE | QTY | CUSTOMER_DATA | DUPLICATE | OTHER) and a reason of at least 10
 * characters. An invoice: sales › invoices_issue (privileged + step-up, like the issue); a note: invoices_credit_note.
 */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const head = await prisma.salesInvoice.findUnique({ where: { id }, select: { kind: true, customerId: true } });
  if (!head) return notFound();
  const { user, error } = head.kind === "INVOICE" ? await requireSub("sales", "invoices_issue") : await requireSub("sales", "invoices_credit_note");
  if (error) return error;
  if (!(await inScope(user, head.customerId))) return notFound();
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await returnRequest(id, { reasonCode: body.reasonCode, reason: body.reason }, auditFromRequest(request, user.id, String(body.reason ?? "").slice(0, 200))));
  } catch (err) {
    return invError(err);
  }
}
