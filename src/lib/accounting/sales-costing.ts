// Cost of sales for posted sales invoices, durable and never silently incomplete (stage 4b).
//
// The database creates an InvCosting record in the same transaction that posts an invoice (and
// re-opens it when the invoice is reversed), so a crash between posting and costing leaves work
// that the processor finds. The processor is state-based and idempotent: for each goods line it
// works out what the invoice's status requires (cost issued while the invoice is posted, cost
// moved back to "delivered, not invoiced" once it is reversed) and creates at most one document
// per line and action (unique source key), so a retry, a second worker or a crash mid-way never
// issues stock twice. Records are claimed with a short lease; a worker that dies leaves a lease
// that expires. Failures back off and stay visible in the exception queue with their reason.
//
// Line treatment is explicit: GOODS lines (an inventory item named directly, or through the
// product SKU) must be costed; NON_STOCK lines (services, fees) are declared as such; a line that
// is neither is an exception, never skipped. Timing follows the approved setting
// `salesCostTiming` (DECISION_PACK §4); undecided → AWAITING_POLICY (provisional in an isolated
// test database only). A goods line of an order is costed from the goods dispatched for that
// order line (held at cost in "delivered, not invoiced"); a line with no order is issued from the
// invoice's fulfilment location. An invoice reversal moves the cost back to "delivered, not
// invoiced": it does not bring goods back to stock (customer-returns.ts does, with evidence).
import { Prisma, type InvCostingStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ledgerTx } from "./journal-service";
import { auditAccounting } from "./audit";
import { ZERO, dec } from "./money";
import { accountingDateOf } from "./dates";
import { provisionalPostingAllowed } from "./policy";
import { toBase } from "./inventory-costing";
import { INV_SYSTEM, postInvDoc, createInvDoc, type InvDocInput } from "./inventory-service";

type Tx = Prisma.TransactionClient;
const LEASE_MS = 2 * 60_000;

export type LineState = { lineId: string; lineNo: number; treatment: "GOODS" | "NON_STOCK" | "UNCLASSIFIED"; status: string; reason?: string; itemId?: string; qty?: string; cost?: string };

/** The "delivered, not invoiced" location (created on first use). */
export async function deliveredLocation(db: Tx | typeof prisma = prisma) {
  const found = await db.invLocation.findFirst({ where: { isDelivered: true } });
  if (found) return found;
  try {
    return await db.invLocation.create({ data: { code: "DLV", name: "Delivered to customers, not invoiced", nameAr: "مسلّمة للعملاء ولم تُفوتر", isDelivered: true, accountRole: "GOODS_DELIVERED_NOT_INVOICED" } });
  } catch { return db.invLocation.findFirstOrThrow({ where: { isDelivered: true } }); }
}

/** How each line of an invoice is treated, and the item and base quantity of goods lines. */
export async function classifyLines(db: Tx | typeof prisma, invoiceId: string) {
  const inv = await db.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  const skuIds = inv.lines.map((l) => l.productSkuId).filter(Boolean) as string[];
  const bySku = new Map((await db.invItem.findMany({ where: { productSkuId: { in: skuIds } }, include: { units: true } })).map((i) => [i.productSkuId!, i]));
  const direct = new Map((await db.invItem.findMany({ where: { id: { in: inv.lines.map((l) => l.invItemId).filter(Boolean) as string[] } }, include: { units: true } })).map((i) => [i.id, i]));
  const lines = inv.lines.map((l) => {
    const treatment = l.stockTreatment ?? (l.productSkuId || l.invItemId ? "GOODS" : "UNCLASSIFIED");
    if (treatment === "NON_STOCK") return { line: l, state: { lineId: l.id, lineNo: l.lineNo, treatment, status: "NOT_REQUIRED" } as LineState };
    if (treatment === "UNCLASSIFIED") return { line: l, state: { lineId: l.id, lineNo: l.lineNo, treatment, status: "BLOCKED", reason: `Line ${l.lineNo} is neither marked as goods nor as non-stock; classify it (a goods line needs its product).` } as LineState };
    const item = l.invItemId ? direct.get(l.invItemId) : l.productSkuId ? bySku.get(l.productSkuId) : undefined;
    if (!item) return { line: l, state: { lineId: l.id, lineNo: l.lineNo, treatment, status: "BLOCKED", reason: `Line ${l.lineNo}: ${l.productSkuId ? `product ${l.productSkuId}` : "the line"} has no inventory item; link the product to an inventory item.` } as LineState };
    const unit = l.unit ?? item.baseUnit;
    const factor = unit === item.baseUnit ? dec(1) : item.units.find((u) => u.unit === unit)?.factor;
    if (!factor) return { line: l, state: { lineId: l.id, lineNo: l.lineNo, treatment, status: "BLOCKED", reason: `Line ${l.lineNo}: ${item.code} has no conversion for "${unit}".` } as LineState };
    return { line: l, item, baseQty: toBase(dec(l.quantity), dec(factor)), state: { lineId: l.id, lineNo: l.lineNo, treatment, status: "PENDING", itemId: item.id, qty: toBase(dec(l.quantity), dec(factor)).toFixed(4) } as LineState };
  });
  return { inv, lines };
}

