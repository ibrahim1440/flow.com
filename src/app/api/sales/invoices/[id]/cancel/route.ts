import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { jsonBody } from "@/lib/accounting/http";
import { inScope } from "@/lib/services/invoicing/http";
import { cancelDraft } from "@/lib/services/invoicing/service";
import { invError } from "@/lib/services/invoicing/refusals";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sales/invoices/:id/cancel {reason} — cancel a DRAFT (never an issued document). invoices_cancel; a note draft: invoices_credit_note. */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const head = await prisma.salesInvoice.findUnique({ where: { id }, select: { kind: true, customerId: true } });
  if (!head) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
  const { user, error } = head.kind === "INVOICE" ? await requireSub("sales", "invoices_cancel") : await requireSub("sales", "invoices_credit_note");
  if (error) return error;
  if (!(await inScope(user, head.customerId))) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
  try {
    const body = await jsonBody(request);
    return NextResponse.json(await cancelDraft(id, String(body.reason ?? ""), auditFromRequest(request, user.id, String(body.reason ?? ""))));
  } catch (err) {
    return invError(err);
  }
}
