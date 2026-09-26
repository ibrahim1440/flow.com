// Obligations (what the company owes and when) and forecast items (other expected flows).
//
// One liability is counted once as it progresses:
//   purchase order → supplier bill: the bill SUPERSEDES the PO obligation; a superseded
//     obligation is excluded from every total, forecast and alert.
//   payment request → payment: a reservation linked to an obligation is an earmark of that
//     obligation, not a second outflow; the payment is a bank line MATCHED to the obligation,
//     which reduces its remaining amount.
// Remaining = amount − Σ active payment matches. Only OPEN / PARTIALLY_PAID count.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { fromMinor, parseMoney, toMinor, type Minor } from "../money";
import { addMonths, dbDate, isDateString } from "../dates";
import {
  assertCan, assertScope, audit, COMPANY, FinanceError, reqStr, scopeWhere, str,
  type Db, type FinanceActor, type FinanceScope,
} from "./context";

export const OBLIGATION_TYPES = ["SUPPLIER_BILL", "PURCHASE_ORDER", "PAYROLL", "RENT", "TAX", "LOAN_REPAYMENT", "UTILITIES", "OTHER"] as const;
export type ObligationTypeT = (typeof OBLIGATION_TYPES)[number];
export const LIVE_OBLIGATION = ["OPEN", "PARTIALLY_PAID"] as const;

export async function paidByObligation(db: Db, ids: string[]): Promise<Map<string, Minor>> {
  if (ids.length === 0) return new Map();
  const rows = await db.bankTransactionMatch.groupBy({
    by: ["targetId"],
    where: { targetType: "OBLIGATION", targetId: { in: ids }, active: true, transaction: { status: { not: "VOID" } } },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.targetId, toMinor(r._sum.amount)]));
}

export async function recomputeObligationStatus(tx: Prisma.TransactionClient, id: string) {
  const o = await tx.finObligation.findUnique({ where: { id } });
  if (!o || o.status === "CANCELLED" || o.status === "SUPERSEDED") return o;
  const paid = (await paidByObligation(tx, [id])).get(id) ?? 0;
  const amount = toMinor(o.amount);
  const status = paid <= 0 ? "OPEN" : paid >= amount ? "PAID" : "PARTIALLY_PAID";
  if (status !== o.status) return tx.finObligation.update({ where: { id }, data: { status } });
  return o;
}

function parseType(v: unknown): ObligationTypeT {
  if (typeof v !== "string" || !(OBLIGATION_TYPES as readonly string[]).includes(v)) throw new FinanceError("Unknown obligation type.", 400);
  return v as ObligationTypeT;
}

async function checkCategoryRefs(db: Db, branchKey: string, allocationCategoryId: string | null, finCategoryId: string | null) {
  if (allocationCategoryId) {
    const c = await db.allocationCategory.findUnique({ where: { id: allocationCategoryId } });
    if (!c || c.branchKey !== branchKey) throw new FinanceError("Allocation category must belong to the same branch.", 400);
  }
  if (finCategoryId) {
    const c = await db.finCategory.findUnique({ where: { id: finCategoryId } });
    if (!c || c.kind !== "PAYMENT") throw new FinanceError("Budget category must be a payment category.", 400);
  }
}

export async function createObligation(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "budget_prepare");
  const branchKey = str(body.branchKey, 60) ?? COMPANY;
  assertScope(scope, branchKey);
  const type = parseType(body.type);
  const description = reqStr(body.description, "Description", 300);
  const counterparty = str(body.counterparty, 200);
  const dueDate = body.dueDate;
  if (!isDateString(dueDate)) throw new FinanceError("Due date is required (YYYY-MM-DD).", 400);
  const allocationCategoryId = str(body.allocationCategoryId, 40);
  const finCategoryId = str(body.finCategoryId, 40);
  const repeatMonths = body.repeatMonths === undefined ? 1 : Number(body.repeatMonths);
  if (!Number.isInteger(repeatMonths) || repeatMonths < 1 || repeatMonths > 12) throw new FinanceError("Repeat must be 1–12 months.", 400);

  let sourceType = "MANUAL";
  let sourceId: string | null = null;
  let amount = parseMoney(body.amount);
  if (body.purchaseRecordId) {
    // Purchases record what was bought; they carry no payment status, so an obligation is
    // created from one explicitly, once (unique sourceType+sourceId).
    const pr = await prisma.purchaseRecord.findUnique({ where: { id: String(body.purchaseRecordId) }, include: { supplier: true } });
    if (!pr) throw new FinanceError("Purchase record not found.", 404);
    sourceType = "PURCHASE_RECORD";
    sourceId = pr.id;
    if (amount === null) amount = parseMoney(pr.totalCost.toFixed(2));
    if (repeatMonths !== 1) throw new FinanceError("A purchase record becomes exactly one obligation.", 400);
  }
  if (amount === null || amount <= 0) throw new FinanceError("Amount must be a positive SAR amount with at most two decimals.", 400);

  return prisma.$transaction(async (tx) => {
    await checkCategoryRefs(tx, branchKey, allocationCategoryId, finCategoryId);
    const created = [];
    for (let i = 0; i < repeatMonths; i++) {
      const due = i === 0 ? dueDate : `${addMonths(dueDate.slice(0, 7), i)}-${dueDate.slice(8, 10)}`;
      const safeDue = isDateString(due) ? due : `${addMonths(dueDate.slice(0, 7), i)}-28`;
      const o = await tx.finObligation.create({
        data: {
          branchKey, type, description: repeatMonths > 1 ? `${description} (${safeDue.slice(0, 7)})` : description,
          counterparty, amount: fromMinor(amount!), dueDate: dbDate(safeDue), sourceType,
          sourceId: sourceId, allocationCategoryId, finCategoryId, createdBy: actor.id,
        },
      });
      await audit(tx, { action: "obligation.created", entityType: "FinObligation", entityId: o.id, branchKey, after: o, userId: actor.id });
      created.push(o);
    }
    return created;
  });
}

