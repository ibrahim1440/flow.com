// Supplier credit notes in stock (stage 4b). After a credit note posts (AP debited, GRNI credited
// for its stock lines), each stock line gets one inventory document (SUPPLIER_CREDIT, unique on the
// credit-note line) that clears GRNI:
//   STOCK_RETURN            settles a posted supplier return: the return debited GRNI at the cost the
//                           goods left at; any difference from the amount credited goes to inventory
//                           variance (the goods are gone, there is nothing left to reprice).
//   STOCK_PRICE_ADJUSTMENT  a price reduction on goods received is traced to where they are now:
//                           stock still held is revalued, goods used follow into production outputs,
//                           sales (COGS) and waste; goods already returned to the supplier go to
//                           inventory variance (they were credited at the old price).
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { systemDoc } from "./sales-costing";

export async function settleSupplierCredit(creditNoteId: string) {
  const cn = await prisma.supplierBill.findUnique({ where: { id: creditNoteId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!cn || cn.kind !== "CREDIT_NOTE" || cn.status !== "POSTED") return [];
  const out = [];
  for (const l of cn.lines) {
    if (l.kind !== "STOCK_RETURN" && l.kind !== "STOCK_PRICE_ADJUSTMENT") continue;
    let itemId: string, locationId: string, targetLineId: string | null = null;
    if (l.kind === "STOCK_RETURN") {
      const ret = await prisma.invDocument.findUniqueOrThrow({ where: { id: l.invDocumentId! }, include: { lines: true } });
      itemId = ret.lines[0].itemId; locationId = ret.locationId;
    } else {
      const rl = await prisma.invDocLine.findUniqueOrThrow({ where: { id: l.invDocLineId! }, include: { document: true } });
      itemId = rl.itemId; locationId = rl.document.locationId; targetLineId = rl.id;
    }
    try {
      const doc = await systemDoc({
        type: "SUPPLIER_CREDIT", docDate: cn.billDate.toISOString().slice(0, 10), locationId, supplierId: cn.supplierId, billLineId: l.id,
        sourceType: "SUPPLIER_CREDIT", sourceId: l.id,
        description: `${l.kind === "STOCK_RETURN" ? "Supplier return settled by credit note" : "Supplier price reduction, credit note"} ف-${cn.billNo} · ${cn.supplierInvoiceNo}`,
        lines: [{ itemId, quantity: "0", targetLineId }],
      }, cn.approvedBy ?? cn.postedBy ?? "system:supplier-credit");
      out.push({ lineId: l.id, documentId: doc.id, status: doc.status });
    } catch (e) {
      out.push({ lineId: l.id, documentId: null, status: "FAILED", reason: e instanceof AccountingError ? e.message : (e as Error).message });
    }
  }
  return out;
}
