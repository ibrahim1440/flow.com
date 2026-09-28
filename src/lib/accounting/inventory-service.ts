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
import { YIELDING, ISSUE_ROLE } from "./inventory-rules";
import { consume, costProduction, allocateAmount, toBase, m2, InsufficientStock, type Layer } from "./inventory-costing";
import { absorptionFor, ABSORBED_ROLE } from "./conversion-costs";

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
    const cur = await tx.invLossBand.findUnique({ where: { id } });
    if (cur && cur.createdBy === userId) throw new AccountingError("A loss band is approved by someone other than its author.", 403);
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
export async function updateInventorySettings(b: { inventoryCostMethod?: unknown; inventoryPriceDifference?: unknown; salesCostTiming?: unknown }, userId: string) {
  const data: { inventoryCostMethod?: InvCostMethod | null; inventoryPriceDifference?: "CAPITALISE" | "EXPENSE" | null; salesCostTiming?: string | null } = {};
  if ("salesCostTiming" in b) {
    if (b.salesCostTiming !== null && b.salesCostTiming !== "WITH_REVENUE") throw new AccountingError("The sales cost timing is WITH_REVENUE or null (undecided).", 400);
    data.salesCostTiming = b.salesCostTiming as string | null;
  }
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
    if (data.salesCostTiming !== undefined && before.salesCostTiming && data.salesCostTiming !== before.salesCostTiming && await tx.invCosting.count({ where: { status: { in: ["COSTED", "UNCOSTED"] } } })) throw new AccountingError("The sales cost timing cannot change once invoices have been costed.", 409);
    const after = await tx.accountingSettings.update({ where: { id: "singleton" }, data: { ...data, updatedBy: userId } });
    await auditAccounting(tx, { action: "settings.inventory", entityType: "settings", entityId: "singleton", userId,
      before: { inventoryCostMethod: before.inventoryCostMethod, inventoryPriceDifference: before.inventoryPriceDifference, salesCostTiming: before.salesCostTiming },
      after: { inventoryCostMethod: after.inventoryCostMethod, inventoryPriceDifference: after.inventoryPriceDifference, salesCostTiming: after.salesCostTiming } });
    return after;
  });
}

// ─── Documents ──────────────────────────────────────────────────────────────────

export type InvLineInput = { itemId?: unknown; quantity?: unknown; unit?: unknown; unitCost?: unknown; countedQty?: unknown; role?: unknown; targetLineId?: unknown; description?: unknown;
  salesInvoiceLineId?: unknown; orderItemId?: unknown; lotId?: unknown };
export type InvDocInput = {
  type?: unknown; docDate?: unknown; locationId?: unknown; toLocationId?: unknown; supplierId?: unknown; customerId?: unknown;
  description?: unknown; reason?: unknown; issueReason?: unknown; lossBandId?: unknown; amount?: unknown; allocationBasis?: unknown;
  billLineId?: unknown; sourceType?: unknown; sourceId?: unknown; requestKey?: unknown; lines?: unknown;
  salesInvoiceId?: unknown; process?: unknown; labourHours?: unknown; machineHours?: unknown;
};
const PROCESSES = new Set(["ROASTING", "BLENDING", "PACKING", "BAKING", "OTHER"]);

