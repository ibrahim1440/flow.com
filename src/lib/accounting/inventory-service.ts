// Inventory valuation and manufacturing costing (stage 4, docs/accounting/STAGE_4_DESIGN.md).
//
// Documents (receipt, supplier return, issue, transfer, production, sale issue, customer return,
// landed cost, bill match, count) follow the ledger's four-eyes lifecycle. Posting is one
// transaction that
//   1. locks every item-location it touches (advisory locks, sorted — concurrent postings of the
//      same stock queue instead of both reading the same layers),
//   2. refuses a date before a posted move of those item-locations (costs already issued would
//      change) and negative stock,
//   3. moves the document to POSTED (a conditional update: a retry or a second click finds it
//      posted and does nothing),
//   4. writes the cost moves and layer changes with the costing engine (inventory-costing.ts),
//   5. seals the moves. The journal follows from the moves (translators/inventory.ts).
// Decision D-1 is configurable: the costing method and price-difference treatment are settings,
// loss bands are approved records. Undecided → posting refused, except provisionally in an
// isolated test database (weighted average, the recommendation in DECISION_PACK §3).
import { Prisma, type InvDocType, type InvItemKind, type InvIssueReason, type InvCostMethod } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ledgerTx } from "./journal-service";
import { auditAccounting } from "./audit";
import { ZERO, dec } from "./money";
import { accountingDate, accountingDateOf, todayAccountingDate } from "./dates";
import { provisionalPostingAllowed } from "./policy";
import { processEvent, type ProcessOutcome } from "./event-processor";
import { YIELDING } from "./inventory-rules";
import { consume, costProduction, allocateAmount, onHandShare, toBase, m2, InsufficientStock, type Layer } from "./inventory-costing";

type Tx = Prisma.TransactionClient;
export const INV_SYSTEM = "system:accounting-engine";

const qty4 = (v: unknown, what: string) => {
  let d: Prisma.Decimal;
  try { d = new Prisma.Decimal(String(v ?? "").trim()); } catch { throw new AccountingError(`${what} is not a number.`, 400); }
  if (!d.isFinite() || d.decimalPlaces() > 4) throw new AccountingError(`${what} has more than 4 decimal places.`, 400);
  return d;
};
const money = (v: unknown, what: string) => {
  const d = qty4(v, what);
  if (d.decimalPlaces() > 2) throw new AccountingError(`${what} has more than 2 decimal places.`, 400);
  return d;
};
const text = (v: unknown, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// ─── Masters ────────────────────────────────────────────────────────────────────

const KINDS = new Set<InvItemKind>(["GREEN_COFFEE", "ROASTED_COFFEE", "PACKAGING", "MILK", "BAKERY_INGREDIENT", "FINISHED_GOOD", "RESALE_GOOD", "CONSUMABLE"]);

export async function createItem(b: Record<string, unknown>, userId: string) {
  const code = text(b.code, 40), name = text(b.name, 200), baseUnit = text(b.baseUnit, 20);
  if (!code || !name || !baseUnit) throw new AccountingError("Code, name and base unit are required.", 400);
  if (!KINDS.has(b.kind as InvItemKind)) throw new AccountingError("Choose the item kind.", 400);
  const yieldPerUnit = b.yieldPerUnit === undefined || b.yieldPerUnit === null || b.yieldPerUnit === "" ? dec(1) : qty4(b.yieldPerUnit, "Yield per unit");
  if (yieldPerUnit.lte(0)) throw new AccountingError("Yield per unit must be positive.", 400);
  return ledgerTx(async (tx) => {
    const item = await tx.invItem.create({ data: {
      code, name, nameAr: text(b.nameAr, 200), kind: b.kind as InvItemKind, baseUnit, yieldPerUnit, createdBy: userId,
      greenBeanId: text(b.greenBeanId, 40), coffeeProductId: text(b.coffeeProductId, 40), materialItemId: text(b.materialItemId, 40), productSkuId: text(b.productSkuId, 40),
    } });
    for (const u of Array.isArray(b.units) ? b.units as Record<string, unknown>[] : []) {
      const unit = text(u.unit, 20); if (!unit || unit === baseUnit) continue;
      const factor = qty4(u.factor, `Factor of ${unit}`); if (factor.lte(0)) throw new AccountingError(`Factor of ${unit} must be positive.`, 400);
      await tx.invUnit.create({ data: { itemId: item.id, unit, factor } });
    }
    await auditAccounting(tx, { action: "inventory.item.create", entityType: "inv_item", entityId: item.id, userId, after: item });
    return item;
  });
}

export async function setItemUnit(itemId: string, unit: string, factorIn: unknown, userId: string) {
  const factor = qty4(factorIn, "Factor");
  if (factor.lte(0)) throw new AccountingError("A conversion factor must be positive.", 400);
  return ledgerTx(async (tx) => {
    const item = await tx.invItem.findUnique({ where: { id: itemId } });
    if (!item) throw new AccountingError("Item not found.", 404);
    if (unit === item.baseUnit) throw new AccountingError("The base unit converts at 1 by definition.", 400);
    const u = await tx.invUnit.upsert({ where: { itemId_unit: { itemId, unit } }, update: { factor }, create: { itemId, unit, factor } });
    await auditAccounting(tx, { action: "inventory.unit.set", entityType: "inv_item", entityId: itemId, userId, after: u });
    return u;
  });
}

export async function createLocation(b: Record<string, unknown>, userId: string) {
  const code = text(b.code, 20), name = text(b.name, 200);
  if (!code || !name) throw new AccountingError("Code and name are required.", 400);
  return ledgerTx(async (tx) => {
    if (b.isSalesDefault === true) await tx.invLocation.updateMany({ where: { isSalesDefault: true }, data: { isSalesDefault: false } });
    const l = await tx.invLocation.create({ data: { code, name, nameAr: text(b.nameAr, 200), isSalesDefault: b.isSalesDefault === true } });
    await auditAccounting(tx, { action: "inventory.location.create", entityType: "inv_location", entityId: l.id, userId, after: l });
    return l;
  });
}

export async function createLossBand(b: Record<string, unknown>, userId: string) {
  const code = text(b.code, 40), name = text(b.name, 200), process = text(b.process, 20);
  if (!code || !name || !process) throw new AccountingError("Code, name and process are required.", 400);
  const pct = money(b.maxLossPercent, "Maximum normal loss %");
  if (pct.lt(0) || pct.gte(100)) throw new AccountingError("A loss band is between 0 and 100 percent.", 400);
  return ledgerTx(async (tx) => {
    const band = await tx.invLossBand.create({ data: { code, name, nameAr: text(b.nameAr, 200), process, maxLossPercent: pct, createdBy: userId } });
    await auditAccounting(tx, { action: "inventory.loss_band.create", entityType: "inv_loss_band", entityId: band.id, userId, after: band });
    return band;
  });
}

export async function approveLossBand(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const r = await tx.invLossBand.updateMany({ where: { id, status: "DRAFT" }, data: { status: "APPROVED", approvedBy: userId, approvedAt: new Date() } });
    if (r.count !== 1) throw new AccountingError("Only a draft loss band can be approved.", 409);
    const band = await tx.invLossBand.findUniqueOrThrow({ where: { id } });
    await auditAccounting(tx, { action: "inventory.loss_band.approve", entityType: "inv_loss_band", entityId: id, userId, after: band });
    return band;
  });
}