/**
 * What the costing processor has done for one invoice line: quantity and cost issued less moved
 * back on reversal (its own documents only), and, separately, what came back physically through a
 * confirmed customer return (customer-returns.ts), which the processor never re-issues.
 */
export async function costedSoFar(db: Tx | typeof prisma, lineId: string) {
  const net = async (sourceType: string) => {
    const docLines = await db.invDocLine.findMany({ where: { salesInvoiceLineId: lineId, document: { status: "POSTED", sourceType } }, select: { id: true } });
    const moves = await db.invMove.findMany({ where: { lineId: { in: docLines.map((l) => l.id) }, kind: sourceType === "CUSTOMER_RETURN" ? "IN" : { in: ["OUT", "IN"] } } });
    return { qty: moves.reduce((s, m) => s.sub(dec(m.qty)), ZERO), cost: moves.reduce((s, m) => s.sub(dec(m.value)), ZERO) };
  };
  const own = await net("SALES_COSTING"), back = await net("CUSTOMER_RETURN");
  return { qty: own.qty, cost: own.cost, returnedQty: back.qty.neg(), returnedCost: back.cost.neg() };
}

export async function systemDoc(input: InvDocInput, approvedBy: string) {
  // One document per source key: a retry or a racing worker finds the first.
  const key = { sourceType: String(input.sourceType), sourceId: String(input.sourceId) };
  let doc = await prisma.invDocument.findUnique({ where: { sourceType_sourceId: key } });
  if (!doc) {
    try { doc = await createInvDoc(input, INV_SYSTEM); }
    catch (e) { doc = await prisma.invDocument.findUnique({ where: { sourceType_sourceId: key } }); if (!doc) throw e; }
  }
  if (doc.status === "DRAFT") {
    await ledgerTx(async (tx) => {
      await tx.invDocument.updateMany({ where: { id: doc!.id, status: "DRAFT" }, data: { status: "SUBMITTED", submittedBy: INV_SYSTEM, submittedAt: new Date() } });
      await tx.invDocument.updateMany({ where: { id: doc!.id, status: "SUBMITTED" }, data: { status: "APPROVED", approvedBy, approvedAt: new Date() } });
    });
    doc = await prisma.invDocument.findUniqueOrThrow({ where: { id: doc.id } });
  }
  if (doc.status === "APPROVED") await postInvDoc(doc.id, INV_SYSTEM, { late: true });
  return prisma.invDocument.findUniqueOrThrow({ where: { id: doc.id } });
}

type Outcome = { status: InvCostingStatus; reason?: string; lines: LineState[] };

