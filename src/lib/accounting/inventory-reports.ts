// Inventory reports read from the cost subledger (InvMove, dated, immutable) and the ledger:
//   valuation as of a date, tied to each inventory account; stock card; cost of sales and gross
//   margin by invoice; goods received not invoiced (receipts and bill lines not yet matched); and
//   the agreement of accounting quantities with the operational stock records they link to.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ZERO, dec } from "./money";
import { KIND_ROLE } from "./inventory-rules";
import { accountsBalance, postingDates } from "./open-items";

async function roleAccounts(roles: string[]) {
  return new Map((await prisma.accountMapping.findMany({ where: { role: { in: roles } }, include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } } })).map((m) => [m.role, m.account]));
}

export async function inventoryValuation(asOf: Date, locationId?: string | null) {
  const rows = await prisma.$queryRaw<{ itemId: string; locationId: string; qty: string; value: string }[]>`
    SELECT "itemId", "locationId", SUM("qty")::text AS qty, SUM("value")::text AS value
      FROM "InvMove" WHERE "date" <= ${asOf} AND "kind" <> 'EXPENSED' ${locationId ? Prisma.sql`AND "locationId" = ${locationId}` : Prisma.empty}
     GROUP BY 1, 2`;
  const items = new Map((await prisma.invItem.findMany()).map((i) => [i.id, i]));
  const locations = new Map((await prisma.invLocation.findMany()).map((l) => [l.id, l]));
  const lines = rows.map((r) => {
    const it = items.get(r.itemId)!; const q = dec(r.qty), v = dec(r.value);
    const loc = locations.get(r.locationId);
    // A location with its own account (goods delivered, not invoiced) overrides the item's account.
    return { itemId: r.itemId, code: it.code, name: it.nameAr ?? it.name, kind: it.kind, baseUnit: it.baseUnit, locationId: r.locationId, location: loc?.nameAr ?? loc?.name ?? "", role: loc?.accountRole ?? KIND_ROLE[it.kind],
      qty: q.toFixed(4), value: v.toFixed(2), unitCost: q.isZero() ? null : v.div(q).toFixed(4) };
  }).filter((l) => !(dec(l.qty).isZero() && dec(l.value).isZero())).sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code) || a.location.localeCompare(b.location));

  // Tie-out per inventory account (company-wide; not per location).
  const roles = [...new Set([...Object.values(KIND_ROLE), ...[...locations.values()].map((l) => l.accountRole).filter((r): r is string => !!r)])];
  const acc = await roleAccounts(roles);
  const accounts = [];
  for (const role of roles) {
    const a = acc.get(role);
    const sub = lines.filter((l) => l.role === role).reduce((s, l) => s.add(l.value), ZERO);
    const ledger = a && !locationId ? await accountsBalance([a.id], asOf) : null;
    if (sub.isZero() && (!ledger || ledger.isZero())) continue;
    accounts.push({ role, account: a ? { code: a.code, name: a.nameAr ?? a.nameEn } : null, subledger: sub.toFixed(2), ledger: ledger?.toFixed(2) ?? null, difference: ledger ? ledger.sub(sub).toFixed(2) : null, reconciled: ledger ? ledger.equals(sub) : null });
  }
  const pending = await prisma.accountingEvent.count({ where: { eventType: "inv.document.posted", status: { in: ["PENDING", "BLOCKED", "FAILED"] } } });
  const provisional = await prisma.invDocument.count({ where: { status: "POSTED", provisional: true, docDate: { lte: asOf } } });
  const settings = await prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { inventoryCostMethod: true, inventoryPriceDifference: true } });
  return {
    asOf, locationId: locationId ?? null, lines, total: lines.reduce((s, l) => s.add(l.value), ZERO).toFixed(2), accounts,
    reconciled: !locationId && accounts.every((a) => a.reconciled !== false),
    explanation: { documentsWaitingToPost: pending, provisionalDocuments: provisional },
    settings: { costMethod: settings?.inventoryCostMethod ?? null, priceDifference: settings?.inventoryPriceDifference ?? null },
  };
}

