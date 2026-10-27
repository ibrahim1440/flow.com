/**
 * What a green lot's receipts say about it, for its label and its page: the supplier of the first receipt, the supplier's
 * own invoice number when that receipt belongs to a one-step purchase invoice (CostMove GRN · RECEIVED, lineKey
 * `SINV:<invoice id>` — the immutable link phase 2 writes), and the kilograms received. A receipt reversed by a
 * cancelled invoice (its RETURN cost move) is left out. Read-only; no price ever leaves this function.
 */
import { prisma } from "@/lib/db";

export type LotReceipt = {
  purchaseId: string; date: Date; supplier: string; quantityKg: number;
  invoiceId: string | null; invoiceNumber: string | null; invoiceRef: string | null;
};
export type LotReceiptSummary = { supplier: string | null; invoiceRef: string | null; receivedKg: number | null; receipts: LotReceipt[] };

export async function greenLotReceipts(lotIds: string[]): Promise<Map<string, LotReceiptSummary>> {
  const out = new Map<string, LotReceiptSummary>();
  if (!lotIds.length) return out;
  const recs = await prisma.purchaseRecord.findMany({
    where: { type: "GREEN_BEAN", itemId: { in: lotIds } },
    select: { id: true, itemId: true, purchaseDate: true, quantity: true, supplier: { select: { name: true } } },
    orderBy: [{ purchaseDate: "asc" }, { createdAt: "asc" }],
  });
  const ids = recs.map((r) => r.id);
  const moves = ids.length
    ? await prisma.costMove.findMany({ where: { sourceType: "GRN", sourceId: { in: ids } }, select: { sourceId: true, sourceEvent: true, lineKey: true } })
    : [];
  const returned = new Set(moves.filter((m) => m.sourceEvent !== "RECEIVED" && /RETURN|REVERS/i.test(m.sourceEvent)).map((m) => m.sourceId));
  const invOf = new Map(moves.filter((m) => m.sourceEvent === "RECEIVED" && m.lineKey.startsWith("SINV:")).map((m) => [m.sourceId, m.lineKey.slice(5)]));
  const invIds = [...new Set(invOf.values())];
  const invoices = invIds.length
    ? await prisma.supplierInvoice.findMany({ where: { id: { in: invIds } }, select: { id: true, number: true, supplierRef: true, status: true } })
    : [];
  const inv = new Map(invoices.map((i) => [i.id, i]));
  for (const id of lotIds) out.set(id, { supplier: null, invoiceRef: null, receivedKg: null, receipts: [] });
  for (const r of recs) {
    if (!r.itemId || returned.has(r.id)) continue;
    const i = invOf.has(r.id) ? inv.get(invOf.get(r.id)!) ?? null : null;
    if (i && i.status === "CANCELLED") continue;
    const s = out.get(r.itemId)!;
    s.receipts.push({ purchaseId: r.id, date: r.purchaseDate, supplier: r.supplier.name, quantityKg: r.quantity, invoiceId: i?.id ?? null, invoiceNumber: i?.number ?? null, invoiceRef: i?.supplierRef ?? null });
  }
  for (const s of out.values()) {
    const first = s.receipts[0];
    s.supplier = first?.supplier ?? null;
    s.invoiceRef = first?.invoiceRef ?? null;
    s.receivedKg = s.receipts.length ? Math.round(s.receipts.reduce((a, r) => a + r.quantityKg, 0) * 1000) / 1000 : null;
  }
  return out;
}
