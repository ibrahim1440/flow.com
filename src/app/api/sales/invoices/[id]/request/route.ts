import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { jsonBody } from "@/lib/accounting/http";
import { inScope } from "@/lib/services/invoicing/http";
import { requestInvoice } from "@/lib/services/invoicing/requests";
import { invError } from "@/lib/services/invoicing/refusals";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });

/**
 * POST /api/sales/invoices/:id/request {note?} — «إرسال الطلب للمحاسب»: the DRAFT enters the accountant's queue
 * («طلبات الفواتير»). Answers the draft's issue problems as `warnings` (the accountant corrects compliance fields or sends
 * it back). A manual invoice checks the customer's sales hold now. An invoice: sales › invoices_create; a note:
 * sales › invoices_credit_note. Within the viewer's customer scope.
 */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const head = await prisma.salesInvoice.findUnique({ where: { id }, select: { kind: true, customerId: true } });
  if (!head) return notFound();
  const { user, error } = head.kind === "INVOICE" ? await requireSub("sales", "invoices_create") : await requireSub("sales", "invoices_credit_note");
  if (error) return error;
  if (!(await inScope(user, head.customerId))) return notFound();
  try {
    const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
    return NextResponse.json(await requestInvoice(id, body.note, auditFromRequest(request, user.id, "invoice request")));
  } catch (err) {
    return invError(err);
  }
}