/** Purchase order → supplier bill. The PO stops counting the moment the bill exists. */
export async function supersedeObligation(actor: FinanceActor, scope: FinanceScope, id: string, body: Record<string, unknown>) {
  assertCan(actor, "budget_prepare");
  return prisma.$transaction(async (tx) => {
    const po = await tx.finObligation.findUnique({ where: { id } });
    if (!po) throw new FinanceError("Not found", 404);
    assertScope(scope, po.branchKey);
    if (po.status !== "OPEN") throw new FinanceError("Only an open, unpaid obligation can be superseded.", 409);
    const paid = (await paidByObligation(tx, [id])).get(id) ?? 0;
    if (paid > 0) throw new FinanceError("Payments are already matched to this obligation; match them to the bill instead.", 409);
    const amount = body.amount === undefined ? toMinor(po.amount) : parseMoney(body.amount);
    if (amount === null || amount <= 0) throw new FinanceError("Amount must be positive.", 400);
    const dueDate = body.dueDate ?? po.dueDate.toISOString().slice(0, 10);
    if (!isDateString(dueDate)) throw new FinanceError("Invalid due date.", 400);
    const type = body.type === undefined ? "SUPPLIER_BILL" : parseType(body.type);
    const bill = await tx.finObligation.create({
      data: {
        branchKey: po.branchKey, type, description: str(body.description, 300) ?? po.description,
        counterparty: po.counterparty, amount: fromMinor(amount), dueDate: dbDate(dueDate), sourceType: "SUPERSEDES",
        sourceId: po.id, supersedesId: po.id, allocationCategoryId: po.allocationCategoryId, finCategoryId: po.finCategoryId,
        costCenterId: po.costCenterId, createdBy: actor.id,
      },
    });
    const upd = await tx.finObligation.update({ where: { id: po.id }, data: { status: "SUPERSEDED" } });
    // Reservations held against the PO now belong to the bill — moved, not duplicated.
    await tx.paymentReservation.updateMany({ where: { obligationId: po.id, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } }, data: { obligationId: bill.id } });
    await audit(tx, { action: "obligation.superseded", entityType: "FinObligation", entityId: po.id, branchKey: po.branchKey, before: po, after: upd, refs: { supersededBy: bill.id }, userId: actor.id });
    await audit(tx, { action: "obligation.created", entityType: "FinObligation", entityId: bill.id, branchKey: bill.branchKey, after: bill, refs: { supersedes: po.id }, userId: actor.id });
    return bill;
  });
}

export async function cancelObligation(actor: FinanceActor, scope: FinanceScope, id: string, reason: string) {
  assertCan(actor, "budget_prepare");
  return prisma.$transaction(async (tx) => {
    const o = await tx.finObligation.findUnique({ where: { id } });
    if (!o) throw new FinanceError("Not found", 404);
    assertScope(scope, o.branchKey);
    if (!(LIVE_OBLIGATION as readonly string[]).includes(o.status)) throw new FinanceError("Only a live obligation can be cancelled.", 409);
    const paid = (await paidByObligation(tx, [id])).get(id) ?? 0;
    if (paid > 0) throw new FinanceError("Payments are matched to this obligation; it cannot be cancelled.", 409);
    const live = await tx.paymentReservation.count({ where: { obligationId: id, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } } });
    if (live > 0) throw new FinanceError("Release its payment reservations first.", 409);
    const upd = await tx.finObligation.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: actor.id, cancelReason: reason } });
    await audit(tx, { action: "obligation.cancelled", entityType: "FinObligation", entityId: id, branchKey: o.branchKey, before: o, after: upd, reason, userId: actor.id });
    return upd;
  });
}

export type ObligationView = {
  id: string; branchKey: string; type: string; description: string; counterparty: string | null;
  amount: Minor; paid: Minor; remaining: Minor; reserved: Minor; dueDate: string; status: string;
  allocationCategoryId: string | null; finCategoryId: string | null; sourceType: string; sourceId: string | null;
  supersedesId: string | null;
};