/** Bring one invoice's cost of sales to the state its status requires. Idempotent. */
export async function costInvoice(invoiceId: string): Promise<Outcome> {
  const { inv, lines } = await classifyLines(prisma, invoiceId);
  if (inv.kind !== "INVOICE") return { status: "NOT_REQUIRED", lines: [] };
  const states = lines.map((l) => l.state);
  const goods = lines.filter((l) => l.state.treatment === "GOODS" && l.item);
  const approver = inv.approvedBy ?? inv.postedBy ?? "system:invoice";
  const settings = await prisma.accountingSettings.findUnique({ where: { id: "singleton" } });
  const provisional = await ledgerTx((tx) => provisionalPostingAllowed(tx));

  if (inv.status === "POSTED") {
    if (!states.some((s) => s.treatment !== "NON_STOCK")) return { status: "NOT_REQUIRED", lines: states };
    if (!settings?.salesCostTiming && !provisional) {
      for (const s of states) if (s.status === "PENDING") { s.status = "AWAITING_POLICY"; s.reason = "The sales cost timing (DECISION_PACK §4) is not decided."; }
      return { status: "AWAITING_POLICY", reason: "Waiting for the sales cost timing decision (DECISION_PACK §4).", lines: states };
    }
    const dlv = await deliveredLocation();
    const fulfil = inv.fulfilmentLocationId ?? (await prisma.invLocation.findFirst({ where: { isSalesDefault: true, isActive: true } }))?.id ?? null;
    for (const g of goods) {
      const s = g.state;
      const done = await costedSoFar(prisma, g.line.id);
      const need = g.baseQty!.sub(done.qty);
      if (need.lte(0)) { s.status = "COSTED"; s.cost = done.cost.toFixed(2); continue; }
      // Goods of an order line (or of the invoice this one replaces) come from what was delivered.
      const orderDelivered = g.line.orderItemId ? await prisma.invDocLine.count({ where: { orderItemId: g.line.orderItemId, document: { status: "POSTED", toLocationId: dlv.id } } }) : 0;
      const fromReplaced = inv.replacesInvoiceId ? await prisma.invDocument.count({ where: { salesInvoiceId: inv.replacesInvoiceId, status: "POSTED", locationId: dlv.id, type: "SALE_REVERSAL" } }) : 0;
      const fromDelivered = orderDelivered > 0 || fromReplaced > 0;
      const locationId = fromDelivered ? dlv.id : fulfil;
      if (!locationId) { s.status = "BLOCKED"; s.reason = "No sales location is set."; continue; }
      if (g.line.orderItemId && !fromDelivered) {
        s.status = "AWAITING_DISPATCH"; s.reason = `Line ${g.line.lineNo}: no dispatch is recorded for its order line yet (revenue recognised before delivery).`; continue;
      }
      try {
        const doc = await systemDoc({
          type: "SALE_ISSUE", docDate: inv.issueDate.toISOString().slice(0, 10), locationId, customerId: inv.customerId, salesInvoiceId: inv.id,
          sourceType: "SALES_COSTING", sourceId: `${inv.id}:${g.line.id}:issue`, description: `Cost of sales · INV-${inv.invoiceNo} #${g.line.lineNo}`,
          lines: [{ itemId: g.item!.id, quantity: need.toFixed(4), unit: g.item!.baseUnit, salesInvoiceLineId: g.line.id, orderItemId: g.line.orderItemId }],
        }, approver);
        if (doc.status !== "POSTED") throw new AccountingError("The cost of sales document did not post.", 409);
        const after = await costedSoFar(prisma, g.line.id);
        s.status = after.qty.gte(g.baseQty!) ? "COSTED" : "PARTIAL"; s.cost = after.cost.toFixed(2);
      } catch (e) {
        s.status = e instanceof AccountingError ? "BLOCKED" : "FAILED"; s.reason = (e as Error).message;
      }
    }
    return summarise(states);
  }

  if (inv.status === "REVERSED") {
    // Revenue is gone; goods already issued stay out (no physical return is implied): their cost
    // moves back to "delivered, not invoiced" until reissued, returned or written off.
    const dlv = await deliveredLocation();
    let moved = false;
    for (const g of goods) {
      const s = g.state;
      const done = await costedSoFar(prisma, g.line.id);
      const stillOut = done.qty.sub(done.returnedQty);
      if (stillOut.lte(0)) { s.status = done.qty.gt(0) ? "UNCOSTED" : "CANCELLED"; continue; }
      const issueLines = await prisma.invDocLine.findMany({ where: { salesInvoiceLineId: g.line.id, document: { status: "POSTED", type: "SALE_ISSUE" } } });
      try {
        let left = stillOut, k = 0;
        for (const il of issueLines) {
          if (left.lte(0)) break;
          const q = Prisma.Decimal.min(left, dec(il.baseQty));
          await systemDoc({
            type: "SALE_REVERSAL", docDate: accountingDateOf(inv.reversedAt ?? new Date()).toISOString().slice(0, 10), locationId: dlv.id, customerId: inv.customerId, salesInvoiceId: inv.id,
            sourceType: "SALES_COSTING", sourceId: `${inv.id}:${g.line.id}:uncost:${k++}`, description: `Reversal of invoice INV-${inv.invoiceNo} #${g.line.lineNo}: cost back to delivered, not invoiced`,
            lines: [{ itemId: g.item!.id, quantity: q.toFixed(4), unit: g.item!.baseUnit, targetLineId: il.id, salesInvoiceLineId: g.line.id, orderItemId: g.line.orderItemId }],
          }, approver);
          left = left.sub(q);
        }
        s.status = "UNCOSTED"; moved = true;
      } catch (e) { s.status = e instanceof AccountingError ? "BLOCKED" : "FAILED"; s.reason = (e as Error).message; }
    }
    const bad = states.find((x) => x.status === "BLOCKED" || x.status === "FAILED");
    if (bad) return { status: bad.status as InvCostingStatus, reason: bad.reason, lines: states };
    return { status: moved ? "UNCOSTED" : "CANCELLED", lines: states };
  }
  return { status: "PENDING", lines: states };
}

