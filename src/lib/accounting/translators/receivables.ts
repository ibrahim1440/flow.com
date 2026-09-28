// Receivables (stage 3) → journal entries (policies receivables.recognition, receivables.advances).
//   ar.invoice.posted     : Dr AR_CONTROL (gross, party = customer) · Cr each line's revenue account (net) · Cr OUTPUT_VAT
//   ar.credit_note.posted : Dr SALES_RETURNS (net) · Dr OUTPUT_VAT · Cr AR_CONTROL (gross, party)
//   ar.advance.applied    : Dr CUSTOMER_ADVANCES (amount − VAT portion, party) · Dr OUTPUT_VAT (VAT portion, party) · Cr AR_CONTROL (party)
//   *.reversed            : exact mirror of the posted journal, dated on the reversal
// Customer receipts post from the bank line (translators/bank.ts), never from here.
import type { Prisma } from "@/generated/prisma/client";
import { accountingDateOf } from "../dates";
import { ZERO } from "../money";
import type { EngineLine } from "../posting";
import { journalOfEvent, mirrorOfJournal } from "./mirror";
import type { Translation } from "./types";

type Ev = { id: string; eventType: string; occurredAt: Date; payload: Prisma.JsonValue };

export const docLabel = (d: { kind: string; invoiceNo: number }) => `${d.kind === "CREDIT_NOTE" ? "إشعار دائن" : "فاتورة"} ${d.kind === "CREDIT_NOTE" ? "CN" : "INV"}-${d.invoiceNo}`;

/** Reasons a customer-advance posting still waits for a decision (D-2). */
export async function advanceDecisionsPending(tx: Prisma.TransactionClient): Promise<string[]> {
  const out: string[] = [];
  const p = await tx.accountingPolicy.findFirst({ where: { key: "receivables.advances", status: "APPROVED" } });
  if (!p) out.push(`policy "receivables.advances" has no approved version`);
  const s = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { advanceVatTreatment: true } });
  if (!s?.advanceVatTreatment) out.push("VAT on customer advances (decision D-2) is not set");
  return out;
}

export async function translateReceivables(tx: Prisma.TransactionClient, ev: Ev): Promise<Translation> {
  if (ev.eventType.startsWith("ar.advance.")) {
    const { applicationId } = ev.payload as { applicationId: string };
    const a = await tx.advanceApplication.findUnique({ where: { id: applicationId }, include: { invoice: true, customer: true } });
    if (!a) return { skip: "The advance application no longer exists." };
    const label = `تطبيق دفعة مقدمة ${a.applicationNo} على ${docLabel(a.invoice)} · ${a.customer.nameAr ?? a.customer.name}`;
    if (ev.eventType === "ar.advance.reversed") {
      const original = await journalOfEvent(tx, `receivables:${a.id}:ar.advance.applied`);
      if (!original) return { skip: "Reversed before its journal posted; nothing to mirror." };
      return { entryDate: accountingDateOf(ev.occurredAt), description: `Reversal: ${label} — ${a.reversalReason ?? ""}`, sourceModule: "receivables", sourceDocumentId: a.id, lines: await mirrorOfJournal(tx, original, "Advance application reversal"), alsoUnapproved: [] };
    }
    if (a.status === "REVERSED") return { skip: "Reversed before it posted." };
    const party = { partyType: "CUSTOMER" as const, partyId: a.customerId };
    const vat = a.vatPortion;
    const lines: EngineLine[] = [{ role: "CUSTOMER_ADVANCES", debit: a.amount.sub(vat), description: label, ...party }];
    if (vat.gt(0)) lines.push({ role: "OUTPUT_VAT", debit: vat, description: "VAT charged on the advance, now on the invoice", ...party });
    lines.push({ role: "AR_CONTROL", credit: a.amount, description: label, ...party });
    const s = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { advanceVatTreatment: true } });
    return { entryDate: accountingDateOf(a.appliedOn), description: label, sourceModule: "receivables", sourceDocumentId: a.id, lines,
      alsoUnapproved: s?.advanceVatTreatment ? [] : ["VAT on customer advances (decision D-2) is not set"] };
  }

  const { invoiceId } = ev.payload as { invoiceId: string };
  const inv = await tx.salesInvoice.findUnique({ where: { id: invoiceId }, include: { lines: { orderBy: { lineNo: "asc" } }, customer: true } });
  if (!inv) return { skip: "The sales document no longer exists." };
  const label = `${docLabel(inv)} · ${inv.customer.nameAr ?? inv.customer.name}`;
  if (ev.eventType.endsWith(".reversed")) {
    const original = await journalOfEvent(tx, `receivables:${inv.id}:${ev.eventType.replace(".reversed", ".posted")}`);
    if (!original) return { skip: "Reversed before its journal posted; nothing to mirror." };
    return { entryDate: accountingDateOf(ev.occurredAt), description: `Reversal of ${label} — ${inv.reversalReason ?? ""}`.trim(), sourceModule: "receivables", sourceDocumentId: inv.id, lines: await mirrorOfJournal(tx, original, "Sales document reversal"), alsoUnapproved: [] };
  }
  if (inv.status === "REVERSED") return { skip: "Reversed before it posted." };
  const party = { partyType: "CUSTOMER" as const, partyId: inv.customerId };
  const vat = inv.lines.reduce((s, l) => s.add(l.vat), ZERO);
  const lines: EngineLine[] = [];
  if (inv.kind === "INVOICE") {
    lines.push({ role: "AR_CONTROL", debit: inv.totalGross, description: label, branchId: inv.branchId, ...party });
    for (const l of inv.lines) lines.push({ accountId: l.accountId, credit: l.net, description: l.description ?? label, branchId: inv.branchId, costCenterId: l.costCenterId });
    if (vat.gt(0)) lines.push({ role: "OUTPUT_VAT", credit: vat, description: "Output VAT", branchId: inv.branchId });
  } else {
    lines.push({ role: "SALES_RETURNS", debit: inv.totalNet, description: label, branchId: inv.branchId });
    if (vat.gt(0)) lines.push({ role: "OUTPUT_VAT", debit: vat, description: "Output VAT reversed by the credit note", branchId: inv.branchId });
    lines.push({ role: "AR_CONTROL", credit: inv.totalGross, description: label, branchId: inv.branchId, ...party });
  }
  return { entryDate: accountingDateOf(inv.issueDate), description: label, sourceModule: "receivables", sourceDocumentId: inv.id, lines, alsoUnapproved: [] };
}