export async function stockCard(itemId: string, from: Date, to: Date, locationId?: string | null) {
  const item = await prisma.invItem.findUnique({ where: { id: itemId }, include: { units: true } });
  if (!item) throw new AccountingError("Item not found.", 404);
  const where = { itemId, kind: { not: "EXPENSED" }, ...(locationId ? { locationId } : {}) };
  const before = await prisma.invMove.aggregate({ where: { ...where, date: { lt: from } }, _sum: { qty: true, value: true } });
  const moves = await prisma.invMove.findMany({ where: { ...where, date: { gte: from, lte: to } }, orderBy: [{ date: "asc" }, { seq: "asc" }], include: { document: { select: { id: true, docNo: true, type: true, description: true, issueReason: true } } } });
  const locations = new Map((await prisma.invLocation.findMany()).map((l) => [l.id, l.code]));
  let q = dec(before._sum.qty), v = dec(before._sum.value);
  const opening = { qty: q.toFixed(4), value: v.toFixed(2) };
  // One row per document line and direction: a weighted-average or FIFO issue drawn from several
  // cost layers writes one move per layer, shown here as a single row.
  const groups: { m: (typeof moves)[number]; qty: Prisma.Decimal; value: Prisma.Decimal }[] = [];
  for (const m of moves) {
    const last = groups.at(-1);
    if (last && last.m.documentId === m.documentId && last.m.lineId === m.lineId && last.m.kind === m.kind && last.m.locationId === m.locationId) { last.qty = last.qty.add(m.qty); last.value = last.value.add(m.value); }
    else groups.push({ m, qty: dec(m.qty), value: dec(m.value) });
  }
  const rows = groups.map(({ m, qty, value }) => {
    q = q.add(qty); v = v.add(value);
    return { date: m.date, docId: m.document.id, docNo: m.document.docNo, type: m.document.type, issueReason: m.document.issueReason, text: m.document.description, location: locations.get(m.locationId) ?? "",
      kind: m.kind, qty: qty.toFixed(4), value: value.toFixed(2), unitCost: qty.isZero() ? null : value.div(qty).abs().toFixed(4), balanceQty: q.toFixed(4), balanceValue: v.toFixed(2) };
  });
  return { item: { id: item.id, code: item.code, name: item.nameAr ?? item.name, kind: item.kind, baseUnit: item.baseUnit, units: item.units.map((u) => ({ unit: u.unit, factor: dec(u.factor).toString() })) }, from, to, opening, rows, closing: { qty: q.toFixed(4), value: v.toFixed(2) } };
}

export { grossMargin } from "./margin-report";

/**
 * Goods received not invoiced: posted receipt lines without a bill match, and posted bill stock lines without a receipt match.
 * Ledger (credit balance) = receipts − bills + landed costs without bill − returns awaiting credit + credits awaiting settlement.
 */
export async function grniStatus(asOf: Date) {
  const receipts = await prisma.invDocLine.findMany({ where: { document: { type: "RECEIPT", status: "POSTED", docDate: { lte: asOf } } }, include: { document: { select: { docNo: true, docDate: true, supplierId: true } }, item: { select: { code: true, name: true, nameAr: true } } } });
  const matches = await prisma.invDocLine.findMany({ where: { document: { type: "BILL_MATCH", status: "POSTED", docDate: { lte: asOf } } }, include: { document: { select: { billLineId: true } } } });
  const landed = await prisma.invDocument.findMany({ where: { type: "LANDED_COST", status: "POSTED", docDate: { lte: asOf } }, select: { id: true, docNo: true, docDate: true, amount: true, billLineId: true, description: true } });
  const matchedReceipt = new Set(matches.map((m) => m.targetLineId));
  const matchedBill = new Set([...matches.map((m) => m.document.billLineId), ...landed.map((l) => l.billLineId)].filter(Boolean));
  const landedAwaitingBill = landed.filter((l) => !l.billLineId).map((l) => ({ docId: l.id, docNo: l.docNo, date: l.docDate, description: l.description, amount: dec(l.amount).toFixed(2) }));
  const receiptValue = new Map((await prisma.invMove.findMany({ where: { kind: "IN", lineId: { in: receipts.map((r) => r.id) } } })).map((m) => [m.lineId!, dec(m.value)]));
  // Bills open on `asOf`: their posted journal is dated on or before it and any reversal journal after it.
  const candidates = await prisma.supplierBillLine.findMany({ where: { kind: "STOCK_RECEIPT", bill: { status: { in: ["POSTED", "REVERSED"] } } }, include: { bill: { select: { id: true, billNo: true, billDate: true, supplier: { select: { name: true } } } } } });
  const billDates = await postingDates(["ap.bill.posted", "ap.bill.reversed"], [...new Set(candidates.map((c) => c.bill.id))]);
  const billLines = candidates.filter((c) => { const d = billDates.get(c.bill.id); const p = d?.get("ap.bill.posted"), r = d?.get("ap.bill.reversed"); return !!p && p <= asOf && !(r && r <= asOf); });
  const suppliers = new Map((await prisma.supplier.findMany()).map((s) => [s.id, s.name]));
  const openReceipts = receipts.filter((r) => !matchedReceipt.has(r.id)).map((r) => ({ lineId: r.id, docNo: r.document.docNo, date: r.document.docDate, supplier: suppliers.get(r.document.supplierId ?? "") ?? "", item: r.item.nameAr ?? r.item.name, qty: dec(r.baseQty).toFixed(4), value: (receiptValue.get(r.id) ?? ZERO).toFixed(2) }));
  const openBills = billLines.filter((b) => !matchedBill.has(b.id)).map((b) => ({ billLineId: b.id, billNo: b.bill.billNo, date: b.bill.billDate, supplier: b.bill.supplier.name, description: b.description, net: dec(b.net).toFixed(2) }));
  const acc = (await roleAccounts(["GRNI"])).get("GRNI");
  const ledger = acc ? (await accountsBalance([acc.id], asOf)).neg() : null;
  // Supplier credit notes on this date (by their journal dates): a stock line credits GRNI; its
  // inventory settlement (SUPPLIER_CREDIT) clears it. A return is settled once a credit note that
  // names it has posted.
  const cnLines = await prisma.supplierBillLine.findMany({ where: { kind: { in: ["STOCK_RETURN", "STOCK_PRICE_ADJUSTMENT"] }, bill: { kind: "CREDIT_NOTE", status: { in: ["POSTED", "REVERSED"] } } }, include: { bill: { select: { id: true, billNo: true, supplier: { select: { name: true } } } } } });
  const cnDates = await postingDates(["ap.credit_note.posted", "ap.credit_note.reversed"], [...new Set(cnLines.map((l) => l.bill.id))]);
  const liveCn = cnLines.filter((l) => { const d = cnDates.get(l.bill.id); const p = d?.get("ap.credit_note.posted"), r = d?.get("ap.credit_note.reversed"); return !!p && p <= asOf && !(r && r <= asOf); });
  // Until its settlement posts, a credit note's line waits in "credits awaiting settlement" (its
  // credit to GRNI) and the return it names stays in "returns" (the return's debit to GRNI).
  const settlements = new Set((await prisma.invDocument.findMany({ where: { type: "SUPPLIER_CREDIT", status: "POSTED", docDate: { lte: asOf }, billLineId: { in: liveCn.map((l) => l.id) } }, select: { billLineId: true } })).map((d) => d.billLineId));
  const settledReturn = new Set(liveCn.filter((l) => l.kind === "STOCK_RETURN" && settlements.has(l.id)).map((l) => l.invDocumentId!));
  const creditsAwaitingSettlement = liveCn.filter((l) => !settlements.has(l.id)).map((l) => ({ billLineId: l.id, billNo: l.bill.billNo, supplier: l.bill.supplier.name, description: l.description, net: dec(l.net).toFixed(2) }));
  // Goods returned to suppliers (Dr GRNI) wait for the supplier's credit note.
  const returns = await prisma.invDocument.findMany({ where: { type: "SUPPLIER_RETURN", status: "POSTED", docDate: { lte: asOf }, id: { notIn: [...settledReturn] } }, include: { moves: true } });
  const supplierReturns = returns.map((r) => ({ docId: r.id, docNo: r.docNo, date: r.docDate, supplier: suppliers.get(r.supplierId ?? "") ?? "", value: r.moves.reduce((s, m) => s.add(dec(m.value)), ZERO).neg().toFixed(2) }));
  return { asOf, openReceipts, openBills, landedAwaitingBill, supplierReturns, creditsAwaitingSettlement,
    returnsTotal: supplierReturns.reduce((s, r) => s.add(r.value), ZERO).toFixed(2), landedTotal: landedAwaitingBill.reduce((s, l) => s.add(l.amount), ZERO).toFixed(2),
    receiptsTotal: openReceipts.reduce((s, r) => s.add(r.value), ZERO).toFixed(2), billsTotal: openBills.reduce((s, b) => s.add(b.net), ZERO).toFixed(2),
    creditsTotal: creditsAwaitingSettlement.reduce((s, c) => s.add(c.net), ZERO).toFixed(2),
    ledger: ledger?.toFixed(2) ?? null };
}

