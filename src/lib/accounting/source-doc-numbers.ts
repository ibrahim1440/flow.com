// The human number of a source document — what an accountant reads on a statement instead of the journal reference.
// One lookup per document kind present (never per row). A kind with no number of its own (a delivery: its order's
// number; a year-end close: none) is documented on its line below. Read-only.
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient | typeof prisma;
export type SourceRef = { sourceType: string | null; sourceId: string | null };
export const sourceKey = (r: SourceRef) => `${r.sourceType ?? ""}:${r.sourceId ?? ""}`;

/** `${sourceType}:${sourceId}` → the document's number as its own screen shows it. Unknown kinds are simply absent. */
export async function sourceDocNumbers(refs: SourceRef[], db: Db = prisma): Promise<Map<string, string>> {
  const by = new Map<string, Set<string>>();
  for (const r of refs) if (r.sourceType && r.sourceId) (by.get(r.sourceType) ?? by.set(r.sourceType, new Set()).get(r.sourceType)!).add(r.sourceId);
  const out = new Map<string, string>();
  const put = (type: string, id: string, no: string | number | null | undefined) => { if (no !== null && no !== undefined && String(no) !== "") out.set(`${type}:${id}`, String(no)); };
  const ids = (t: string) => [...(by.get(t) ?? [])];
  const jobs: Promise<void>[] = [];
  const salesDocs = [...ids("SALES_INVOICE"), ...ids("CREDIT_NOTE"), ...ids("DEBIT_NOTE")];
  if (salesDocs.length) jobs.push(db.salesInvoice.findMany({ where: { id: { in: salesDocs } }, select: { id: true, number: true } }).then((rows) => { for (const t of ["SALES_INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"]) for (const r of rows) if (by.get(t)?.has(r.id)) put(t, r.id, r.number); }));
  if (ids("COLLECTION").length) jobs.push(db.salesCollection.findMany({ where: { id: { in: ids("COLLECTION") } }, select: { id: true, receiptNumber: true, referenceNumber: true } }).then((rows) => rows.forEach((r) => put("COLLECTION", r.id, r.receiptNumber ?? r.referenceNumber))));
  if (ids("ORDER").length) jobs.push(db.order.findMany({ where: { id: { in: ids("ORDER") } }, select: { id: true, orderNumber: true } }).then((rows) => rows.forEach((r) => put("ORDER", r.id, r.orderNumber))));
  // A delivery has no number of its own: it is read by its order's number.
  if (ids("DELIVERY").length) jobs.push(db.delivery.findMany({ where: { id: { in: ids("DELIVERY") } }, select: { id: true, orderItem: { select: { order: { select: { orderNumber: true } } } } } }).then((rows) => rows.forEach((r) => put("DELIVERY", r.id, r.orderItem?.order?.orderNumber))));
  if (ids("SUPPLIER_INVOICE").length) jobs.push(db.supplierInvoice.findMany({ where: { id: { in: ids("SUPPLIER_INVOICE") } }, select: { id: true, number: true } }).then((rows) => rows.forEach((r) => put("SUPPLIER_INVOICE", r.id, r.number))));
  if (ids("SUPPLIER_PAYMENT").length) jobs.push(db.supplierPayment.findMany({ where: { id: { in: ids("SUPPLIER_PAYMENT") } }, select: { id: true, number: true } }).then((rows) => rows.forEach((r) => put("SUPPLIER_PAYMENT", r.id, r.number))));
  if (ids("SUPPLIER_CREDIT_NOTE").length) jobs.push(db.supplierCreditNote.findMany({ where: { id: { in: ids("SUPPLIER_CREDIT_NOTE") } }, select: { id: true, number: true } }).then((rows) => rows.forEach((r) => put("SUPPLIER_CREDIT_NOTE", r.id, r.number))));
  if (ids("ROAST_BATCH").length) jobs.push(db.roastingBatch.findMany({ where: { id: { in: ids("ROAST_BATCH") } }, select: { id: true, batchNumber: true } }).then((rows) => rows.forEach((r) => put("ROAST_BATCH", r.id, r.batchNumber))));
  if (ids("STOCK_TRANSFER").length) jobs.push(db.stockTransfer.findMany({ where: { id: { in: ids("STOCK_TRANSFER") } }, select: { id: true, number: true } }).then((rows) => rows.forEach((r) => put("STOCK_TRANSFER", r.id, r.number))));
  await Promise.all(jobs);
  return out;
}
