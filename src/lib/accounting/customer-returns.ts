// Physical customer returns (stage 4b), separate from invoice corrections.
//
// An invoice reversal or a credit note never moves stock. Goods come back only through a return
// that is recorded (DRAFT), received by the warehouse with its evidence — who, when, the goods
// receipt reference (RECEIVED) — approved by someone other than the person who recorded or
// received it (APPROVED), and posted (POSTED). Posting puts the goods back at the cost they left
// at: from cost of sales while the invoice stands (a credit note for returned goods then names
// this return), or from "delivered, not invoiced" when the invoice was reversed. Damaged goods come
// back and are written off to inventory variance in the same step. A return never exceeds what is
// still with the customer (sold less returned or being returned), so stock is never restored twice.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ledgerTx } from "./journal-service";
import { auditAccounting } from "./audit";
import { ZERO, dec } from "./money";
import { accountingDate } from "./dates";
import { classifyLines, costedSoFar, deliveredLocation, systemDoc } from "./sales-costing";

type LineIn = { invoiceLineId?: unknown; quantity?: unknown; condition?: unknown };
const CONDITIONS = new Set(["RESALABLE", "DAMAGED"]);

/** Quantity of an invoice line still with the customer, in the item's base unit. */
async function stillOut(invoiceLineId: string, exceptReturnId?: string) {
  const done = await costedSoFar(prisma, invoiceLineId);
  const pending = await prisma.customerReturnLine.aggregate({ where: { invoiceLineId, return: { status: { in: ["DRAFT", "RECEIVED", "APPROVED"] }, ...(exceptReturnId ? { id: { not: exceptReturnId } } : {}) } }, _sum: { quantity: true } });
  return { sold: done.qty, returned: done.returnedQty, pending: dec(pending._sum.quantity), out: done.qty.sub(done.returnedQty).sub(dec(pending._sum.quantity)) };
}

async function checkedLines(invoiceId: string, raw: unknown, exceptReturnId?: string) {
  if (!Array.isArray(raw) || !raw.length) throw new AccountingError("A return needs at least one line.", 400);
  const { lines } = await classifyLines(prisma, invoiceId);
  const byLine = new Map<string, Prisma.Decimal>();
  const out = (raw as LineIn[]).map((l, i) => {
    const n = i + 1;
    const g = lines.find((x) => x.line.id === String(l.invoiceLineId ?? ""));
    if (!g || !g.item) throw new AccountingError(`Line ${n}: choose a goods line of the invoice that names its inventory item.`, 400);
    let q: Prisma.Decimal;
    try { q = new Prisma.Decimal(String(l.quantity ?? "")); } catch { throw new AccountingError(`Line ${n}: the quantity is not a number.`, 400); }
    if (!q.isFinite() || q.lte(0) || q.decimalPlaces() > 4) throw new AccountingError(`Line ${n}: the quantity must be positive, with at most 4 decimals.`, 400);
    const condition = CONDITIONS.has(String(l.condition ?? "RESALABLE")) ? String(l.condition ?? "RESALABLE") : null;
    if (!condition) throw new AccountingError(`Line ${n}: the condition is resalable or damaged.`, 400);
    byLine.set(g.line.id, (byLine.get(g.line.id) ?? ZERO).add(q));
    return { invoiceLineId: g.line.id, itemId: g.item.id, quantity: q, condition, lineNo: g.line.lineNo, code: g.item.code };
  });
  for (const [lineId, q] of byLine) {
    const s = await stillOut(lineId, exceptReturnId);
    const l = out.find((x) => x.invoiceLineId === lineId)!;
    if (q.gt(s.out)) throw new AccountingError(`Invoice line ${l.lineNo} (${l.code}): only ${Prisma.Decimal.max(s.out, ZERO).toFixed(4)} are still out with the customer (${s.sold.toFixed(4)} left stock for this invoice, ${s.returned.add(s.pending).toFixed(4)} returned or being returned); ${q.toFixed(4)} is more than that.`, 409);
  }
  return out;
}

