import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { inScope } from "@/lib/services/invoicing/http";
import { withdrawRequest } from "@/lib/services/invoicing/requests";
import { invError } from "@/lib/services/invoicing/refusals";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });

/** POST /api/sales/invoices/:id/withdraw — «سحب الطلب»: the requester takes the draft back to edit it (the requester only). */
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
    return NextResponse.json(await withdrawRequest(id, auditFromRequest(request, user.id, "withdraw invoice request")));
  } catch (err) {
    return invError(err);
  }
}
