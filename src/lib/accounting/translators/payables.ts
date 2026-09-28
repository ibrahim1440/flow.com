// Supplier bill → journal entry (docs/accounting/STAGE_2_DESIGN.md §3, policy payables.recognition).
//   posted  : Dr each line's account (net)  · Dr INPUT_VAT (Σ VAT)  · Cr AP_CONTROL (gross, party = supplier)
//   reversed: exact mirror of the posted journal, dated on the reversal
// Supplier credit note (stage 4b): Dr AP_CONTROL (gross, open item = the credit note) / Cr each
// line's account (stock lines: GRNI) · Cr INPUT_VAT; the stock side clears GRNI through the
// inventory documents supplier-credits.ts makes. ap.credit.allocated: Dr AP_CONTROL (open item =
// the bill) / Cr AP_CONTROL (open item = the credit note), net zero; released → mirror.
// Stock-receipt lines already carry the GRNI role's account (resolved when the line was saved).
import type { Prisma } from "@/generated/prisma/client";
import { accountingDateOf } from "../dates";
import { PostingBlocked } from "../errors";
import { ZERO } from "../money";
import type { EngineLine } from "../posting";
import { journalOfEvent, mirrorOfJournal } from "./mirror";
import type { Translation } from "./types";

type Ev = { id: string; eventType: string; occurredAt: Date; payload: Prisma.JsonValue };

export async function translateSupplierBill(tx: Prisma.TransactionClient, ev: Ev): Promise<Translation> {
  if (ev.eventType.startsWith("ap.credit.")) return translateCreditAllocation(tx, ev);
  const { billId } = ev.payload as { billId: string };
  const bill = await tx.supplierBill.findUnique({ where: { id: billId }, include: { lines: { orderBy: { lineNo: "asc" } }, supplier: true } });
  if (!bill) return { skip: "The supplier bill no longer exists." };
  const label = `ف-${bill.billNo} · ${bill.supplier.name} · ${bill.supplierInvoiceNo}`;

  if (ev.eventType === "ap.bill.reversed" || ev.eventType === "ap.credit_note.reversed") {
    const original = await journalOfEvent(tx, `payables:${bill.id}:${ev.eventType === "ap.bill.reversed" ? "ap.bill.posted" : "ap.credit_note.posted"}`);
    if (!original) return { skip: "The bill was reversed before its journal posted; there is nothing to mirror." };
    return {
      entryDate: accountingDateOf(ev.occurredAt),
      description: `Reversal of supplier bill ${label} — ${bill.reversalReason ?? ""}`.trim(),
      sourceModule: "payables", sourceDocumentId: bill.id,
      lines: await mirrorOfJournal(tx, original, "Supplier bill reversal"),
      alsoUnapproved: [],
    };
  }

  if (bill.status === "REVERSED") return { skip: "The bill was reversed before it posted." };
  const vat = bill.lines.reduce((s, l) => s.add(l.vat), ZERO);
  if (vat.gt(0) && !bill.supplier.vatNumber) {
    throw new PostingBlocked(`Supplier ${bill.supplier.name} has no VAT registration number, so input VAT cannot be claimed.`);
  }
  const party = { partyType: "SUPPLIER" as const, partyId: bill.supplierId };
  if (bill.kind === "CREDIT_NOTE") {
    const orig = await tx.supplierBill.findUnique({ where: { id: bill.originalBillId! }, select: { billNo: true } });
    const cl: EngineLine[] = [{ role: "AP_CONTROL", debit: bill.totalGross, description: `Supplier credit note ${label} (bill ف-${orig?.billNo ?? "?"})`, branchId: bill.branchId, ...party, openItem: { type: "SUPPLIER_CREDIT", id: bill.id } }];
    for (const l of bill.lines) cl.push({ accountId: l.accountId, credit: l.net, description: l.description ?? label, branchId: bill.branchId, costCenterId: l.costCenterId });
    if (vat.gt(0)) cl.push({ role: "INPUT_VAT", credit: vat, description: "Input VAT reversed (supplier credit)", branchId: bill.branchId });
    return { entryDate: accountingDateOf(bill.billDate), description: `Supplier credit note ${label}`, sourceModule: "payables", sourceDocumentId: bill.id, lines: cl, alsoUnapproved: [] };
  }
  const lines: EngineLine[] = bill.lines.map((l) => ({
    accountId: l.accountId, debit: l.net, description: l.description ?? label, branchId: bill.branchId, costCenterId: l.costCenterId,
  }));
  if (vat.gt(0)) lines.push({ role: "INPUT_VAT", debit: vat, description: "Input VAT", branchId: bill.branchId });
  lines.push({ role: "AP_CONTROL", credit: bill.totalGross, description: label, branchId: bill.branchId, ...party, openItem: { type: "SUPPLIER_BILL", id: bill.id } });
  return {
    entryDate: accountingDateOf(bill.billDate),
    description: `Supplier bill ${label}`,
    sourceModule: "payables", sourceDocumentId: bill.id, lines, alsoUnapproved: [],
  };
}

async function translateCreditAllocation(tx: Prisma.TransactionClient, ev: Ev): Promise<Translation> {
  const { allocationId } = ev.payload as { allocationId: string };
  const a = await tx.apCreditAllocation.findUnique({ where: { id: allocationId } });
  if (!a) return { skip: "The credit allocation no longer exists." };
  const [cn, bill] = await Promise.all([tx.supplierBill.findUniqueOrThrow({ where: { id: a.creditNoteId }, include: { supplier: true } }), tx.supplierBill.findUniqueOrThrow({ where: { id: a.billId } })]);
  const label = `ف-${cn.billNo} → ف-${bill.billNo} · ${cn.supplier.name}`;
  if (ev.eventType === "ap.credit.released") {
    const original = await journalOfEvent(tx, `payables:${a.id}:ap.credit.allocated`);
    if (!original) return { skip: "Released before its journal posted; nothing to mirror." };
    return { entryDate: accountingDateOf(ev.occurredAt), description: `Supplier credit released: ${label}`, sourceModule: "payables", sourceDocumentId: a.id, lines: await mirrorOfJournal(tx, original, "Supplier credit released"), alsoUnapproved: [] };
  }
  if (!a.active) return { skip: "Released before it posted." };
  const party = { partyType: "SUPPLIER" as const, partyId: cn.supplierId };
  return {
    entryDate: accountingDateOf(a.allocatedOn), description: `Supplier credit applied: ${label}`, sourceModule: "payables", sourceDocumentId: a.id, alsoUnapproved: [],
    lines: [
      { role: "AP_CONTROL", debit: a.amount, description: `Settles ف-${bill.billNo}`, ...party, openItem: { type: "SUPPLIER_BILL", id: bill.id } },
      { role: "AP_CONTROL", credit: a.amount, description: `Credit ف-${cn.billNo} used`, ...party, openItem: { type: "SUPPLIER_CREDIT", id: cn.id } },
    ],
  };
}