const TYPES = new Set<InvDocType>(["RECEIPT", "SUPPLIER_RETURN", "ISSUE", "TRANSFER", "PRODUCTION", "SALE_ISSUE", "CUSTOMER_RETURN", "LANDED_COST", "BILL_MATCH", "COUNT", "SUPPLIER_CREDIT", "SALE_REVERSAL", "ADJUSTMENT"]);
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
  if (type === "SALE_REVERSAL" && input.sourceType !== "SALES_COSTING") throw new AccountingError("A sale reversal is created by reversing a costed invoice.", 400);
  if ((type === "CUSTOMER_RETURN" || type === "SALE_REVERSAL") && !(input.customerId && await tx.customer.findUnique({ where: { id: String(input.customerId) } }))) throw new AccountingError("Choose the customer.", 400);
  const billLineId = (type === "BILL_MATCH" || type === "LANDED_COST" || type === "SUPPLIER_CREDIT") && input.billLineId ? String(input.billLineId) : null;
  if ((type === "BILL_MATCH" || type === "SUPPLIER_CREDIT") && !billLineId) throw new AccountingError("Choose the supplier bill line.", 400);
  let billNet: Prisma.Decimal | null = null;
  if (billLineId && type === "SUPPLIER_CREDIT") {
    const bl = await tx.supplierBillLine.findUnique({ where: { id: billLineId }, include: { bill: true } });
    if (!bl || bl.bill.kind !== "CREDIT_NOTE" || bl.bill.status !== "POSTED" || !["STOCK_RETURN", "STOCK_PRICE_ADJUSTMENT"].includes(bl.kind)) throw new AccountingError("Choose a stock line of a posted supplier credit note.", 400);
  } else if (billLineId) {
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
  if (type === "SALE_ISSUE" && input.sourceType !== "SALES_COSTING") throw new AccountingError("Cost of sales is created from a posted sales invoice.", 400);
  if (type === "SUPPLIER_CREDIT" && input.sourceType !== "SUPPLIER_CREDIT") throw new AccountingError("A supplier credit document is created from a posted supplier credit note.", 400);
  const process = type === "PRODUCTION" ? (PROCESSES.has(String(input.process ?? "")) ? String(input.process) : null) : null;
  const hours = (v: unknown, what: string) => (v === undefined || v === null || v === "" ? null : qty4(v, what));
  const labourHours = type === "PRODUCTION" ? hours(input.labourHours, "Labour hours") : null;
  const machineHours = type === "PRODUCTION" ? hours(input.machineHours, "Machine hours") : null;
  if ((labourHours && labourHours.lt(0)) || (machineHours && machineHours.lt(0))) throw new AccountingError("Hours cannot be negative.", 400);
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
    // A production consumes inputs and makes outputs; an adjustment takes stock out (INPUT) or adds it (OUTPUT).
    const role = type === "PRODUCTION" || type === "ADJUSTMENT" ? (l.role === "OUTPUT" ? "OUTPUT" : l.role === "INPUT" ? "INPUT" : null) : "LINE";
    if (!role) throw new AccountingError(type === "ADJUSTMENT" ? `Line ${n}: an adjustment line takes stock out or adds it.` : `Line ${n}: a production line is an input or an output.`, 400);
    const quantity = type === "COUNT" || type === "LANDED_COST" || type === "BILL_MATCH" || type === "SUPPLIER_CREDIT" ? (l.quantity === undefined || l.quantity === "" ? dec(0) : qty4(l.quantity, `Line ${n} quantity`)) : qty4(l.quantity, `Line ${n} quantity`);
    if (quantity.lt(0) || (!["COUNT", "LANDED_COST", "BILL_MATCH", "SUPPLIER_CREDIT"].includes(type) && quantity.isZero())) throw new AccountingError(`Line ${n}: the quantity must be positive.`, 400);
    const unitCost = l.unitCost === undefined || l.unitCost === null || l.unitCost === "" ? null : qty4(l.unitCost, `Line ${n} unit cost`);
    if (type === "RECEIPT" && (!unitCost || unitCost.lt(0))) throw new AccountingError(`Line ${n}: a receipt line needs its cost per ${item.baseUnit}.`, 400);
    const countedQty = type === "COUNT" ? qty4(l.countedQty, `Line ${n} counted quantity`) : null;
    if (countedQty && countedQty.lt(0)) throw new AccountingError(`Line ${n}: a count cannot be negative.`, 400);
    const targetLineId = text(l.targetLineId, 40);
    if (["LANDED_COST", "BILL_MATCH"].includes(type) && !targetLineId) throw new AccountingError(`Line ${n}: choose the receipt line.`, 400);
    if ((type === "CUSTOMER_RETURN" || type === "SALE_REVERSAL") && !targetLineId) throw new AccountingError(`Line ${n}: choose the sale it returns from.`, 400);
    const baseQty = toBase(quantity, factor);
    return { lineNo: n, role: role as "LINE" | "INPUT" | "OUTPUT", itemId: item.id, quantity, unit, factor, baseQty: type === "COUNT" ? toBase(countedQty!, factor) : baseQty, unitCost, countedQty: countedQty ? toBase(countedQty, factor) : null, targetLineId, description: text(l.description, 300),
      salesInvoiceLineId: text(l.salesInvoiceLineId, 40), orderItemId: text(l.orderItemId, 40), lotId: text(l.lotId, 40) };
  });
  if (type === "ADJUSTMENT" && !text(input.reason)) throw new AccountingError("A stock adjustment needs its reason.", 400);
  if (type === "PRODUCTION" && (!lines.some((l) => l.role === "INPUT") || !lines.some((l) => l.role === "OUTPUT"))) throw new AccountingError("A production has inputs and outputs.", 400);
  if (type === "BILL_MATCH" && lines.length !== 1) throw new AccountingError("A bill match joins one bill line to one receipt line.", 400);
  return {
    header: {
      type, docDate, locationId, toLocationId, issueReason, amount, allocationBasis, lossBandId, billLineId,
      supplierId: text(input.supplierId, 40), customerId: text(input.customerId, 40), description: text(input.description), reason: text(input.reason),
      sourceType: text(input.sourceType, 40), sourceId: text(input.sourceId, 120), requestKey: text(input.requestKey, 80),
      salesInvoiceId: text(input.salesInvoiceId, 40), process, labourHours, machineHours,
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
async function issue(tx: Tx, d: Doc, lineId: string | null, itemId: string, locationId: string, qty: Prisma.Decimal, method: InvCostMethod, preferLayerId?: string | string[] | null, onlyPreferred = false) {
  let layers = await layersOf(tx, itemId, locationId);
  const takes: { layerId: string; qty: Prisma.Decimal; value: Prisma.Decimal }[] = [];
  let left = qty;
  const prefer = preferLayerId == null ? [] : Array.isArray(preferLayerId) ? preferLayerId : [preferLayerId];
  // Goods that belong to one customer or order (delivered, not invoiced) are drawn only from their
  // own layers; elsewhere named layers are drawn first and the method takes the rest.
  if (onlyPreferred) layers = layers.filter((l) => prefer.includes(l.id));
  for (const id of prefer) {
    const p = layers.find((l) => l.id === id);
    if (!p || left.isZero() || p.qtyLeft.isZero()) continue;
    const t = consume([p], Prisma.Decimal.min(left, p.qtyLeft), "FIFO"); takes.push(...t); left = left.sub(t[0].qty);
    layers = layers.map((l) => (l.id === p.id ? { ...l, qtyLeft: l.qtyLeft.sub(t[0].qty), valueLeft: l.valueLeft.sub(t[0].value) } : l));
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

/**
 * Trace a later cost change (landed cost, supplier price difference, supplier credit) on a layer to
 * where its goods are now. The share of the layer still on hand revalues it; the share already
 * drawn from it follows each draw: into the outputs of a production (and its abnormal loss),
 * through a transfer to the destination layers, to cost of sales for a sale, to the issue's
 * expense account for an issue, to inventory variance for a count shortage, and for goods returned
 * to the supplier to `returnRole`. Recursion follows the goods through several steps. Every
 * item-location it reaches must have no movement after this document's date (the same rule as any
 * posting), so an adjustment never rewrites what an earlier date showed.
 */
async function trace(tx: Tx, d: Doc, lineId: string, layerId: string, amount: Prisma.Decimal, returnRole: string, depth = 0): Promise<void> {
  if (amount.isZero()) return;
  const layer = await tx.invLayer.findUniqueOrThrow({ where: { id: layerId } });
  const last = await tx.invMove.findFirst({ where: { itemId: layer.itemId, locationId: layer.locationId, documentId: { not: d.id } }, orderBy: { date: "desc" }, select: { date: true, document: { select: { docNo: true } } } });
  if (last && last.date > d.docDate) {
    const item = await tx.invItem.findUnique({ where: { id: layer.itemId } });
    throw new AccountingError(`${item?.code ?? "An item"} the adjustment reaches already has a posted movement on ${last.date.toISOString().slice(0, 10)} (document ${last.document.docNo}); date the adjustment on or after that day.`, 409);
  }
  const expensed = (role: string, v: Prisma.Decimal, traceDocumentId: string | null) => v.isZero() ? null
    : tx.invMove.create({ data: { documentId: d.id, lineId, itemId: layer.itemId, locationId: layer.locationId, date: d.docDate, kind: "EXPENSED", qty: ZERO, value: v, role, traceDocumentId } });
  const qIn = dec(layer.qtyIn), qLeft = dec(layer.qtyLeft);
  let keep = qIn.isZero() ? ZERO : m2(amount.mul(qLeft).div(qIn));
  if (keep.isNegative() && keep.abs().gt(dec(layer.valueLeft))) keep = dec(layer.valueLeft).neg();   // a layer never goes below zero
  if (!keep.isZero()) {
    await tx.invMove.create({ data: { documentId: d.id, lineId, itemId: layer.itemId, locationId: layer.locationId, date: d.docDate, kind: "REVALUE", qty: ZERO, value: keep, layerId } });
    await tx.invLayer.update({ where: { id: layerId }, data: { valueLeft: { increment: keep } } });
  }
  const rest = amount.sub(keep);
  if (rest.isZero()) return;
  const draws = await tx.invMove.findMany({ where: { layerId, kind: "OUT", documentId: { not: d.id } }, include: { document: true }, orderBy: { seq: "asc" } });
  if (!draws.length || depth > 12) { await expensed("INVENTORY_VARIANCE", rest, null); return; }
  for (const part of allocateAmount(rest, draws.map((o) => ({ key: o.id, weight: dec(o.qty).neg() })))) {
    const o = draws.find((x) => x.id === part.key)!;
    const src = o.document;
    if (src.type === "PRODUCTION") {
      const ms = await tx.invMove.findMany({ where: { documentId: src.id } });
      const inputs = ms.filter((m) => m.kind === "OUT" || m.kind === "ABSORBED").reduce((t, m) => t.add(dec(m.value).neg()), ZERO);
      const ins = ms.filter((m) => m.kind === "IN");
      const outputs = ins.reduce((t, m) => t.add(dec(m.value)), ZERO);
      const abnormal = inputs.sub(outputs);
      const toLoss = inputs.isZero() ? ZERO : m2(part.amount.mul(abnormal).div(inputs));
      await expensed("ABNORMAL_LOSS", toLoss, src.id);
      const toOut = part.amount.sub(toLoss);
      if (!toOut.isZero()) {
        if (!ins.length) { await expensed("INVENTORY_VARIANCE", toOut, src.id); continue; }
        for (const a of allocateAmount(toOut, ins.map((m) => ({ key: m.id, weight: dec(m.value).isZero() ? dec(m.qty) : dec(m.value) })))) {
          const out = await tx.invLayer.findUniqueOrThrow({ where: { moveId: a.key } });
          await trace(tx, d, lineId, out.id, a.amount, returnRole, depth + 1);
        }
      }
    } else if (src.type === "TRANSFER") {
      // The transfer received each draw as one layer at the destination, in the same order.
      const outsOfLine = await tx.invMove.findMany({ where: { documentId: src.id, lineId: o.lineId, kind: "OUT" }, orderBy: { seq: "asc" } });
      const insOfLine = await tx.invMove.findMany({ where: { documentId: src.id, lineId: o.lineId, kind: "IN" }, orderBy: { seq: "asc" } });
      const k = outsOfLine.findIndex((x) => x.id === o.id);
      const dest = insOfLine[k];
      if (!dest) { await expensed("INVENTORY_VARIANCE", part.amount, src.id); continue; }
      const destLayer = await tx.invLayer.findUniqueOrThrow({ where: { moveId: dest.id } });
      await trace(tx, d, lineId, destLayer.id, part.amount, returnRole, depth + 1);
    } else if (src.type === "SALE_ISSUE") await expensed("COGS", part.amount, src.id);
    else if (src.type === "ISSUE") await expensed(ISSUE_ROLE[src.issueReason!], part.amount, src.id);
    else if (src.type === "SUPPLIER_RETURN") await expensed(returnRole, part.amount, src.id);
    else await expensed("INVENTORY_VARIANCE", part.amount, src.id);   // counts and anything else
  }
}

/** The receipt layer a receipt line created. */
async function receiptLayer(tx: Tx, receiptLineId: string) {
  const mv = await tx.invMove.findFirst({ where: { lineId: receiptLineId, kind: "IN", document: { type: "RECEIPT", status: "POSTED" } } });
  if (!mv) throw new AccountingError("The receipt line is not posted.", 409);
  return { move: mv, layer: await tx.invLayer.findUniqueOrThrow({ where: { moveId: mv.id } }) };
}

/**
 * Layers at a location that belong to a document line's customer or order: goods dispatched for
 * the same order line, or cost moved back from a replaced invoice's sale. At the "delivered, not
 * invoiced" location a line may draw only from these.
 */
async function ownLayers(tx: Tx, line: { orderItemId: string | null; salesInvoiceLineId: string | null; itemId: string }, locationId: string, replacedInvoiceId: string | null) {
  const or: Prisma.InvDocLineWhereInput[] = [];
  if (line.orderItemId) or.push({ orderItemId: line.orderItemId });
  if (replacedInvoiceId) or.push({ document: { salesInvoiceId: replacedInvoiceId } });
  if (line.salesInvoiceLineId) or.push({ salesInvoiceLineId: line.salesInvoiceLineId, document: { type: "SALE_REVERSAL" } });
  if (!or.length) return [];
  const docLines = await tx.invDocLine.findMany({ where: { itemId: line.itemId, document: { status: "POSTED" }, OR: or }, select: { id: true } });
  const ins = await tx.invMove.findMany({ where: { lineId: { in: docLines.map((l) => l.id) }, kind: "IN", locationId, itemId: line.itemId }, select: { id: true } });
  const layers = await tx.invLayer.findMany({ where: { moveId: { in: ins.map((m) => m.id) }, qtyLeft: { gt: 0 } }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] });
  return layers.map((l) => l.id);
}

/** Item-locations a cost change on a layer can reach by following its goods (see trace). */
async function reachable(tx: Tx, layerId: string, seen = new Set<string>(), depth = 0): Promise<Set<string>> {
  if (depth > 12 || seen.has(layerId)) return new Set();
  seen.add(layerId);
  const out = new Set<string>();
  const layer = await tx.invLayer.findUnique({ where: { id: layerId } });
  if (!layer) return out;
  out.add(`${layer.itemId}|${layer.locationId}`);
  const draws = await tx.invMove.findMany({ where: { layerId, kind: "OUT" }, select: { documentId: true, lineId: true, document: { select: { type: true } } } });
  for (const o of draws) {
    if (o.document.type !== "PRODUCTION" && o.document.type !== "TRANSFER") continue;
    const ins = await tx.invMove.findMany({ where: { documentId: o.documentId, kind: "IN", ...(o.document.type === "TRANSFER" ? { lineId: o.lineId } : {}) }, select: { id: true } });
    for (const m of ins) {
      const l = await tx.invLayer.findUnique({ where: { moveId: m.id }, select: { id: true } });
      if (l) for (const p of await reachable(tx, l.id, seen, depth + 1)) out.add(p);
    }
  }
  return out;
}

/** First day on or after `date` that lies in an open period (null: none open). */
async function firstOpenDay(tx: Tx, date: Date) {
  const p = await tx.fiscalPeriod.findFirst({ where: { endDate: { gte: date }, status: "OPEN" }, orderBy: { startDate: "asc" } });
  return p ? (p.startDate > date ? p.startDate : date) : null;
}

export type InvPostOutcome = { document: Awaited<ReturnType<typeof getInvDoc>>; ledger: ProcessOutcome | null };

/**
 * `late`: a system document (cost of sales, operational event) that cannot be dated when it
 * happened, because later movements already posted for its item-locations or its period is
 * closed, is booked on the first day it can be (and in an open period); originalDate keeps when
 * it happened. Documents people enter are never re-dated: they are refused instead.
 */
export async function postInvDoc(id: string, userId: string, opts: { late?: boolean } = {}): Promise<InvPostOutcome> {
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
    const late = opts.late && !!cur.sourceType;
    const lateWhy: string[] = [];
    let bookOn = cur.docDate;
    if (!period || period.status !== "OPEN") {
      if (!late) throw new AccountingError(`The period of ${cur.docDate.toISOString().slice(0, 10)} is not open.`, 409);
      const open = await firstOpenDay(tx, cur.docDate);
      if (!open) throw new AccountingError(`The period of ${cur.docDate.toISOString().slice(0, 10)} is not open, and no later period is open.`, 409);
      bookOn = open; lateWhy.push(`the period of ${cur.docDate.toISOString().slice(0, 10)} is not open`);
    }

    // Every item-location the document touches, locked in a fixed order.
    const targets = cur.type === "LANDED_COST" || cur.type === "BILL_MATCH" || (cur.type === "SUPPLIER_CREDIT" && cur.lines.some((l) => l.targetLineId))
      ? await Promise.all(cur.lines.filter((l) => l.targetLineId).map(async (l) => (await receiptLayer(tx, l.targetLineId!)).layer))
      : [];
    const pairs = new Set<string>();
    for (const l of cur.lines) { pairs.add(`${l.itemId}|${cur.locationId}`); if (cur.toLocationId) pairs.add(`${l.itemId}|${cur.toLocationId}`); }
    for (const t of targets) for (const p of await reachable(tx, t.id)) pairs.add(p);
    // Adjustments that follow goods downstream take the trace lock exclusively; every other posting
    // takes it shared, so no posting moves stock while an adjustment is tracing through it.
    if (["LANDED_COST", "BILL_MATCH", "SUPPLIER_CREDIT"].includes(cur.type)) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('inv:trace'))`;
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('inv:trace'))`;
    for (const p of [...pairs].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"inv:" + p}))`;
    for (const p of pairs) {
      const [itemId, locationId] = p.split("|");
      const last = await tx.invMove.findFirst({ where: { itemId, locationId }, orderBy: { date: "desc" }, select: { date: true, document: { select: { docNo: true } } } });
      if (last && last.date > bookOn && late) {
        bookOn = last.date; lateWhy.push(`document ${last.document.docNo} already moved this stock on ${last.date.toISOString().slice(0, 10)}`);
        continue;
      }
      if (last && last.date > cur.docDate) {
        const item = cur.lines.find((l) => l.itemId === itemId)?.item;
        throw new AccountingError(`${item?.code ?? "An item"} already has a posted movement on ${last.date.toISOString().slice(0, 10)} (document ${last.document.docNo}); a document dated ${cur.docDate.toISOString().slice(0, 10)} would change costs already issued. Date it on or after that day.`, 409);
      }
    }

    if (bookOn > cur.docDate) {
      const open = await firstOpenDay(tx, bookOn);
      if (!open) throw new AccountingError(`No open period on or after ${bookOn.toISOString().slice(0, 10)} to book this late document in.`, 409);
      bookOn = open;
    }
    const isLate = bookOn.getTime() !== cur.docDate.getTime();
    const posted = await tx.invDocument.updateMany({ where: { id, status: "APPROVED" }, data: {
      status: "POSTED", postedBy: userId, postedAt: new Date(), costMethod: method, priceDifference: cur.type === "BILL_MATCH" ? priceDifference : null,
      lossBandPercent: bandPercent, provisional: pending.length > 0,
      ...(isLate ? { docDate: bookOn, originalDate: cur.docDate, lateReason: `Booked late: ${lateWhy.join("; ")}.` } : {}),
    } });
    if (posted.count !== 1) throw new AccountingError("The document has already posted.", 409);
    // An operational event held for an accountant is complete once its document posts.
    if (cur.sourceType === "OPS" && cur.sourceId) await tx.invOpsEvent.updateMany({ where: { id: cur.sourceId, status: { in: ["HELD", "FAILED", "BLOCKED"] } }, data: { status: "POSTED", documentId: id, lastError: null, leaseUntil: null } });
    const d = { ...cur, docDate: bookOn } as Doc;

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
      case "ISSUE":
        for (const l of d.lines) await issue(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), method);
        break;
      case "SALE_ISSUE": {
        const loc = await tx.invLocation.findUniqueOrThrow({ where: { id: d.locationId } });
        const replaced = d.salesInvoiceId ? (await tx.salesInvoice.findUnique({ where: { id: d.salesInvoiceId }, select: { replacesInvoiceId: true } }))?.replacesInvoiceId ?? null : null;
        for (const l of d.lines) {
          const own = await ownLayers(tx, l, d.locationId, replaced);
          await issue(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), method, own, loc.isDelivered);
        }
        break;
      }
      case "TRANSFER":
        for (const l of d.lines) {
          const from = await tx.invLocation.findUniqueOrThrow({ where: { id: d.locationId } });
          const own = from.isDelivered ? await ownLayers(tx, l, d.locationId, null) : [];
          const out = await issue(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), method, own, from.isDelivered);
          for (const t of out.takes) await receive(tx, d, l.id, l.itemId, d.toLocationId!, t.qty, t.value);   // same cost, at the destination
        }
        break;
      case "CUSTOMER_RETURN": case "SALE_REVERSAL":
        for (const l of d.lines) {
          const sold = await tx.invMove.findMany({ where: { lineId: l.targetLineId!, kind: "OUT", document: { type: "SALE_ISSUE", status: "POSTED" } } });
          if (!sold.length) throw new AccountingError(`Line ${l.lineNo}: the sale it returns from is not posted.`, 409);
          const soldQty = sold.reduce((s, m) => s.add(dec(m.qty).neg()), ZERO), soldValue = sold.reduce((s, m) => s.add(dec(m.value).neg()), ZERO);
          const prior = await tx.invDocLine.findMany({ where: { targetLineId: l.targetLineId!, document: { type: { in: ["CUSTOMER_RETURN", "SALE_REVERSAL"] }, status: "POSTED" }, NOT: { documentId: d.id } }, select: { id: true } });
          const earlier = await tx.invMove.findMany({ where: { kind: "IN", lineId: { in: prior.map((x) => x.id) } } });
          const already = earlier.reduce((s, m) => s.add(dec(m.qty)), ZERO), alreadyValue = earlier.reduce((s, m) => s.add(dec(m.value)), ZERO);
          if (dec(l.baseQty).add(already).gt(soldQty)) throw new AccountingError(`Line ${l.lineNo}: returns would exceed the ${soldQty.toFixed(4)} sold.`, 409);
          // Back at the cost it left at; the last of it takes exactly what remains of the sold value.
          const value = dec(l.baseQty).add(already).equals(soldQty) ? soldValue.sub(alreadyValue) : m2(soldValue.mul(dec(l.baseQty)).div(soldQty));
          await receive(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), value);
        }
        break;
      case "ADJUSTMENT":
        // Stock corrected by a known quantity (an operational adjustment): out at the current cost,
        // in at the line's cost when given (a cancelled roast restocks green at what it left at),
        // otherwise at the average cost on hand; the difference is inventory variance.
        for (const l of d.lines) {
          if (l.role === "INPUT") { await issue(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), method); continue; }
          const have = await onHand(tx, l.itemId, d.locationId);
          const unit = l.unitCost ? dec(l.unitCost) : have.qty.gt(0) && have.value.gt(0) ? have.value.div(have.qty) : null;
          if (!unit) throw new AccountingError(`Line ${l.lineNo}: ${l.item.code} has no stock to value the addition at; enter a cost per ${l.item.baseUnit}.`, 400);
          await receive(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), m2(dec(l.baseQty).mul(unit)));
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
        // Conversion cost from the process's approved cost pools (conversion-costs.ts).
        const conv = await absorptionFor(tx, d, { yieldIn, yieldOut, unitsOut: d.lines.filter((x) => x.role === "OUTPUT").reduce((s, l) => s.add(dec(l.baseQty)), ZERO) });
        const convInputs = conv.map((c) => ({ key: `pool:${c.pool.id}`, value: c.amount, yieldQty: ZERO, conversion: true }));
        if (yieldIn.gt(yieldOut) && bandPercent === null && !provisionalOk) throw new AccountingError("This production loses weight: choose the approved loss band of its process (decision D-1).", 409);
        let r;
        try { r = costProduction([...ins, ...convInputs], outs, bandPercent); } catch (e) { throw new AccountingError((e as Error).message, 400); }
        for (const o of r.outputs) {
          const l = d.lines.find((x) => x.id === o.key)!;
          await receive(tx, d, l.id, l.itemId, d.locationId, dec(l.baseQty), o.value);
        }
        const firstOut = d.lines.find((x) => x.role === "OUTPUT")!;
        for (const c of conv) await tx.invMove.create({ data: { documentId: d.id, lineId: null, itemId: firstOut.itemId, locationId: d.locationId, date: d.docDate, kind: "ABSORBED", qty: ZERO, value: c.amount.neg(), role: ABSORBED_ROLE[c.pool.kind], poolId: c.pool.id } });
        break;
      }
      case "LANDED_COST": {
        const w = await Promise.all(d.lines.map(async (l) => { const { move: mv } = await receiptLayer(tx, l.targetLineId!); return { key: l.id, weight: d.allocationBasis === "QUANTITY" ? dec(mv.qty) : dec(mv.value) }; }));
        for (const a of allocateAmount(dec(d.amount), w)) { const l = d.lines.find((x) => x.id === a.key)!; await trace(tx, d, l.id, (await receiptLayer(tx, l.targetLineId!)).layer.id, a.amount, "INVENTORY_VARIANCE"); }
        break;
      }
      case "SUPPLIER_CREDIT": {
        const l = d.lines[0];
        const bl = await tx.supplierBillLine.findUniqueOrThrow({ where: { id: d.billLineId! } });
        if (bl.kind === "STOCK_PRICE_ADJUSTMENT") {
          const { layer } = await receiptLayer(tx, l.targetLineId!);
          await trace(tx, d, l.id, layer.id, dec(bl.net).neg(), "INVENTORY_VARIANCE");
        } else {
          // The return debited GRNI at the cost the goods left at; the credit note credited GRNI
          // with what the supplier credits. The difference clears to variance.
          const ret = await tx.invMove.findMany({ where: { documentId: bl.invDocumentId!, kind: "OUT" } });
          const residual = ret.reduce((t, m) => t.sub(dec(m.value)), ZERO).sub(dec(bl.net));
          if (!residual.isZero()) await tx.invMove.create({ data: { documentId: d.id, lineId: l.id, itemId: l.itemId, locationId: d.locationId, date: d.docDate, kind: "EXPENSED", qty: ZERO, value: residual, role: "INVENTORY_VARIANCE", traceDocumentId: bl.invDocumentId } });
        }
        break;
      }
      case "BILL_MATCH": {
        const l = d.lines[0];
        const bl = await tx.supplierBillLine.findUniqueOrThrow({ where: { id: d.billLineId! } });
        const { move: mv, layer } = await receiptLayer(tx, l.targetLineId!);
        const diff = dec(bl.net).sub(dec(mv.value));
        if (!diff.isZero()) {
          if (priceDifference === "CAPITALISE") await trace(tx, d, l.id, layer.id, diff, "GRNI");
          else await tx.invMove.create({ data: { documentId: d.id, lineId: l.id, itemId: layer.itemId, locationId: layer.locationId, date: d.docDate, kind: "EXPENSED", qty: ZERO, value: diff, role: "INVENTORY_VARIANCE" } });
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

// Cost of sales for invoices: sales-costing.ts (durable, retried, never silently incomplete).
// Physical customer returns: customer-returns.ts (warehouse evidence, four-eyes).

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
    sourceType: "ROASTING_BATCH", sourceId: batch.id, description: `Roasting batch ${batch.batchNumber} · ${batch.greenBeanQuantity} kg → ${batch.roastedBeanQuantity} kg`,
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
    sourceType: "PURCHASE_RECORD", sourceId: p.id, description: `Purchase record ${p.purchaseDate.toISOString().slice(0, 10)} · ${p.quantity} × ${p.costPerUnit}`,
    lines: [{ itemId: item.id, quantity: new Prisma.Decimal(p.quantity).toDecimalPlaces(4).toFixed(4), unitCost: new Prisma.Decimal(p.costPerUnit).toDecimalPlaces(4).toFixed(4) }],
  }, userId);
}

export const todayOrDate = (v: unknown) => (v ? accountingDate(v) : todayAccountingDate());