export async function createCustomerReturn(body: { invoiceId?: unknown; locationId?: unknown; reason?: unknown; lines?: unknown }, userId: string) {
  const inv = await prisma.salesInvoice.findUnique({ where: { id: String(body.invoiceId ?? "") } });
  if (!inv || inv.kind !== "INVOICE" || !["POSTED", "REVERSED"].includes(inv.status)) throw new AccountingError("A return is recorded against a posted (or reversed) invoice.", 400);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  if (reason.length < 5) throw new AccountingError("A return needs a reason (at least 5 characters).", 400);
  const locId = String(body.locationId ?? "") || inv.fulfilmentLocationId || (await prisma.invLocation.findFirst({ where: { isSalesDefault: true } }))?.id || "";
  const loc = await prisma.invLocation.findUnique({ where: { id: locId } });
  if (!loc || !loc.isActive || loc.isDelivered) throw new AccountingError("Choose the stock location the goods come back to.", 400);
  const lines = await checkedLines(inv.id, body.lines);
  return ledgerTx(async (tx) => {
    const r = await tx.customerReturn.create({ data: { customerId: inv.customerId, invoiceId: inv.id, locationId: loc.id, reason, createdBy: userId,
      lines: { create: lines.map((l) => ({ invoiceLineId: l.invoiceLineId, itemId: l.itemId, quantity: l.quantity, condition: l.condition })) } }, include: { lines: true } });
    await auditAccounting(tx, { action: "customer_return.create", entityType: "customer_return", entityId: r.id, userId, after: { invoiceId: inv.id, lines: lines.length } });
    return r;
  });
}

/** The warehouse confirms the goods arrived: who, when, and the receipt evidence. */
export async function receiveCustomerReturn(id: string, body: { receivedOn?: unknown; evidenceRef?: unknown }, userId: string) {
  const evidenceRef = typeof body.evidenceRef === "string" ? body.evidenceRef.trim().slice(0, 120) : "";
  if (evidenceRef.length < 3) throw new AccountingError("Enter the warehouse evidence (goods receipt note, photo or reference).", 400);
  if (!body.receivedOn) throw new AccountingError("Enter the day the goods arrived.", 400);
  const receivedOn = accountingDate(body.receivedOn);
  return ledgerTx(async (tx) => {
    const r = await tx.customerReturn.updateMany({ where: { id, status: "DRAFT" }, data: { status: "RECEIVED", receivedBy: userId, receivedAt: new Date(), receivedOn, evidenceRef } });
    if (r.count !== 1) throw new AccountingError("Only a recorded (draft) return can be received.", 409);
    await auditAccounting(tx, { action: "customer_return.receive", entityType: "customer_return", entityId: id, userId, after: { receivedOn, evidenceRef } });
    return tx.customerReturn.findUniqueOrThrow({ where: { id } });
  });
}

export async function approveCustomerReturn(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const cur = await tx.customerReturn.findUnique({ where: { id } });
    if (!cur) throw new AccountingError("Return not found.", 404);
    if (cur.status !== "RECEIVED") throw new AccountingError("The return must be received by the warehouse, with its evidence, before it is approved.", 409);
    if (userId === cur.createdBy || userId === cur.receivedBy) throw new AccountingError("A return is approved by someone other than the person who recorded or received it.", 403);
    const r = await tx.customerReturn.updateMany({ where: { id, status: "RECEIVED" }, data: { status: "APPROVED", approvedBy: userId, approvedAt: new Date() } });
    if (r.count !== 1) throw new AccountingError("The return changed; reload it.", 409);
    await auditAccounting(tx, { action: "customer_return.approve", entityType: "customer_return", entityId: id, userId });
    return tx.customerReturn.findUniqueOrThrow({ where: { id } });
  });
}

