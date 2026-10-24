import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { reverseJournalEntry } from "@/lib/accounting/journal-service";
import { reverseEntry } from "@/lib/accounting/posting-engine";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { refuse } from "@/lib/accounting/refusals";
import { auditFromRequest } from "@/lib/accounting/audit";

type Params = { params: Promise<{ id: string }> };
const REASON_MAX_LENGTH = 500;

/**
 * Reverse a posted entry with a reason (and an optional date, default today in Riyadh): a mirrored REVERSAL
 * entry, the original marked REVERSED. A manual journal through the manual-journal service; an engine entry
 * (it has an idempotency key) through the posting engine; an HR journal only through HR.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_reverse");
  if (error) return error;
  // Defense in depth: there is no role hierarchy above "admin" yet (see saas-readiness.md).
  // The spec requires reversal to be gated by explicit permission + mandatory reason; admin-only
  // is the strictest interpretation available without a dedicated Role model.
  // The admin role is privileged: the same verified-individual gate, with a recent step-up.
  const refused = await requireAdminAction(user, "accounting.journal_reverse", { stepUp: true, message: "Insufficient permissions." });
  if (refused) return refused;
  const { id } = await params;
  try {
    const body = await jsonBody(request);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3) throw refuse("REASON_REQUIRED");
    if (reason.length > REASON_MAX_LENGTH) throw refuse("BAD_INPUT", `(reason ≤ ${REASON_MAX_LENGTH})`);
    const date = typeof body.date === "string" && body.date ? body.date : null;
    const ctx = auditFromRequest(request, user.id, reason);
    const original = await prisma.journalEntry.findUnique({ where: { id }, select: { idempotencyKey: true, type: true } });
    if (!original) throw refuse("NOT_FOUND");
    // A5 council fix: an entry posted from a source document (an invoice, a note, a receipt, a supplier bill or
    // payment, a stock / production event, a commission, the year-end close) is corrected from that document — a
    // credit note, a cancel, a void, a reversal of the receipt — never by reversing its entry here, which would leave
    // the document standing with no entry (sub-ledger ≠ GL, the VAT return ≠ GL, a ZATCA-reported invoice
    // "cancelled" in the books). The opening entry keeps its own refusal (OPENING_FINAL, by the engine).
    if (original.idempotencyKey && String(original.type) !== "OPENING") throw refuse("SOURCE_DOCUMENT_ENTRY");
    if (original.idempotencyKey) {
      const r = await prisma.$transaction((tx) => reverseEntry(tx, { entryId: id, reason, actorId: user.id, date: date ?? undefined, audit: ctx }), TX_OPTS);
      return NextResponse.json(await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.entryId }, include: { lines: true } }), { status: 201 });
    }
    return NextResponse.json(await reverseJournalEntry(id, ctx, reason, date), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
