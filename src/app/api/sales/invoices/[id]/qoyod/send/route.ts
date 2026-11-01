import { after } from "next/server";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { jsonBody } from "@/lib/accounting/http";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { inScope } from "@/lib/services/invoicing/http";
import { invError } from "@/lib/services/invoicing/refusals";
import { sendQoyodCopy } from "@/lib/services/invoicing/qoyod-copy";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 60;

/**
 * POST /api/sales/invoices/:id/qoyod/send — «إرسال»: Qoyod's PDF to the customer, { whatsapp, email }. Who: the
 * document's viewers in their customer scope (the rep of the customer, the accountant). The rows go through the
 * automation queues (send mode, opt-outs, suppression, log, archive); the sender is kicked right after the response.
 */
export async function POST(request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions)) return forbidden();
  try {
    const { id } = await params;
    const head = await prisma.salesInvoice.findUnique({ where: { id }, select: { customerId: true } });
    if (!head || !(await inScope(user, head.customerId))) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
    const body = (await jsonBody(request)) as { whatsapp?: unknown; email?: unknown };
    const r = await prisma.$transaction((tx) => sendQoyodCopy(tx, { invoiceId: id, channels: { whatsapp: body.whatsapp === true, email: body.email === true }, actor: { id: user.id, name: user.name } }));
    if (r.queued > 0) {
      after(async () => {
        const { runAutomationDispatch } = await import("@/lib/automation/dispatcher");
        await runAutomationDispatch({ budgetMs: 25_000, maxSends: 6 }).catch((e) => console.error("[qoyod-send] dispatch:", e instanceof Error ? e.message : e));
      });
    }
    return NextResponse.json(r, { status: 201 });
  } catch (err) {
    return invError(err);
  }
}