export async function retireLossBand(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const r = await tx.invLossBand.updateMany({ where: { id, status: "APPROVED" }, data: { status: "RETIRED" } });
    if (r.count !== 1) throw new AccountingError("Only an approved loss band can be retired.", 409);
    await auditAccounting(tx, { action: "inventory.loss_band.retire", entityType: "inv_loss_band", entityId: id, userId });
    return tx.invLossBand.findUniqueOrThrow({ where: { id } });
  });
}

/** D-1 settings. Neither changes once an inventory document has posted. */
export async function updateInventorySettings(b: { inventoryCostMethod?: unknown; inventoryPriceDifference?: unknown }, userId: string) {
  const data: { inventoryCostMethod?: InvCostMethod | null; inventoryPriceDifference?: "CAPITALISE" | "EXPENSE" | null } = {};
  if ("inventoryCostMethod" in b) {
    if (b.inventoryCostMethod !== null && b.inventoryCostMethod !== "WEIGHTED_AVERAGE" && b.inventoryCostMethod !== "FIFO") throw new AccountingError("The costing method is WEIGHTED_AVERAGE, FIFO or null (undecided).", 400);
    data.inventoryCostMethod = b.inventoryCostMethod as InvCostMethod | null;
  }
  if ("inventoryPriceDifference" in b) {
    if (b.inventoryPriceDifference !== null && b.inventoryPriceDifference !== "CAPITALISE" && b.inventoryPriceDifference !== "EXPENSE") throw new AccountingError("The price-difference treatment is CAPITALISE, EXPENSE or null (undecided).", 400);
    data.inventoryPriceDifference = b.inventoryPriceDifference as "CAPITALISE" | "EXPENSE" | null;
  }
  if (!Object.keys(data).length) throw new AccountingError("Nothing to change.", 400);
  return ledgerTx(async (tx) => {
    const before = await tx.accountingSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    const posted = await tx.invDocument.count({ where: { status: "POSTED" } });
    if (posted && data.inventoryCostMethod !== undefined && data.inventoryCostMethod !== before.inventoryCostMethod) throw new AccountingError("The costing method cannot change once inventory documents have posted.", 409);
    if (posted && data.inventoryPriceDifference !== undefined && before.inventoryPriceDifference && data.inventoryPriceDifference !== before.inventoryPriceDifference) throw new AccountingError("The price-difference treatment cannot change once inventory documents have posted.", 409);
    const after = await tx.accountingSettings.update({ where: { id: "singleton" }, data: { ...data, updatedBy: userId } });
    await auditAccounting(tx, { action: "settings.inventory", entityType: "settings", entityId: "singleton", userId,
      before: { inventoryCostMethod: before.inventoryCostMethod, inventoryPriceDifference: before.inventoryPriceDifference },
      after: { inventoryCostMethod: after.inventoryCostMethod, inventoryPriceDifference: after.inventoryPriceDifference } });
    return after;
  });
}

// ─── Documents ──────────────────────────────────────────────────────────────────

export type InvLineInput = { itemId?: unknown; quantity?: unknown; unit?: unknown; unitCost?: unknown; countedQty?: unknown; role?: unknown; targetLineId?: unknown; description?: unknown };
export type InvDocInput = {
  type?: unknown; docDate?: unknown; locationId?: unknown; toLocationId?: unknown; supplierId?: unknown; customerId?: unknown;
  description?: unknown; reason?: unknown; issueReason?: unknown; lossBandId?: unknown; amount?: unknown; allocationBasis?: unknown;
  billLineId?: unknown; sourceType?: unknown; sourceId?: unknown; requestKey?: unknown; lines?: unknown;
};

const TYPES = new Set<InvDocType>(["RECEIPT", "SUPPLIER_RETURN", "ISSUE", "TRANSFER", "PRODUCTION", "SALE_ISSUE", "CUSTOMER_RETURN", "LANDED_COST", "BILL_MATCH", "COUNT"]);
const REASONS = new Set<InvIssueReason>(["INTERNAL_USE", "CALIBRATION", "QC", "TRAINING", "SPOILAGE"]);

