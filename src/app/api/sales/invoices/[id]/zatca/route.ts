import { NextResponse } from "@/lib/api-response";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { prisma } from "@/lib/db";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { inScope } from "@/lib/services/invoicing/http";
import { zatcaAbilities } from "@/lib/zatca/access";
import { readMode } from "@/lib/zatca/pipeline";
import { zatcaError } from "@/lib/zatca/refusals";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/sales/invoices/:id/zatca — the invoice's e-invoicing panel (ZT-01 «الفوترة الإلكترونية»): state, ICV, PIH,
 * hash, environment, flow, attempts, warnings / errors, reporting deadline, whether a cleared copy exists. Whoever
 * sees the invoice (sales › invoices_view in their customer scope, or accounting › ar); the XML download and the
 * resubmit are separate permissions (`can`).
 */
export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params;
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions)) return forbidden();
  try {
    const inv = await prisma.salesInvoice.findUnique({ where: { id }, select: { id: true, customerId: true, status: true, family: true, zatcaStatus: true, zatcaXmlRef: true } });
    if (!inv || !(await inScope(user, inv.customerId))) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
    const mode = await readMode(prisma);
    const d = inv.zatcaXmlRef ? await prisma.zatcaDocument.findUnique({
      where: { id: inv.zatcaXmlRef },
      select: { id: true, environment: true, icv: true, pih: true, invoiceHash: true, flow: true, status: true, attempts: true, nextAttemptAt: true, lastHttpStatus: true, lastError: true, warnings: true, errors: true, signedAt: true, submittedAt: true, decidedAt: true, reportingDeadline: true, signedXmlSha256: true, clearedXmlSha256: true },
    }) : null;
    return NextResponse.json({
      mode: mode.mode, invoiceStatus: inv.status, family: inv.family, zatcaStatus: inv.zatcaStatus,
      document: d ? { ...d, icv: d.icv.toString(), hasCleared: !!d.clearedXmlSha256 } : null,
      can: zatcaAbilities(user.permissions, user.role),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return zatcaError(err);
  }
}