/** Send a received return back to draft (wrong quantities): the warehouse receives it again. */
export async function rejectCustomerReturn(id: string, userId: string, reason: string) {
  if (!reason || reason.trim().length < 5) throw new AccountingError("A rejection needs a reason (at least 5 characters).", 400);
  return ledgerTx(async (tx) => {
    const r = await tx.customerReturn.updateMany({ where: { id, status: "RECEIVED" }, data: { status: "DRAFT", receivedBy: null, receivedAt: null, receivedOn: null, evidenceRef: null } });
    if (r.count !== 1) throw new AccountingError("Only a received return can be sent back.", 409);
    await auditAccounting(tx, { action: "customer_return.reject", entityType: "customer_return", entityId: id, userId, reason: reason.trim() });
    return tx.customerReturn.findUniqueOrThrow({ where: { id } });
  });
}

/**
 * Post an approved return: goods back at the cost they left at (one inventory document per
 * return, unique on the return), damaged goods written off. Idempotent: a retry finds the
 * documents already made.
 */
export async function postCustomerReturn(id: string, userId: string) {
  const r = await prisma.customerReturn.findUnique({ where: { id }, include: { lines: true } });
  if (!r) throw new AccountingError("Return not found.", 404);
  if (r.status === "POSTED") return r;
  if (r.status !== "APPROVED") throw new AccountingError("Only an approved return can be posted.", 409);
  const inv = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: r.invoiceId } });
  // Re-check against what is out now (another return may have posted since this one was recorded).
  await checkedLines(inv.id, r.lines.map((l) => ({ invoiceLineId: l.invoiceLineId, quantity: l.quantity.toString(), condition: l.condition })), r.id);
  const date = r.receivedOn!.toISOString().slice(0, 10);
  const items = new Map((await prisma.invItem.findMany({ where: { id: { in: r.lines.map((l) => l.itemId) } } })).map((i) => [i.id, i]));
  let doc;
  if (inv.status === "POSTED") {
    // Cost of sales comes back: each line targets the sale issue it came from.
    const lines = [];
    for (const l of r.lines) {
      const issues = await prisma.invDocLine.findMany({ where: { salesInvoiceLineId: l.invoiceLineId, document: { status: "POSTED", type: "SALE_ISSUE" } } });
      if (!issues.length) throw new AccountingError("The invoice's cost of sales has not posted; the goods never left stock in the accounts.", 409);
      lines.push({ itemId: l.itemId, quantity: l.quantity.toFixed(4), unit: items.get(l.itemId)!.baseUnit, targetLineId: issues[0].id, salesInvoiceLineId: l.invoiceLineId });
    }
    doc = await systemDoc({ type: "CUSTOMER_RETURN", docDate: date, locationId: r.locationId, customerId: r.customerId, salesInvoiceId: inv.id, sourceType: "CUSTOMER_RETURN", sourceId: r.id,
      description: `Customer return R-${r.returnNo} · INV-${inv.invoiceNo} · ${r.evidenceRef}`, lines }, r.approvedBy!);
  } else {
    // The invoice was reversed: the goods' cost is in "delivered, not invoiced" — it moves back to stock.
    const dlv = await deliveredLocation();
    doc = await systemDoc({ type: "TRANSFER", docDate: date, locationId: dlv.id, toLocationId: r.locationId, salesInvoiceId: inv.id, sourceType: "CUSTOMER_RETURN", sourceId: r.id,
      description: `Customer return R-${r.returnNo} · reversed INV-${inv.invoiceNo} · ${r.evidenceRef}`,
      lines: r.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity.toFixed(4), unit: items.get(l.itemId)!.baseUnit, salesInvoiceLineId: l.invoiceLineId })) }, r.approvedBy!);
  }
  if (doc.status !== "POSTED") throw new AccountingError("The return document did not post.", 409);
  const damaged = r.lines.filter((l) => l.condition === "DAMAGED");
  if (damaged.length) {
    const w = await systemDoc({ type: "ISSUE", issueReason: "SPOILAGE", docDate: doc.docDate.toISOString().slice(0, 10), locationId: r.locationId, sourceType: "CUSTOMER_RETURN_WRITEOFF", sourceId: r.id,
      description: `Damaged goods from customer return R-${r.returnNo}`, lines: damaged.map((l) => ({ itemId: l.itemId, quantity: l.quantity.toFixed(4), unit: items.get(l.itemId)!.baseUnit })) }, r.approvedBy!);
    if (w.status !== "POSTED") throw new AccountingError("The write-off of the damaged goods did not post.", 409);
  }
  return ledgerTx(async (tx) => {
    await tx.customerReturn.updateMany({ where: { id, status: "APPROVED" }, data: { status: "POSTED", postedBy: userId, postedAt: new Date(), documentId: doc.id } });
    await auditAccounting(tx, { action: "customer_return.post", entityType: "customer_return", entityId: id, userId, after: { documentId: doc.id } });
    return tx.customerReturn.findUniqueOrThrow({ where: { id } });
  });
}