export async function listObligations(
  db: Db,
  scope: FinanceScope,
  filter: { status?: "LIVE" | "ALL"; dueBefore?: string; take?: number; skip?: number } = {},
): Promise<{ rows: ObligationView[]; total: number }> {
  const where: Prisma.FinObligationWhereInput = {
    ...scopeWhere(scope),
    ...(filter.status === "ALL" ? {} : { status: { in: [...LIVE_OBLIGATION] } }),
    ...(filter.dueBefore ? { dueDate: { lte: dbDate(filter.dueBefore) } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.finObligation.findMany({ where, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }], take: filter.take ?? 200, skip: filter.skip ?? 0 }),
    db.finObligation.count({ where }),
  ]);
  const paid = await paidByObligation(db, rows.map((r) => r.id));
  const res = await db.paymentReservation.groupBy({
    by: ["obligationId"],
    where: { obligationId: { in: rows.map((r) => r.id) }, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } },
    _sum: { amount: true },
  });
  const reserved = new Map(res.map((r) => [r.obligationId!, toMinor(r._sum.amount)]));
  return {
    total,
    rows: rows.map((o) => {
      const amount = toMinor(o.amount);
      const p = paid.get(o.id) ?? 0;
      const live = (LIVE_OBLIGATION as readonly string[]).includes(o.status);
      return {
        id: o.id, branchKey: o.branchKey, type: o.type, description: o.description, counterparty: o.counterparty,
        amount, paid: p, remaining: live ? Math.max(0, amount - p) : 0, reserved: reserved.get(o.id) ?? 0,
        dueDate: o.dueDate.toISOString().slice(0, 10), status: o.status,
        allocationCategoryId: o.allocationCategoryId, finCategoryId: o.finCategoryId,
        sourceType: o.sourceType, sourceId: o.sourceId, supersedesId: o.supersedesId,
      };
    }),
  };
}

// ─── Forecast items ────────────────────────────────────────────────────────────

export async function createForecastItem(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "budget_prepare");
  const branchKey = str(body.branchKey, 60) ?? COMPANY;
  assertScope(scope, branchKey);
  const kind = body.kind;
  if (kind !== "RECEIPT" && kind !== "PAYMENT") throw new FinanceError("Kind must be RECEIPT or PAYMENT.", 400);
  const amount = parseMoney(body.amount);
  if (amount === null || amount <= 0) throw new FinanceError("Amount must be a positive SAR amount.", 400);
  if (!isDateString(body.expectedDate)) throw new FinanceError("Expected date is required (YYYY-MM-DD).", 400);
  const finCategoryId = str(body.finCategoryId, 40);
  if (finCategoryId) {
    const c = await prisma.finCategory.findUnique({ where: { id: finCategoryId } });
    if (!c || c.kind !== kind) throw new FinanceError("Budget category kind must match the forecast kind.", 400);
  }
  return prisma.$transaction(async (tx) => {
    const item = await tx.finForecastItem.create({
      data: {
        branchKey, kind, description: reqStr(body.description, "Description", 300), counterparty: str(body.counterparty, 200),
        amount: fromMinor(amount), expectedDate: dbDate(body.expectedDate as string), finCategoryId, createdBy: actor.id,
      },
    });
    await audit(tx, { action: "forecast_item.created", entityType: "FinForecastItem", entityId: item.id, branchKey, after: item, userId: actor.id });
    return item;
  });
}

export async function closeForecastItem(actor: FinanceActor, scope: FinanceScope, id: string, body: Record<string, unknown>) {
  assertCan(actor, "budget_prepare");
  const status = body.status;
  if (status !== "REALIZED" && status !== "CANCELLED") throw new FinanceError("Status must be REALIZED or CANCELLED.", 400);
  return prisma.$transaction(async (tx) => {
    const it = await tx.finForecastItem.findUnique({ where: { id } });
    if (!it) throw new FinanceError("Not found", 404);
    assertScope(scope, it.branchKey);
    if (it.status !== "OPEN") throw new FinanceError("Already closed.", 409);
    const realizedTxnId = status === "REALIZED" ? str(body.realizedTxnId, 40) : null;
    if (realizedTxnId) {
      const t = await tx.bankTransaction.findUnique({ where: { id: realizedTxnId } });
      if (!t || t.branchKey !== it.branchKey) throw new FinanceError("Bank line not found in this branch.", 404);
    }
    const upd = await tx.finForecastItem.update({ where: { id }, data: { status, realizedTxnId } });
    await audit(tx, { action: `forecast_item.${status.toLowerCase()}`, entityType: "FinForecastItem", entityId: id, branchKey: it.branchKey, before: it, after: upd, userId: actor.id });
    return upd;
  });
}

export async function listForecastItems(db: Db, scope: FinanceScope, filter: { from?: string; to?: string; status?: string } = {}) {
  return db.finForecastItem.findMany({
    where: {
      ...scopeWhere(scope),
      status: (filter.status as "OPEN") ?? "OPEN",
      ...(filter.from || filter.to
        ? { expectedDate: { ...(filter.from ? { gte: dbDate(filter.from) } : {}), ...(filter.to ? { lte: dbDate(filter.to) } : {}) } }
        : {}),
    },
    orderBy: { expectedDate: "asc" },
    take: 500,
  });
}
