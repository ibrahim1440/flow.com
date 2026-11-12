// POST /api/sales/tax-overrides/[id]/decision { decision: "APPROVE" | "REJECT", note? } — P0 C5: the INDEPENDENT decision on
// a VAT change request (sales › invoice_tax_override_approve through `requireSub`: verified individual + a recent step-up).
// Never the requester (refused in the service and by a CHECK). An approval applies the treatment to the draft.
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { AccountingError } from "@/lib/accounting/errors";
import { invError } from "@/lib/services/invoicing/refusals";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { decideTaxOverride } from "@/lib/services/sales/tax-override";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  const { user, error } = await requireSub("sales", "invoice_tax_override_approve");
  if (error) return error;
  const { id } = await params;
  let b: Record<string, unknown>;
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  try {
    const r = await prisma.taxOverrideRequest.findUnique({ where: { id }, select: { documentType: true, documentId: true } });
    if (!r) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    if (!seesAllSales(user.permissions)) {
      const c = r.documentType === "QUOTE"
        ? await prisma.quote.findUnique({ where: { id: r.documentId }, select: { customerId: true, opportunity: { select: { customerId: true } } } }).then((q) => q?.opportunity?.customerId ?? q?.customerId ?? null)
        : (await prisma.salesInvoice.findUnique({ where: { id: r.documentId }, select: { customerId: true } }))?.customerId ?? null;
      if (!c || !(await customerInScope(user, c))) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    }
    return NextResponse.json(await decideTaxOverride({ id: user.id, name: user.name, permissions: user.permissions }, id, { decision: typeof b.decision === "string" ? b.decision.toUpperCase() : b.decision, note: b.note }));
  } catch (err) {
    if (err instanceof AccountingError) return invError(err);
    return handleDomainError(err);
  }
}