async function buildDoc(tx: Tx, input: InvDocInput) {
  const type = input.type as InvDocType;
  if (!TYPES.has(type)) throw new AccountingError("Choose the document type.", 400);
  if (!input.docDate) throw new AccountingError("The document date is required.", 400);
  const docDate = accountingDate(input.docDate);
  const locationId = String(input.locationId ?? "");
  if (!(await tx.invLocation.findFirst({ where: { id: locationId, isActive: true } }))) throw new AccountingError("Choose an active location.", 400);
  const toLocationId = type === "TRANSFER" ? String(input.toLocationId ?? "") : null;
  if (type === "TRANSFER") {
    if (!toLocationId || toLocationId === locationId) throw new AccountingError("A transfer goes to another location.", 400);
    if (!(await tx.invLocation.findFirst({ where: { id: toLocationId, isActive: true } }))) throw new AccountingError("Choose an active destination.", 400);
  }
  const issueReason = type === "ISSUE" ? (input.issueReason as InvIssueReason) : null;
  if (type === "ISSUE" && !REASONS.has(issueReason!)) throw new AccountingError("An issue needs its reason (internal use, calibration, QC, training or spoilage).", 400);
  if ((type === "RECEIPT" || type === "SUPPLIER_RETURN") && !(input.supplierId && await tx.supplier.findUnique({ where: { id: String(input.supplierId) } }))) throw new AccountingError("Choose the supplier.", 400);
  if (type === "CUSTOMER_RETURN" && !(input.customerId && await tx.customer.findUnique({ where: { id: String(input.customerId) } }))) throw new AccountingError("Choose the customer.", 400);
  const billLineId = (type === "BILL_MATCH" || type === "LANDED_COST") && input.billLineId ? String(input.billLineId) : null;
  if (type === "BILL_MATCH" && !billLineId) throw new AccountingError("Choose the supplier bill line.", 400);
  let billNet: Prisma.Decimal | null = null;
  if (billLineId) {
    const bl = await tx.supplierBillLine.findUnique({ where: { id: billLineId }, include: { bill: true } });
    if (!bl || bl.kind !== "STOCK_RECEIPT" || bl.bill.status !== "POSTED") throw new AccountingError("Choose a stock line of a posted supplier bill.", 400);
    billNet = dec(bl.net);
  }
  // A landed cost from a bill line (freight, customs) takes that line's amount; otherwise it is entered.
  const amount = type === "LANDED_COST" ? (billNet ?? money(input.amount, "Amount")) : null;
  if (type === "LANDED_COST" && amount!.lte(0)) throw new AccountingError("A landed cost is a positive amount.", 400);
  const allocationBasis = type === "LANDED_COST" ? (input.allocationBasis === "QUANTITY" ? "QUANTITY" : "VALUE") : null;
  const lossBandId = type === "PRODUCTION" && input.lossBandId ? String(input.lossBandId) : null;
  if (lossBandId && !(await tx.invLossBand.findUnique({ where: { id: lossBandId } }))) throw new AccountingError("Loss band not found.", 400);
  if (type === "SALE_ISSUE" && input.sourceType !== "SALES_INVOICE") throw new AccountingError("Cost of sales is created from a posted sales invoice.", 400);
  if (!Array.isArray(input.lines) || !input.lines.length) throw new AccountingError("A document needs at least one line.", 400);
  if (input.lines.length > 300) throw new AccountingError("A document may have at most 300 lines.", 400);
  const itemIds = [...new Set((input.lines as InvLineInput[]).map((l) => String(l.itemId ?? "")))];
  const items = new Map((await tx.invItem.findMany({ where: { id: { in: itemIds } }, include: { units: true } })).map((i) => [i.id, i]));
  const lines = (input.lines as InvLineInput[]).map((l, i) => {
    const n = i + 1;
    const item = items.get(String(l.itemId ?? ""));
    if (!item || !item.isActive) throw new AccountingError(`Line ${n}: choose an active item.`, 400);
    const unit = text(l.unit, 20) ?? item.baseUnit;
    const factor = unit === item.baseUnit ? dec(1) : item.units.find((u) => u.unit === unit)?.factor;
    if (!factor) throw new AccountingError(`Line ${n}: ${item.code} has no conversion for "${unit}".`, 400);
    const role = type === "PRODUCTION" ? (l.role === "OUTPUT" ? "OUTPUT" : l.role === "INPUT" ? "INPUT" : null) : "LINE";
    if (!role) throw new AccountingError(`Line ${n}: a production line is an input or an output.`, 400);
    const quantity = type === "COUNT" || type === "LANDED_COST" || type === "BILL_MATCH" ? (l.quantity === undefined || l.quantity === "" ? dec(0) : qty4(l.quantity, `Line ${n} quantity`)) : qty4(l.quantity, `Line ${n} quantity`);
    if (quantity.lt(0) || (!["COUNT", "LANDED_COST", "BILL_MATCH"].includes(type) && quantity.isZero())) throw new AccountingError(`Line ${n}: the quantity must be positive.`, 400);
    const unitCost = l.unitCost === undefined || l.unitCost === null || l.unitCost === "" ? null : qty4(l.unitCost, `Line ${n} unit cost`);
    if (type === "RECEIPT" && (!unitCost || unitCost.lt(0))) throw new AccountingError(`Line ${n}: a receipt line needs its cost per ${item.baseUnit}.`, 400);
    const countedQty = type === "COUNT" ? qty4(l.countedQty, `Line ${n} counted quantity`) : null;
    if (countedQty && countedQty.lt(0)) throw new AccountingError(`Line ${n}: a count cannot be negative.`, 400);
    const targetLineId = text(l.targetLineId, 40);
    if (["LANDED_COST", "BILL_MATCH"].includes(type) && !targetLineId) throw new AccountingError(`Line ${n}: choose the receipt line.`, 400);
    if (type === "CUSTOMER_RETURN" && !targetLineId) throw new AccountingError(`Line ${n}: choose the sale it returns from.`, 400);
    const baseQty = toBase(quantity, factor);
    return { lineNo: n, role: role as "LINE" | "INPUT" | "OUTPUT", itemId: item.id, quantity, unit, factor, baseQty: type === "COUNT" ? toBase(countedQty!, factor) : baseQty, unitCost, countedQty: countedQty ? toBase(countedQty, factor) : null, targetLineId, description: text(l.description, 300) };
  });
  if (type === "PRODUCTION" && (!lines.some((l) => l.role === "INPUT") || !lines.some((l) => l.role === "OUTPUT"))) throw new AccountingError("A production has inputs and outputs.", 400);
  if (type === "BILL_MATCH" && lines.length !== 1) throw new AccountingError("A bill match joins one bill line to one receipt line.", 400);
  return {
    header: {
      type, docDate, locationId, toLocationId, issueReason, amount, allocationBasis, lossBandId, billLineId,
      supplierId: text(input.supplierId, 40), customerId: text(input.customerId, 40), description: text(input.description), reason: text(input.reason),
      sourceType: text(input.sourceType, 40), sourceId: text(input.sourceId, 40), requestKey: text(input.requestKey, 80),
    },
    lines,
  };
}