function summarise(states: LineState[]): Outcome {
  const order: InvCostingStatus[] = ["FAILED", "BLOCKED", "AWAITING_POLICY", "AWAITING_DISPATCH", "PENDING"];
  for (const st of order) {
    const hit = states.find((s) => s.status === st || (st === "PENDING" && s.status === "PARTIAL"));
    if (hit) return { status: st, reason: hit.reason, lines: states };
  }
  return { status: states.some((s) => s.treatment === "GOODS") ? "COSTED" : "NOT_REQUIRED", lines: states };
}

/** Claim, run and record one invoice's costing (lease + back-off). */
export async function processCosting(invoiceId: string, opts: { force?: boolean } = {}) {
  const now = new Date();
  await prisma.invCosting.upsert({ where: { invoiceId }, update: {}, create: { invoiceId } });
  const claim = await prisma.invCosting.updateMany({
    where: { invoiceId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }], ...(opts.force ? {} : { status: { notIn: ["COSTED", "NOT_REQUIRED", "CANCELLED"] } }) },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
  });
  if (claim.count !== 1) return prisma.invCosting.findUniqueOrThrow({ where: { invoiceId } });
  let out: Outcome;
  try { out = await costInvoice(invoiceId); }
  catch (e) { out = { status: "FAILED", reason: (e as Error).message, lines: [] }; }
  const rec = await prisma.invCosting.findUniqueOrThrow({ where: { invoiceId } });
  const retry = ["FAILED", "BLOCKED", "PENDING", "AWAITING_DISPATCH", "AWAITING_POLICY"].includes(out.status);
  const backoffMin = Math.min(2 ** Math.min(rec.attempts, 6), 60);
  const cost = out.lines.reduce((s, l) => s.add(l.cost ? dec(l.cost) : ZERO), ZERO);
  const late = await prisma.invDocument.count({ where: { salesInvoiceId: invoiceId, originalDate: { not: null } } });
  const updated = await prisma.invCosting.update({ where: { invoiceId }, data: {
    status: out.status, lastError: out.reason ?? null, leaseUntil: null, detail: out.lines as unknown as Prisma.InputJsonValue, cost, late: late > 0,
    nextAttemptAt: retry ? new Date(Date.now() + backoffMin * 60_000) : new Date(8.64e15), costedAt: out.status === "COSTED" ? new Date() : rec.costedAt,
  } });
  if (rec.status !== out.status) await ledgerTx((tx) => auditAccounting(tx, { action: "inventory.costing.status", entityType: "sales_document", entityId: invoiceId, userId: INV_SYSTEM, before: { status: rec.status }, after: { status: out.status, reason: out.reason ?? null } }));
  return updated;
}

/** Due costing records (new, retried after back-off, or with an expired lease). */
export async function processPendingCosting(limit = 50) {
  const due = await prisma.invCosting.findMany({
    where: { status: { in: ["PENDING", "FAILED", "BLOCKED", "AWAITING_DISPATCH", "AWAITING_POLICY"] }, nextAttemptAt: { lte: new Date() }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
    orderBy: { nextAttemptAt: "asc" }, take: limit, select: { invoiceId: true },
  });
  const out = [];
  for (const d of due) out.push(await processCosting(d.invoiceId));
  return { processed: out.length, statuses: out.map((o) => o.status) };
}

/** Retry now (from the exception queue), whatever the back-off says. */
export async function retryCosting(invoiceId: string, userId: string) {
  await prisma.invCosting.updateMany({ where: { invoiceId }, data: { nextAttemptAt: new Date() } });
  await ledgerTx((tx) => auditAccounting(tx, { action: "inventory.costing.retry", entityType: "sales_document", entityId: invoiceId, userId }));
  return processCosting(invoiceId);
}

export async function costingOf(invoiceId: string) {
  return prisma.invCosting.findUnique({ where: { invoiceId } });
}
