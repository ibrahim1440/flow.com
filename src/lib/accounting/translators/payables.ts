// Supplier bill → journal entry (docs/accounting/STAGE_2_DESIGN.md §3, policy payables.recognition).
//   posted  : Dr each line's account (net)  · Dr INPUT_VAT (Σ VAT)  · Cr AP_CONTROL (gross, party = supplier)
//   reversed: exact mirror of the posted journal, dated on the reversal
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
  const { billId } = ev.payload as { billId: string };
  const bill = await tx.supplierBill.findUnique({ where: { id: billId }, include: { lines: { orderBy: { lineNo: "asc" } }, supplier: true } });
  if (!bill) return { skip: "The supplier bill no longer exists." };
  const label = `ف-${bill.billNo} · ${bill.supplier.name} · ${bill.supplierInvoiceNo}`;

  if (ev.eventType === "ap.bill.reversed") {
    const original = await journalOfEvent(tx, `payables:${bill.id}:ap.bill.posted`);
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
  const lines: EngineLine[] = bill.lines.map((l) => ({
    accountId: l.accountId, debit: l.net, description: l.description ?? label, branchId: bill.branchId, costCenterId: l.costCenterId,
  }));
  if (vat.gt(0)) lines.push({ role: "INPUT_VAT", debit: vat, description: "Input VAT", branchId: bill.branchId });
  lines.push({ role: "AP_CONTROL", credit: bill.totalGross, description: label, branchId: bill.branchId, ...party });
  return {
    entryDate: accountingDateOf(bill.billDate),
    description: `Supplier bill ${label}`,
    sourceModule: "payables", sourceDocumentId: bill.id, lines, alsoUnapproved: [],
  };
}