export async function createInvDoc(input: InvDocInput, userId: string) {
  return ledgerTx(async (tx) => {
    const key = text(input.requestKey, 80);
    if (key) { const seen = await tx.invDocument.findUnique({ where: { requestKey: key }, include: { lines: true } }); if (seen) return seen; }   // a retried create returns the first
    const { header, lines } = await buildDoc(tx, input);
    if (header.sourceType && header.sourceId && await tx.invDocument.findUnique({ where: { sourceType_sourceId: { sourceType: header.sourceType, sourceId: header.sourceId } } })) {
      throw new AccountingError("A document already exists for that source.", 409);
    }
    const d = await tx.invDocument.create({ data: { ...header, createdBy: userId, lines: { create: lines } }, include: { lines: true } });
    await auditAccounting(tx, { action: "inventory.document.create", entityType: "inv_document", entityId: d.id, userId, after: { type: d.type, docNo: d.docNo, lines: lines.length } });
    return d;
  });
}

export async function updateDraftInvDoc(id: string, input: InvDocInput, userId: string) {
  return ledgerTx(async (tx) => {
    const d = await tx.invDocument.findUnique({ where: { id } });
    if (!d) throw new AccountingError("Document not found.", 404);
    if (d.status !== "DRAFT") throw new AccountingError("Only a draft can be edited.", 409);
    const { header, lines } = await buildDoc(tx, { ...input, type: d.type, sourceType: d.sourceType, sourceId: d.sourceId });
    await tx.invDocLine.deleteMany({ where: { documentId: id } });
    const { requestKey: _k, sourceType: _s, sourceId: _i, ...rest } = header; void _k; void _s; void _i;
    const out = await tx.invDocument.update({ where: { id }, data: { ...rest, rejectedBy: null, rejectedAt: null, rejectedReason: null, lines: { create: lines } }, include: { lines: true } });
    await auditAccounting(tx, { action: "inventory.document.update", entityType: "inv_document", entityId: id, userId });
    return out;
  });
}

export async function deleteDraftInvDoc(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const r = await tx.invDocument.deleteMany({ where: { id, status: "DRAFT" } });
    if (r.count !== 1) throw new AccountingError("Only a draft can be deleted.", 409);
    await auditAccounting(tx, { action: "inventory.document.delete", entityType: "inv_document", entityId: id, userId });
    return { deleted: true };
  });
}

async function move(tx: Tx, id: string, from: "DRAFT" | "SUBMITTED" | "APPROVED", data: Prisma.InvDocumentUpdateManyMutationInput, what: string) {
  const r = await tx.invDocument.updateMany({ where: { id, status: from }, data });
  if (r.count !== 1) {
    const d = await tx.invDocument.findUnique({ where: { id } });
    if (!d) throw new AccountingError("Document not found.", 404);
    throw new AccountingError(`The document is ${d.status.toLowerCase()}; it cannot be ${what}.`, 409);
  }
  return tx.invDocument.findUniqueOrThrow({ where: { id } });
}

export async function submitInvDoc(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const d = await move(tx, id, "DRAFT", { status: "SUBMITTED", submittedBy: userId, submittedAt: new Date() }, "submitted");
    await auditAccounting(tx, { action: "inventory.document.submit", entityType: "inv_document", entityId: id, userId });
    return d;
  });
}

export async function approveInvDoc(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const cur = await tx.invDocument.findUnique({ where: { id } });
    if (!cur) throw new AccountingError("Document not found.", 404);
    if (cur.createdBy === userId || cur.submittedBy === userId) throw new AccountingError("A document is approved by someone other than the person who prepared or submitted it.", 403);
    const d = await move(tx, id, "SUBMITTED", { status: "APPROVED", approvedBy: userId, approvedAt: new Date() }, "approved");
    await auditAccounting(tx, { action: "inventory.document.approve", entityType: "inv_document", entityId: id, userId });
    return d;
  });
}

export async function rejectInvDoc(id: string, userId: string, reason: string) {
  const why = reason?.trim();
  if (!why || why.length < 5) throw new AccountingError("A rejection needs a reason (at least 5 characters).", 400);
  return ledgerTx(async (tx) => {
    const d = await move(tx, id, "SUBMITTED", { status: "DRAFT", rejectedBy: userId, rejectedAt: new Date(), rejectedReason: why, submittedBy: null, submittedAt: null }, "rejected");
    await auditAccounting(tx, { action: "inventory.document.reject", entityType: "inv_document", entityId: id, userId, reason: why });
    return d;
  });
}

// ─── Posting ───────────────────────────────────────────────────────────────────

type Doc = Prisma.InvDocumentGetPayload<{ include: { lines: { include: { item: true } } } }>;

