import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { jsonBody } from "@/lib/accounting/http";
import { inScope } from "@/lib/services/invoicing/http";
import { createNote, creditable } from "@/lib/services/invoicing/service";
import { invError } from "@/lib/services/invoicing/refusals";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });

/** GET — what is still creditable on each line of the issued invoice (the credit note form). */
export async function GET(_request: Request, { params }: Ctx) {
  const { user, error } = await requireSub("sales", "invoices_credit_note");
  if (error) return error;
  const { id } = await params;
  const head = await prisma.salesInvoice.findUnique({ where: { id }, select: { customerId: true } });
  if (!head || !(await inScope(user, head.customerId))) return notFound();
  try {
    return NextResponse.json({ lines: await creditable(id) });
  } catch (err) {
    return invError(err);
  }
}

/**
 * POST — a credit or debit note DRAFT against this issued invoice: { kind: CREDIT_NOTE | DEBIT_NOTE, reasonCode,
 * reason, full?: true | lines: [{ originalLineId, quantity, unitPrice, discountPercent }] }. sales › invoices_credit_note.
 */
export async function POST(request: Request, { params }: Ctx) {
  const { user, error } = await requireSub("sales", "invoices_credit_note");
  if (error) return error;
  const { id } = await params;
  const head = await prisma.salesInvoice.findUnique({ where: { id }, select: { customerId: true } });
  if (!head || !(await inScope(user, head.customerId))) return notFound();
  try {
    const body = await jsonBody(request);
    const kind = body.kind === "DEBIT_NOTE" ? "DEBIT_NOTE" : "CREDIT_NOTE";
    const r = await createNote(id, { kind, reasonCode: body.reasonCode, reason: body.reason, lines: body.lines, full: body.full === true }, auditFromRequest(request, user.id, String(body.reason ?? "")));
    return NextResponse.json(r, { status: 201 });
  } catch (err) {
    return invError(err);
  }
}
