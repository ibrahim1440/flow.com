import { after } from "next/server";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { inScope } from "@/lib/services/invoicing/http";
import { issueDocument } from "@/lib/services/invoicing/service";
import { invError } from "@/lib/services/invoicing/refusals";
import { submitDocument, type SubmitResult } from "@/lib/zatca/pipeline";

type Ctx = { params: Promise<{ id: string }> };
// A4: a standard invoice is cleared by ZATCA inside this request (30 s timeout per call).
export const maxDuration = 60;

/**
 * POST /api/sales/invoices/:id/issue — issue a DRAFT: the database numbers it, the particulars freeze, the ledger
 * entry is posted in the same transaction. Privileged + step-up: an invoice needs sales › invoices_issue, a credit
 * or debit note sales › invoices_credit_note (and is not issued by its own preparer). Idempotent (a second call
 * answers the first issue, 200).
 */
export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params;
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const head = await prisma.salesInvoice.findUnique({ where: { id }, select: { kind: true, customerId: true } });
  if (!head) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
  const { user, error } = head.kind === "INVOICE" ? await requireSub("sales", "invoices_issue") : await requireSub("sales", "invoices_credit_note");
  if (error) return error;
  if (!(await inScope(user, head.customerId))) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
  try {
    const r = await issueDocument(id, auditFromRequest(request, user.id, "issue"));
    // A4 — ZATCA Phase 2, after the commit (never inside the transaction): a standard document is cleared now, so
    // it is shared only once CLEARED (a transient failure leaves it PENDING for the queue); a simplified one is
    // reported right after the response and, failing that, by the queue within 24 h.
    let submission: SubmitResult | { status: string; reason: string } | null = null;
    if (r.zatca?.flow === "CLEARANCE") {
      submission = await submitDocument(r.zatca.documentId, { actorId: user.id }).catch((e: { code?: string; message?: string }) => ({ status: "PENDING", reason: e?.code ?? "SUBMIT_FAILED" }));
    } else if (r.zatca?.flow === "REPORTING") {
      const docId = r.zatca.documentId;
      after(() => submitDocument(docId, { actorId: user.id }).then(() => undefined, () => undefined));
    }
    return NextResponse.json({ ...r, zatcaSubmission: submission }, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    return invError(err);
  }
}