async function layersOf(tx: Tx, itemId: string, locationId: string): Promise<Layer[]> {
  const ls = await tx.invLayer.findMany({ where: { itemId, locationId, qtyLeft: { gt: 0 } }, orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
  return ls.map((l) => ({ id: l.id, qtyLeft: dec(l.qtyLeft), valueLeft: dec(l.valueLeft) }));
}

export async function onHand(db: Tx | typeof prisma, itemId: string, locationId: string) {
  const r = await db.invLayer.aggregate({ where: { itemId, locationId }, _sum: { qtyLeft: true, valueLeft: true } });
  return { qty: dec(r._sum.qtyLeft), value: dec(r._sum.valueLeft) };
}

/** Receive into a new layer. */
async function receive(tx: Tx, d: Doc, lineId: string | null, itemId: string, locationId: string, qty: Prisma.Decimal, value: Prisma.Decimal) {
  const mv = await tx.invMove.create({ data: { documentId: d.id, lineId, itemId, locationId, date: d.docDate, kind: "IN", qty, value } });
  await tx.invLayer.create({ data: { itemId, locationId, moveId: mv.id, date: d.docDate, qtyIn: qty, valueIn: value, qtyLeft: qty, valueLeft: value } });
  return mv;
}

/** Issue from layers (optionally preferring one layer first), writing OUT moves; returns the value issued. */
async function issue(tx: Tx, d: Doc, lineId: string | null, itemId: string, locationId: string, qty: Prisma.Decimal, method: InvCostMethod, preferLayerId?: string | null) {
  let layers = await layersOf(tx, itemId, locationId);
  const takes: { layerId: string; qty: Prisma.Decimal; value: Prisma.Decimal }[] = [];
  let left = qty;
  if (preferLayerId) {
    const p = layers.find((l) => l.id === preferLayerId);
    if (p) { const t = consume([p], Prisma.Decimal.min(left, p.qtyLeft), "FIFO"); takes.push(...t); left = left.sub(t[0].qty); layers = layers.map((l) => (l.id === p.id ? { ...l, qtyLeft: l.qtyLeft.sub(t[0].qty), valueLeft: l.valueLeft.sub(t[0].value) } : l)); }
  }
  if (left.gt(0)) {
    try { takes.push(...consume(layers, left, method)); }
    catch (e) {
      if (e instanceof InsufficientStock) {
        const item = await tx.invItem.findUnique({ where: { id: itemId } });
        const loc = await tx.invLocation.findUnique({ where: { id: locationId } });
        throw new AccountingError(`Not enough ${item?.code} at ${loc?.code}: ${e.available.add(qty.sub(left)).toFixed(4)} ${item?.baseUnit} on hand, ${qty.toFixed(4)} needed. Stock cannot go negative.`, 409);
      }
      throw e;
    }
  }
  let value = ZERO;
  for (const t of takes) {
    await tx.invMove.create({ data: { documentId: d.id, lineId, itemId, locationId, date: d.docDate, kind: "OUT", qty: t.qty.neg(), value: t.value.neg(), layerId: t.layerId } });
    await tx.invLayer.update({ where: { id: t.layerId }, data: { qtyLeft: { decrement: t.qty }, valueLeft: { decrement: t.value } } });
    value = value.add(t.value);
  }
  return { value, takes };
}

/** Revalue what is left of a receipt layer; the part for stock already used is expensed. */
async function revalue(tx: Tx, d: Doc, lineId: string, layerId: string, amount: Prisma.Decimal) {
  const layer = await tx.invLayer.findUniqueOrThrow({ where: { id: layerId } });
  let { onHand: keep, consumed } = onHandShare(amount, { qtyIn: dec(layer.qtyIn), qtyLeft: dec(layer.qtyLeft) });
  if (dec(layer.qtyLeft).isZero()) { consumed = amount; keep = ZERO; }
  if (keep.isNegative() && keep.abs().gt(dec(layer.valueLeft))) { consumed = consumed.add(keep.add(dec(layer.valueLeft))); keep = dec(layer.valueLeft).neg(); }   // cannot take a layer below zero
  if (!keep.isZero()) {
    await tx.invMove.create({ data: { documentId: d.id, lineId, itemId: layer.itemId, locationId: layer.locationId, date: d.docDate, kind: "REVALUE", qty: ZERO, value: keep, layerId } });
    await tx.invLayer.update({ where: { id: layerId }, data: { valueLeft: { increment: keep } } });
  }
  if (!consumed.isZero()) await tx.invMove.create({ data: { documentId: d.id, lineId, itemId: layer.itemId, locationId: layer.locationId, date: d.docDate, kind: "EXPENSED", qty: ZERO, value: consumed } });
}

/** The receipt layer a receipt line created. */
async function receiptLayer(tx: Tx, receiptLineId: string) {
  const mv = await tx.invMove.findFirst({ where: { lineId: receiptLineId, kind: "IN", document: { type: "RECEIPT", status: "POSTED" } } });
  if (!mv) throw new AccountingError("The receipt line is not posted.", 409);
  return { move: mv, layer: await tx.invLayer.findUniqueOrThrow({ where: { moveId: mv.id } }) };
}

export type InvPostOutcome = { document: Awaited<ReturnType<typeof getInvDoc>>; ledger: ProcessOutcome | null };

export async function postInvDoc(id: string, userId: string): Promise<InvPostOutcome> {
  await ledgerTx(async (tx) => {
    const cur = await tx.invDocument.findUnique({ where: { id }, include: { lines: { include: { item: true }, orderBy: { lineNo: "asc" } } } });
    if (!cur) throw new AccountingError("Document not found.", 404);
    if (cur.status !== "APPROVED") throw new AccountingError(cur.status === "POSTED" ? "The document has already posted." : "Only an approved document can be posted.", 409);

    // D-1 settings (snapshotted onto the document).
    const settings = await tx.accountingSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    const provisionalOk = await provisionalPostingAllowed(tx);
    const pending: string[] = [];
    if (!settings.inventoryCostMethod) pending.push("the inventory costing method (decision D-1) is not set");
    if (cur.type === "BILL_MATCH" && !settings.inventoryPriceDifference) pending.push("the treatment of supplier price differences (decision D-1) is not set");
    let bandPercent: Prisma.Decimal | null = null;
    if (cur.lossBandId) {
      const band = await tx.invLossBand.findUniqueOrThrow({ where: { id: cur.lossBandId } });
      if (band.status !== "APPROVED") pending.push(`loss band ${band.code} is not approved`);
      bandPercent = dec(band.maxLossPercent);
    }
    if (pending.length && !provisionalOk) throw new AccountingError(`Waiting for decision D-1: ${pending.join("; ")}.`, 409);
    const method: InvCostMethod = settings.inventoryCostMethod ?? "WEIGHTED_AVERAGE";
    const priceDifference = settings.inventoryPriceDifference ?? "CAPITALISE";

    const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: cur.docDate }, endDate: { gte: cur.docDate } } });
    if (!period || period.status !== "OPEN") throw new AccountingError(`The period of ${cur.docDate.toISOString().slice(0, 10)} is not open.`, 409);

    // Every item-location the document touches, locked in a fixed order.
    const targets = cur.type === "LANDED_COST" || cur.type === "BILL_MATCH"
      ? await Promise.all(cur.lines.map(async (l) => (await receiptLayer(tx, l.targetLineId!)).layer))
      : [];
    const pairs = new Set<string>();
    for (const l of cur.lines) { pairs.add(`${l.itemId}|${cur.locationId}`); if (cur.toLocationId) pairs.add(`${l.itemId}|${cur.toLocationId}`); }
    for (const t of targets) pairs.add(`${t.itemId}|${t.locationId}`);
    for (const p of [...pairs].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"inv:" + p}))`;
    for (const p of pairs) {
      const [itemId, locationId] = p.split("|");
      const last = await tx.invMove.findFirst({ where: { itemId, locationId }, orderBy: { date: "desc" }, select: { date: true, document: { select: { docNo: true } } } });
      if (last && last.date > cur.docDate) {
        const item = cur.lines.find((l) => l.itemId === itemId)?.item;
        throw new AccountingError(`${item?.code ?? "An item"} already has a posted movement on ${last.date.toISOString().slice(0, 10)} (document ${last.document.docNo}); a document dated ${cur.docDate.toISOString().slice(0, 10)} would change costs already issued. Date it on or after that day.`, 409);
      }
    }

    const posted = await tx.invDocument.updateMany({ where: { id, status: "APPROVED" }, data: {
      status: "POSTED", postedBy: userId, postedAt: new Date(), costMethod: method, priceDifference: cur.type === "BILL_MATCH" ? priceDifference : null,
      lossBandPercent: bandPercent, provisional: pending.length > 0,
    } });
    if (posted.count !== 1) throw new AccountingError("The document has already posted.", 409);
    const d = cur as Doc;

    switch (d.type) {
      case "RECEIPT":
        for (const l of d.lines) await receive(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), m2(dec(l.baseQty).mul(dec(l.unitCost))));
        break;
      case "SUPPLIER_RETURN":
        for (const l of d.lines) {
          const prefer = l.targetLineId ? (await receiptLayer(tx, l.targetLineId)).layer.id : null;
          await issue(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), method, prefer);
        }
        break;
      case "ISSUE": case "SALE_ISSUE":
        for (const l of d.lines) await issue(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), method);
        break;
      case "TRANSFER":
        for (const l of d.lines) {
          const out = await issue(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), method);
          for (const t of out.takes) await receive(tx, d, l.id, l.itemId, d.toLocationId!, t.qty, t.value);   // same cost, at the destination
        }
        break;
      case "CUSTOMER_RETURN":
        for (const l of d.lines) {
          const sold = await tx.invMove.findMany({ where: { lineId: l.targetLineId!, kind: "OUT", document: { type: "SALE_ISSUE", status: "POSTED" } } });
          if (!sold.length) throw new AccountingError(`Line ${l.lineNo}: the sale it returns from is not posted.`, 409);
          const soldQty = sold.reduce((s, m) => s.add(dec(m.qty).neg()), ZERO), soldValue = sold.reduce((s, m) => s.add(dec(m.value).neg()), ZERO);
          const prior = await tx.invDocLine.findMany({ where: { targetLineId: l.targetLineId!, document: { type: "CUSTOMER_RETURN", status: "POSTED" }, NOT: { documentId: d.id } }, select: { id: true } });
          const earlier = await tx.invMove.findMany({ where: { kind: "IN", lineId: { in: prior.map((x) => x.id) } } });
          const already = earlier.reduce((s, m) => s.add(dec(m.qty)), ZERO), alreadyValue = earlier.reduce((s, m) => s.add(dec(m.value)), ZERO);
          if (dec(l.baseQty).add(already).gt(soldQty)) throw new AccountingError(`Line ${l.lineNo}: returns would exceed the ${soldQty.toFixed(4)} sold.`, 409);
          // Back at the cost it left at; the last of it takes exactly what remains of the sold value.
          const value = dec(l.baseQty).add(already).equals(soldQty) ? soldValue.sub(alreadyValue) : m2(soldValue.mul(dec(l.baseQty)).div(soldQty));
          await receive(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), value);
        }
        break;
      case "COUNT":
        for (const l of d.lines) {
          const have = await onHand(tx, l.itemId, d.locationId);
          const diff = dec(l.countedQty).sub(have.qty);
          if (diff.isNegative()) await issue(tx, d, l.id, l.itemId, d.locationId, diff.abs(), method);
          else if (diff.isPositive()) {
            const unit = have.qty.gt(0) ? have.value.div(have.qty) : l.unitCost ? dec(l.unitCost) : null;
            if (!unit) throw new AccountingError(`Line ${l.lineNo}: ${l.item.code} has no stock to value the surplus at; enter a cost per ${l.item.baseUnit}.`, 400);
            await receive(tx, d, l.id, l.itemId, d.locationId, diff, m2(diff.mul(unit)));
          }
        }
        break;
      case "PRODUCTION": {
        const ins: { key: string; value: Prisma.Decimal; yieldQty: Prisma.Decimal }[] = [];
        for (const l of d.lines.filter((x) => x.role === "INPUT")) {
          const out = await issue(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), method);
          ins.push({ key: l.id, value: out.value, yieldQty: YIELDING.has(l.item.kind) ? dec(l.baseQty).mul(dec(l.item.yieldPerUnit)) : ZERO });
        }
        const outs = d.lines.filter((x) => x.role === "OUTPUT").map((l) => ({ key: l.id, yieldQty: dec(l.baseQty).mul(dec(l.item.yieldPerUnit)) }));
        const yieldIn = ins.reduce((s, x) => s.add(x.yieldQty), ZERO), yieldOut = outs.reduce((s, x) => s.add(x.yieldQty), ZERO);
        if (yieldIn.gt(yieldOut) && bandPercent === null && !provisionalOk) throw new AccountingError("This production loses weight: choose the approved loss band of its process (decision D-1).", 409);
        let r;
        try { r = costProduction(ins, outs, bandPercent); } catch (e) { throw new AccountingError((e as Error).message, 400); }
        for (const o of r.outputs) {
          const l = d.lines.find((x) => x.id === o.key)!;
          await receive(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), o.value);
        }
        break;
      }
      case "LANDED_COST": {
        const w = await Promise.all(d.lines.map(async (l) => { const { move: mv } = await receiptLayer(tx, l.targetLineId!); return { key: l.id, weight: d.allocationBasis === "QUANTITY" ? dec(mv.qty) : dec(mv.value) }; }));
        for (const a of allocateAmount(dec(d.amount), w)) { const l = d.lines.find((x) => x.id === a.key)!; await revalue(tx, d, l.id, (await receiptLayer(tx, l.targetLineId!)).layer.id, a.amount); }
        break;
      }
      case "BILL_MATCH": {
        const l = d.lines[0];
        const bl = await tx.supplierBillLine.findUniqueOrThrow({ where: { id: d.billLineId! } });
        const { move: mv, layer } = await receiptLayer(tx, l.targetLineId!);
        const diff = dec(bl.net).sub(dec(mv.value));
        if (!diff.isZero()) {
          if (priceDifference === "CAPITALISE") await revalue(tx, d, l.id, layer.id, diff);
          else await tx.invMove.create({ data: { documentId: d.id, lineId: l.id, itemId: layer.itemId, locationId: layer.locationId, date: d.docDate, kind: "EXPENSED", qty: ZERO, value: diff } });
        }
        break;
      }
    }
    await tx.invDocument.update({ where: { id }, data: { movesSealed: true } });
    await auditAccounting(tx, { action: "inventory.document.post", entityType: "inv_document", entityId: id, userId, after: { method, bandPercent: bandPercent?.toFixed(2) ?? null, provisional: pending.length > 0, pending } });
  });
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `inventory:${id}:inv.document.posted` }, select: { id: true } });
  return { document: await getInvDoc(id), ledger: ev ? await processEvent(ev.id) : null };
}

export async function getInvDoc(id: string) {
  const d = await prisma.invDocument.findUnique({ where: { id }, include: { lines: { include: { item: true }, orderBy: [{ lineNo: "asc" }] }, moves: { orderBy: { seq: "asc" } } } });
  if (!d) throw new AccountingError("Document not found.", 404);
  return d;
}

// ─── Documents made from other records ─────────────────────────────────────────

/**
 * Cost of sales for a posted sales invoice: its lines that name a product SKU linked to an
 * inventory item leave the sales location at cost, dated on the invoice. Made by the system and
 * approved by the invoice's approver (its four-eyes already happened); one per invoice (unique
 * source), so a retry finds the first. If it cannot post yet (D-1 undecided, not enough stock),
 * it stays APPROVED with the reason and can be posted later.
 */
export async function saleIssueForInvoice(invoiceId: string): Promise<{ documentId: string | null; posted: boolean; reason?: string }> {
  const inv = await prisma.salesInvoice.findUnique({ where: { id: invoiceId }, include: { lines: true } });
  if (!inv || inv.kind !== "INVOICE" || inv.status !== "POSTED") return { documentId: null, posted: false, reason: "not a posted invoice" };
  let doc = await prisma.invDocument.findUnique({ where: { sourceType_sourceId: { sourceType: "SALES_INVOICE", sourceId: invoiceId } } });
  if (!doc) {
    const skus = inv.lines.map((l) => l.productSkuId).filter(Boolean) as string[];
    const items = new Map((await prisma.invItem.findMany({ where: { productSkuId: { in: skus } } })).map((i) => [i.productSkuId!, i]));
    const lines = inv.lines.filter((l) => l.productSkuId && items.has(l.productSkuId)).map((l) => ({ itemId: items.get(l.productSkuId!)!.id, quantity: dec(l.quantity).toFixed(4), unit: items.get(l.productSkuId!)!.baseUnit, description: `INV-${inv.invoiceNo} line ${l.lineNo}` }));
    if (!lines.length) return { documentId: null, posted: false, reason: "no invoice line names a stocked product" };
    const loc = await prisma.invLocation.findFirst({ where: { isSalesDefault: true, isActive: true } });
    if (!loc) return { documentId: null, posted: false, reason: "no sales location is set" };
    try {
      doc = await ledgerTx(async (tx) => {
        const { header, lines: ls } = await buildDoc(tx, { type: "SALE_ISSUE", docDate: inv.issueDate.toISOString().slice(0, 10), locationId: loc.id, customerId: inv.customerId, sourceType: "SALES_INVOICE", sourceId: inv.id, description: `Cost of sales · INV-${inv.invoiceNo}`, lines });
        const created = await tx.invDocument.create({ data: { ...header, customerId: inv.customerId, createdBy: INV_SYSTEM, lines: { create: ls } } });
        await tx.invDocument.update({ where: { id: created.id }, data: { status: "SUBMITTED", submittedBy: INV_SYSTEM, submittedAt: new Date() } });
        const approved = await tx.invDocument.update({ where: { id: created.id }, data: { status: "APPROVED", approvedBy: inv.approvedBy ?? inv.postedBy ?? "unknown", approvedAt: new Date() } });
        await auditAccounting(tx, { action: "inventory.sale_issue.create", entityType: "inv_document", entityId: created.id, userId: INV_SYSTEM, refs: { invoiceId } });
        return approved;
      });
    } catch (e) {
      const again = await prisma.invDocument.findUnique({ where: { sourceType_sourceId: { sourceType: "SALES_INVOICE", sourceId: invoiceId } } });
      if (!again) throw e;
      doc = again;   // created by a concurrent call
    }
  }
  if (doc.status === "POSTED") return { documentId: doc.id, posted: true };
  try { await postInvDoc(doc.id, INV_SYSTEM); return { documentId: doc.id, posted: true }; }
  catch (e) { if (e instanceof AccountingError) return { documentId: doc.id, posted: false, reason: e.message }; throw e; }
}

/**
 * Invoice reversed after its cost of sales posted: the goods come back at the cost they left at,
 * dated on the reversal (a system customer return, one per invoice).
 */
export async function returnForReversedInvoice(invoiceId: string): Promise<{ documentId: string | null; posted: boolean; reason?: string }> {
  const inv = await prisma.salesInvoice.findUnique({ where: { id: invoiceId } });
  const sale = await prisma.invDocument.findUnique({ where: { sourceType_sourceId: { sourceType: "SALES_INVOICE", sourceId: invoiceId } }, include: { lines: true } });
  if (!inv || inv.status !== "REVERSED" || !sale || sale.status !== "POSTED") return { documentId: null, posted: false, reason: "no posted cost of sales to return" };
  let doc = await prisma.invDocument.findUnique({ where: { sourceType_sourceId: { sourceType: "SALES_INVOICE_REVERSAL", sourceId: invoiceId } } });
  if (!doc) {
    try {
      doc = await ledgerTx(async (tx) => {
        const { header, lines } = await buildDoc(tx, { type: "CUSTOMER_RETURN", docDate: accountingDateOf(inv.reversedAt ?? new Date()).toISOString().slice(0, 10), locationId: sale.locationId, customerId: inv.customerId,
          sourceType: "SALES_INVOICE_REVERSAL", sourceId: inv.id, description: `Invoice INV-${inv.invoiceNo} reversed`,
          lines: await (async () => {
            // Only what is still out: the sale less customer returns already posted against it.
            const back = await tx.invDocLine.findMany({ where: { targetLineId: { in: sale.lines.map((l) => l.id) }, document: { type: "CUSTOMER_RETURN", status: "POSTED" } } });
            return sale.lines.map((l) => ({ itemId: l.itemId, quantity: dec(l.baseQty).sub(back.filter((b) => b.targetLineId === l.id).reduce((s, b) => s.add(dec(b.baseQty)), ZERO)).toFixed(4), targetLineId: l.id }))
              .filter((l) => new Prisma.Decimal(l.quantity).gt(0));
          })() });
        const created = await tx.invDocument.create({ data: { ...header, createdBy: INV_SYSTEM, lines: { create: lines } } });
        await tx.invDocument.update({ where: { id: created.id }, data: { status: "SUBMITTED", submittedBy: INV_SYSTEM, submittedAt: new Date() } });
        return tx.invDocument.update({ where: { id: created.id }, data: { status: "APPROVED", approvedBy: inv.reversedBy ?? "unknown", approvedAt: new Date() } });
      });
    } catch (e) {
      const again = await prisma.invDocument.findUnique({ where: { sourceType_sourceId: { sourceType: "SALES_INVOICE_REVERSAL", sourceId: invoiceId } } });
      if (!again) throw e;
      doc = again;
    }
  }
  if (doc.status === "POSTED") return { documentId: doc.id, posted: true };
  try { await postInvDoc(doc.id, INV_SYSTEM); return { documentId: doc.id, posted: true }; }
  catch (e) { if (e instanceof AccountingError) return { documentId: doc.id, posted: false, reason: e.message }; throw e; }
}

/** Draft production from a roasting batch: its green coffee in, its roasted coffee out. */
export async function productionDraftFromRoastingBatch(batchId: string, b: { locationId?: unknown; lossBandId?: unknown; docDate?: unknown }, userId: string) {
  const batch = await prisma.roastingBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new AccountingError("Roasting batch not found.", 404);
  if (batch.isBlend) throw new AccountingError("A blend combines roasted coffee already costed; it is not a roast.", 400);
  if (!batch.greenBeanId || !batch.productId) throw new AccountingError("The batch names no green coffee or no product.", 400);
  const green = await prisma.invItem.findUnique({ where: { greenBeanId: batch.greenBeanId } });
  const roasted = await prisma.invItem.findUnique({ where: { coffeeProductId: batch.productId } });
  if (!green || !roasted) throw new AccountingError("Link the green coffee and the roasted product to inventory items first.", 400);
  return createInvDoc({
    type: "PRODUCTION", docDate: b.docDate ?? batch.date.toISOString().slice(0, 10), locationId: b.locationId, lossBandId: b.lossBandId,
    sourceType: "ROASTING_BATCH", sourceId: batch.id, description: `Roast ${batch.batchNumber}`,
    lines: [
      { role: "INPUT", itemId: green.id, quantity: new Prisma.Decimal(batch.greenBeanQuantity).toDecimalPlaces(4).toFixed(4) },
      { role: "OUTPUT", itemId: roasted.id, quantity: new Prisma.Decimal(batch.roastedBeanQuantity).toDecimalPlaces(4).toFixed(4) },
    ],
  }, userId);
}

/** Draft goods receipt from a green-coffee purchase record (operational), at its recorded cost. */
export async function receiptDraftFromPurchase(purchaseId: string, b: { locationId?: unknown; docDate?: unknown }, userId: string) {
  const p = await prisma.purchaseRecord.findUnique({ where: { id: purchaseId } });
  if (!p) throw new AccountingError("Purchase record not found.", 404);
  const item = p.itemId ? await prisma.invItem.findUnique({ where: { greenBeanId: p.itemId } }) : p.materialItemId ? await prisma.invItem.findUnique({ where: { materialItemId: p.materialItemId } }) : null;
  if (!item) throw new AccountingError("Link the purchased item to an inventory item first.", 400);
  return createInvDoc({
    type: "RECEIPT", docDate: b.docDate ?? p.purchaseDate.toISOString().slice(0, 10), locationId: b.locationId, supplierId: p.supplierId,
    sourceType: "PURCHASE_RECORD", sourceId: p.id, description: `Purchase ${p.id.slice(-6)}`,
    lines: [{ itemId: item.id, quantity: new Prisma.Decimal(p.quantity).toDecimalPlaces(4).toFixed(4), unitCost: new Prisma.Decimal(p.costPerUnit).toDecimalPlaces(4).toFixed(4) }],
  }, userId);
}

export const todayOrDate = (v: unknown) => (v ? accountingDate(v) : todayAccountingDate());