export async function listCustomerReturns(q: { status?: string | null; invoiceId?: string | null } = {}) {
  const rows = await prisma.customerReturn.findMany({ where: { ...(q.status ? { status: q.status as never } : {}), ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}) }, include: { lines: true }, orderBy: { returnNo: "desc" }, take: 200 });
  const inv = new Map((await prisma.salesInvoice.findMany({ where: { id: { in: rows.map((r) => r.invoiceId) } }, include: { customer: { select: { name: true, nameAr: true } } } })).map((i) => [i.id, i]));
  const people = new Map((await prisma.employee.findMany({ where: { id: { in: rows.flatMap((r) => [r.createdBy, r.receivedBy, r.approvedBy]).filter(Boolean) as string[] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const items = new Map((await prisma.invItem.findMany({ where: { id: { in: rows.flatMap((r) => r.lines.map((l) => l.itemId)) } } })).map((i) => [i.id, i]));
  const credited = new Map((await prisma.salesInvoice.findMany({ where: { customerReturnId: { in: rows.map((r) => r.id) }, status: { in: ["DRAFT", "SUBMITTED", "APPROVED", "POSTED"] } }, select: { customerReturnId: true, invoiceNo: true, status: true } })).map((c) => [c.customerReturnId!, c]));
  return rows.map((r) => ({
    ...r, invoiceNo: inv.get(r.invoiceId)?.invoiceNo ?? null, invoiceStatus: inv.get(r.invoiceId)?.status ?? null, customer: inv.get(r.invoiceId) ? inv.get(r.invoiceId)!.customer.nameAr ?? inv.get(r.invoiceId)!.customer.name : "",
    names: { createdBy: people.get(r.createdBy) ?? r.createdBy, receivedBy: r.receivedBy ? people.get(r.receivedBy) ?? r.receivedBy : null, approvedBy: r.approvedBy ? people.get(r.approvedBy) ?? r.approvedBy : null },
    lines: r.lines.map((l) => ({ ...l, quantity: l.quantity.toFixed(4), item: items.get(l.itemId) ? `${items.get(l.itemId)!.code} · ${items.get(l.itemId)!.nameAr ?? items.get(l.itemId)!.name}` : l.itemId, unit: items.get(l.itemId)?.baseUnit ?? "" })),
    creditNote: credited.get(r.id) ?? null,
  }));
}

/** Goods lines of an invoice with what is still out with the customer (for the return form). */
export async function returnableLines(invoiceId: string) {
  const { inv, lines } = await classifyLines(prisma, invoiceId);
  const out = [];
  for (const g of lines) {
    if (!g.item) continue;
    const s = await stillOut(g.line.id);
    out.push({ invoiceLineId: g.line.id, lineNo: g.line.lineNo, item: `${g.item.code} · ${g.item.nameAr ?? g.item.name}`, unit: g.item.baseUnit, sold: s.sold.toFixed(4), returned: s.returned.toFixed(4), pending: s.pending.toFixed(4), out: Prisma.Decimal.max(s.out, ZERO).toFixed(4) });
  }
  return { invoice: { id: inv.id, invoiceNo: inv.invoiceNo, status: inv.status, customerId: inv.customerId }, lines: out };
}