/** Accounting quantity per linked item vs the operational stock record (information only). */
export async function operationalAgreement() {
  const items = await prisma.invItem.findMany({ where: { OR: [{ greenBeanId: { not: null } }, { materialItemId: { not: null } }, { coffeeProductId: { not: null } }] } });
  const q = new Map((await prisma.$queryRaw<{ itemId: string; qty: string }[]>`SELECT "itemId", SUM("qty")::text AS qty FROM "InvMove" WHERE "kind" <> 'EXPENSED' GROUP BY 1`).map((r) => [r.itemId, dec(r.qty)]));
  const out = [];
  for (const it of items) {
    let operational: Prisma.Decimal | null = null, source = "";
    if (it.greenBeanId) { const g = await prisma.greenBean.findUnique({ where: { id: it.greenBeanId } }); operational = g ? new Prisma.Decimal(g.quantityKg) : null; source = "GreenBean.quantityKg"; }
    else if (it.materialItemId) { const m = await prisma.materialItem.findUnique({ where: { id: it.materialItemId } }); operational = m ? new Prisma.Decimal(m.quantityOnHand) : null; source = "MaterialItem.quantityOnHand"; }
    else if (it.coffeeProductId) { const r = await prisma.roastingBatch.aggregate({ where: { productId: it.coffeeProductId }, _sum: { roastedAvailableKg: true } }); operational = new Prisma.Decimal(r._sum.roastedAvailableKg ?? 0); source = "RoastingBatch.roastedAvailableKg"; }
    const acct = q.get(it.id) ?? ZERO;
    out.push({ itemId: it.id, code: it.code, name: it.nameAr ?? it.name, baseUnit: it.baseUnit, accounting: acct.toFixed(4), operational: operational?.toDecimalPlaces(4).toFixed(4) ?? null, source, difference: operational ? operational.toDecimalPlaces(4).sub(acct).toFixed(4) : null });
  }
  return out;
}
