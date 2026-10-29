// Credit warnings, grace and the sales hold — the database side (feat/credit-hold).
//
// Reads the rows the pure rules in ./credit.ts judge, and writes their results:
//   * loadCreditFlags     — the customer's WHOLE balance and aging (every deal, whoever owns it):
//                           the same accepted quotations, approved collections and first
//                           deliveries as GET /api/customers/[id]/account, through the same
//                           statementOfAccount — so the badge and «أعمار الديون» never disagree;
//   * assertSalesAllowed  — THE single gate of every path that creates a quotation or an order
//                           (POST /api/sales/quotes, a quotation's revision, createOrderWithNumber —
//                           used by POST /api/orders and by an accepted quotation's conversion).
//                           Settles an expired / paid hold first, then refuses 409
//                           CUSTOMER_SALES_HOLD while one is in force;
//   * settleHold          — lifts a hold whose automatic ending has come (on read and at creation;
//                           no job), once, with an AUTO_LIFT entry in the log;
//   * placeGrace / placeHold / liftHold — the three acts of a holder of customers › sales_hold,
//                           each serialised on the customer row and logged.
//
// In-app notification (feat/notifications): every act — a hold, a grace, a lift by hand or by
// itself — notifies the customer's account owner (the rep) and the holders of customers › sales_hold
// (sales.customer_hold, lib/notifications/catalog.ts), in the same transaction; every act also stays
// in the customer's credit log.

import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { Decimal, acceptedDocumentPerDeal, statementOfAccount } from "./aggregates";
import {
  creditFlags, creditWarning, activeGrace, graceHistory, graceUntil, holdBasis, holdEnds, holdVerdict, salesHoldRefusal,
  BASIS_REASON_AR, BASIS_REASON_EN, FALLBACK_HOLD_DAYS,
  type CreditFlags, type GraceRow, type HoldInput, type HoldRow,
} from "./credit";

type Db = PrismaNS.TransactionClient;

const HOLD_SELECT = {
  id: true, customerId: true, reason: true, basis: true, startsAt: true, endsAt: true, autoLiftAtEnd: true, autoLiftOnPayment: true, createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

/**
 * The credit flags of each customer, from its whole account. Customers without a row are absent.
 * Five queries whatever the number of customers (the list asks for up to 200 at once).
 */
export async function loadCreditFlags(db: Db, customerIds: string[], now: Date): Promise<Map<string, CreditFlags & { termsDays: number | null }>> {
  const out = new Map<string, CreditFlags & { termsDays: number | null }>();
  if (customerIds.length === 0) return out;
  const customers = await db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, creditLimit: true, paymentTermsDays: true } });
  // Sales invoicing A2: where accounting is active, the outstanding balance is the customer's invoice open balance
  // (issued invoices and debit notes − credit notes − receipts) and «متأخر السداد» counts from each invoice's due
  // date. Otherwise (accounting not active) the figures below are unchanged: accepted quotations, approved
  // collections, first deliveries — backward compatible.
  const acct = await db.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true } });
  if (acct?.accountingActive) {
    // Loaded on demand: this module is imported by pure catalogues that never open a database.
    const { invoiceCreditFigures } = await import("@/lib/services/invoicing/ar");
    const figures = await invoiceCreditFigures(db, customers.map((c) => c.id), now);
    for (const c of customers) {
      const f = figures.get(c.id)!;
      const limit = c.creditLimit == null ? null : new Decimal(c.creditLimit.toString());
      out.set(c.id, { ...creditFlags(limit, new Decimal(f.outstanding.toString()), f.open.map((o) => ({ unpaid: new Decimal(o.unpaid.toString()), daysOverdue: o.daysOverdue }))), termsDays: c.paymentTermsDays });
    }
    return out;
  }
  const quotes = await db.quote.findMany({
    where: { status: "ACCEPTED", opportunity: { customerId: { in: customerIds } } },
    select: {
      id: true, quoteNumber: true, revision: true, opportunityId: true, acceptedAt: true, issuedAt: true, createdAt: true, grandTotal: true,
      opportunity: { select: { customerId: true, title: true } },
    },
  });
  const accepted = acceptedDocumentPerDeal(quotes);
  const dealIds = [...new Set(accepted.map((q) => q.opportunityId))];
  const acceptedIds = accepted.map((q) => q.id);
  const [approved, links] = await Promise.all([
    dealIds.length
      ? db.salesCollection.findMany({ where: { opportunityId: { in: dealIds }, status: "APPROVED" }, select: { id: true, opportunityId: true, amountGross: true, collectedAt: true, paymentMethod: true } })
      : Promise.resolve([]),
    acceptedIds.length
      ? db.opportunityOrder.findMany({
          where: { quoteId: { in: acceptedIds } },
          select: { quoteId: true, order: { select: { items: { select: { deliveries: { orderBy: { date: "asc" }, take: 1, select: { date: true } } } } } } },
        })
      : Promise.resolve([]),
  ]);
  const firstDelivery = new Map<string, Date>();
  for (const l of links) {
    for (const i of l.order.items) for (const d of i.deliveries) {
      const cur = firstDelivery.get(l.quoteId!);
      if (!cur || d.date < cur) firstDelivery.set(l.quoteId!, d.date);
    }
  }
  for (const c of customers) {
    const docs = accepted.filter((q) => q.opportunity.customerId === c.id);
    const deals = new Set(docs.map((d) => d.opportunityId));
    const st = statementOfAccount(
      docs.map((q) => ({
        opportunityId: q.opportunityId, dealTitle: q.opportunity.title, quoteId: q.id, quoteNumber: q.quoteNumber, revision: q.revision,
        at: q.acceptedAt ?? q.issuedAt ?? q.createdAt, grandTotal: new Decimal(q.grandTotal.toString()), firstDeliveryAt: firstDelivery.get(q.id) ?? null,
      })),
      approved.filter((p) => !!p.opportunityId && deals.has(p.opportunityId)).map((p) => ({
        id: p.id, opportunityId: p.opportunityId ?? "", at: p.collectedAt, amountGross: new Decimal(p.amountGross.toString()), method: p.paymentMethod, orderNumber: null, reference: null,
      })),
      { termsDays: c.paymentTermsDays, now },
    );
    const limit = c.creditLimit == null ? null : new Decimal(c.creditLimit.toString());
    out.set(c.id, { ...creditFlags(limit, st.totals.outstanding, st.open), termsDays: c.paymentTermsDays });
  }
  return out;
}

async function gracesOf(db: Db, customerIds: string[]): Promise<Map<string, GraceRow[]>> {
  const rows = customerIds.length
    ? await db.customerCreditLog.findMany({
        where: { customerId: { in: customerIds }, kind: "GRACE" },
        orderBy: { createdAt: "desc" },
        select: { id: true, customerId: true, days: true, untilAt: true, reason: true, createdAt: true, actor: { select: { id: true, name: true } } },
      })
    : [];
  const out = new Map<string, GraceRow[]>();
  for (const r of rows) {
    const list = out.get(r.customerId) ?? [];
    list.push({ id: r.id, days: r.days ?? 0, untilAt: r.untilAt!, reason: r.reason, createdAt: r.createdAt, actor: r.actor });
    out.set(r.customerId, list);
  }
  return out;
}

async function openHoldsOf(db: Db, customerIds: string[]) {
  const rows = customerIds.length
    ? await db.customerSalesHold.findMany({ where: { customerId: { in: customerIds }, liftedAt: null }, select: HOLD_SELECT })
    : [];
  return new Map(rows.map((h) => [h.customerId, h]));
}

export type CreditState = {
  flags: CreditFlags & { termsDays: number | null };
  graces: GraceRow[];
  hold: (HoldRow & { customerId: string }) | null;
};

/**
 * The state of each customer at `now`: flags, graces, and the hold IN FORCE (an unlifted hold
 * whose automatic ending has come is reported as not in force — `settleHold` records that).
 * Read-only.
 */
export async function loadCreditStates(db: Db, customerIds: string[], now: Date): Promise<Map<string, CreditState & { endedHold: (HoldRow & { customerId: string }) | null }>> {
  const [flags, graces, holds] = await Promise.all([loadCreditFlags(db, customerIds, now), gracesOf(db, customerIds), openHoldsOf(db, customerIds)]);
  const out = new Map<string, CreditState & { endedHold: (HoldRow & { customerId: string }) | null }>();
  for (const [id, f] of flags) {
    const open = holds.get(id) ?? null;
    const inForce = open ? holdVerdict(open, f, now).inForce : false;
    out.set(id, { flags: f, graces: graces.get(id) ?? [], hold: inForce ? open : null, endedHold: open && !inForce ? open : null });
  }
  return out;
}

/** feat/notifications: tell the customer's rep and the sales-hold holders about a credit act. */
async function notifyCreditAct(db: Db, customerId: string, a: { kind: "HOLD" | "GRACE" | "LIFT" | "AUTO_LIFT"; key: string; actorId: string | null; days?: number | null; reason?: string | null }) {
  const c = await db.customer.findUnique({ where: { id: customerId }, select: { name: true, nameAr: true, accountOwnerId: true } });
  if (!c) return;
  const { notify } = await import("@/lib/notifications/notify");
  await notify(db, {
    event: "sales.customer_hold", dedupeKey: `${customerId}:${a.kind}:${a.key}`, actorId: a.actorId,
    entity: { type: "Customer", id: customerId },
    facts: { kind: a.kind, customerName: c.nameAr || c.name, customerId, days: a.days ?? null, reason: a.reason ?? null },
    people: { customerOwner: c.accountOwnerId }, scopeOwners: [c.accountOwnerId],
  });
}

/**
 * Lift, once, an unlifted hold whose automatic ending has come — EXPIRED at its end date, PAID now —
 * and log it (AUTO_LIFT, no actor). Idempotent: the update is conditional on the hold still being
 * unlifted, and only the call that lifted it writes the log.
 */
export async function settleHold(db: Db, customerId: string, flags: CreditFlags, now: Date): Promise<boolean> {
  const open = await db.customerSalesHold.findFirst({ where: { customerId, liftedAt: null }, select: HOLD_SELECT });
  if (!open) return false;
  const v = holdVerdict(open, flags, now);
  if (v.inForce) return false;
  const done = await db.customerSalesHold.updateMany({ where: { id: open.id, liftedAt: null }, data: { liftedAt: v.at, liftKind: v.liftKind } });
  if (done.count === 0) return false;
  await db.customerCreditLog.create({
    data: {
      customerId, kind: "AUTO_LIFT", holdId: open.id,
      detail: { liftKind: v.liftKind, overLimit: flags.overLimit, overdueDays: flags.overdueDays } as PrismaNS.InputJsonValue,
    },
  });
  await notifyCreditAct(db, customerId, { kind: "AUTO_LIFT", key: open.id, actorId: null });
  return true;
}

/**
 * THE gate of every path that creates a quotation or an order for a customer. Nothing to do
 * without an unlifted hold (one indexed read); otherwise the hold is settled against the
 * customer's figures and, if still in force, the creation is refused 409 CUSTOMER_SALES_HOLD.
 * Runs inside the caller's transaction when given one.
 */
export async function assertSalesAllowed(db: Db, customerId: string | null | undefined, now: Date = new Date()): Promise<void> {
  if (!customerId) return;
  const open = await db.customerSalesHold.findFirst({ where: { customerId, liftedAt: null }, select: HOLD_SELECT });
  if (!open) return;
  // A hold that can end by itself needs the figures; one that cannot is in force as it stands.
  if (open.autoLiftAtEnd || open.autoLiftOnPayment) {
    const flags = (await loadCreditFlags(db, [customerId], now)).get(customerId);
    if (flags && (await settleHold(db, customerId, flags, now))) return;
  }
  throw salesHoldRefusal(open);
}

/** Serialise every credit act of one customer (and stop at a customer that does not exist). */
async function lockCustomer(db: Db, customerId: string) {
  const rows = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
  if (!rows[0]) throw { _appCode: 404, message: "العميل غير موجود.", errorEn: "Customer not found." };
}

type Refusal = { _appCode: number; code: string; message: string; errorAr: string; errorEn: string; [k: string]: unknown };
const refuse = (status: number, code: string, ar: string, en: string, extra: Record<string, unknown> = {}): Refusal =>
  ({ _appCode: status, code, message: ar, errorAr: ar, errorEn: en, ...extra });

/**
 * «أيام سماح»: record a grace of `days` on the customer — no hold. Refused while a hold is in
 * force (lift it first), and — when the customer has had a grace before — unless the request
 * confirms it (`confirmRepeat`): 409 GRACE_REPEAT_UNCONFIRMED carries the history the dialog shows.
 */
export async function placeGrace(db: Db, input: { customerId: string; actorId: string; days: number; reason: string | null; confirmRepeat: boolean; now: Date }) {
  await lockCustomer(db, input.customerId);
  const state = (await loadCreditStates(db, [input.customerId], input.now)).get(input.customerId)!;
  if (state.endedHold) await settleHold(db, input.customerId, state.flags, input.now);
  if (state.hold) {
    throw refuse(409, "HOLD_ACTIVE", "البيع لهذا العميل موقوف. ارفع الإيقاف أولًا قبل إعطاء أيام سماح.", "Sales to this customer are on hold. Lift the hold before giving grace days.");
  }
  const history = graceHistory(state.graces);
  if (history.count > 0 && !input.confirmRepeat) {
    throw refuse(409, "GRACE_REPEAT_UNCONFIRMED",
      `هذا العميل حصل على أيام سماح من قبل (${history.count} ${history.count === 1 ? "مرة" : "مرات"}). أكّد الاستمرار.`,
      `This customer has had grace days before (${history.count} time${history.count === 1 ? "" : "s"}). Confirm to continue.`,
      { graces: { count: history.count, last: history.last } });
  }
  const untilAt = graceUntil(input.now, input.days);
  const row = await db.customerCreditLog.create({
    data: {
      customerId: input.customerId, kind: "GRACE", days: input.days, untilAt, reason: input.reason, actorId: input.actorId, createdAt: input.now,
      detail: { overLimit: state.flags.overLimit, overdueDays: state.flags.overdueDays, previous: history.count } as PrismaNS.InputJsonValue,
    },
    select: { id: true, days: true, untilAt: true, reason: true, createdAt: true },
  });
  await notifyCreditAct(db, input.customerId, { kind: "GRACE", key: row.id, actorId: input.actorId, days: input.days, reason: input.reason });
  return { grace: row, graces: { count: history.count + 1 } };
}

/** «إيقاف البيع»: place a hold. One in force at a time; «حتى السداد» needs something to pay. */
export async function placeHold(db: Db, input: { customerId: string; actorId: string; hold: HoldInput; now: Date }) {
  await lockCustomer(db, input.customerId);
  const state = (await loadCreditStates(db, [input.customerId], input.now)).get(input.customerId)!;
  if (state.endedHold) await settleHold(db, input.customerId, state.flags, input.now);
  if (state.hold) throw refuse(409, "ALREADY_HELD", "البيع لهذا العميل موقوف بالفعل.", "Sales to this customer are already on hold.");
  const h = input.hold;
  if (h.autoLiftOnPayment && state.flags.clear) {
    throw refuse(409, "NOTHING_DUE",
      "العميل ضمن حد الائتمان ولا متأخرات عليه، فالإيقاف «حتى السداد» أو مع الرفع عند السداد يُرفع فورًا. اختر مدة دون الرفع عند السداد.",
      "The customer is within its limit with nothing overdue, so a hold that lifts on payment would lift at once. Choose a duration without lift-on-payment.");
  }
  const endsAt = holdEnds(input.now, h.days);
  const basis = holdBasis(state.flags);
  const hold = await db.customerSalesHold.create({
    data: {
      customerId: input.customerId, reason: h.reason, basis, startsAt: input.now, endsAt,
      autoLiftAtEnd: h.autoLiftAtEnd && endsAt != null, autoLiftOnPayment: h.autoLiftOnPayment, createdById: input.actorId, createdAt: input.now,
    },
    select: HOLD_SELECT,
  });
  await db.customerCreditLog.create({
    data: {
      customerId: input.customerId, kind: "HOLD", holdId: hold.id, days: h.days, untilAt: endsAt, reason: h.reason, actorId: input.actorId, createdAt: input.now,
      detail: {
        basis, untilPaid: h.days == null, autoLiftAtEnd: hold.autoLiftAtEnd, autoLiftOnPayment: hold.autoLiftOnPayment,
        overLimit: state.flags.overLimit, overdueDays: state.flags.overdueDays,
      } as PrismaNS.InputJsonValue,
    },
  });
  await notifyCreditAct(db, input.customerId, { kind: "HOLD", key: hold.id, actorId: input.actorId, days: h.days, reason: h.reason });
  return hold;
}

/** «رفع الإيقاف»: lift the hold in force, by hand, with a reason. */
export async function liftHold(db: Db, input: { customerId: string; actorId: string; reason: string; now: Date }) {
  await lockCustomer(db, input.customerId);
  const state = (await loadCreditStates(db, [input.customerId], input.now)).get(input.customerId)!;
  if (state.endedHold) await settleHold(db, input.customerId, state.flags, input.now);
  if (!state.hold) throw refuse(409, "NOT_HELD", "لا إيقاف قائم على هذا العميل.", "There is no hold on this customer.");
  const done = await db.customerSalesHold.updateMany({
    where: { id: state.hold.id, liftedAt: null },
    data: { liftedAt: input.now, liftedById: input.actorId, liftKind: "MANUAL", liftReason: input.reason },
  });
  if (done.count === 0) throw refuse(409, "NOT_HELD", "لا إيقاف قائم على هذا العميل.", "There is no hold on this customer.");
  await db.customerCreditLog.create({
    data: { customerId: input.customerId, kind: "LIFT", holdId: state.hold.id, reason: input.reason, actorId: input.actorId, createdAt: input.now },
  });
  await notifyCreditAct(db, input.customerId, { kind: "LIFT", key: state.hold.id, actorId: input.actorId, reason: input.reason });
  return { liftedAt: input.now, holdId: state.hold.id };
}

/**
 * What a screen shows about one customer's credit (GET /api/customers/[id]/credit and the account
 * page). Settles a hold whose automatic ending has come before reporting (the schedule's
 * on-read pattern). Amounts only for viewers who see every deal (`all`): a rep sees the flags.
 */
export async function creditView(db: Db, customerId: string, opts: { all: boolean; canHold: boolean; now: Date }) {
  let state = (await loadCreditStates(db, [customerId], opts.now)).get(customerId);
  if (!state) return null;
  if (state.endedHold && (await settleHold(db, customerId, state.flags, opts.now))) {
    state = { ...state, endedHold: null };
  }
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { defaultHoldDays: true } });
  const f = state.flags;
  const grace = activeGrace(state.graces, opts.now);
  const w = creditWarning(f, grace, state.hold);
  const basis = holdBasis(f);
  const m2 = (d: Decimal) => d.toFixed(2);
  return {
    flags: { overLimit: f.overLimit, overdueDays: f.overdueDays, clear: f.clear, hasLimit: f.limit != null, termsDays: f.termsDays },
    warning: { overLimit: w.overLimit, overdueDays: w.overdueDays, any: w.any },
    amounts: opts.all ? { limit: f.limit ? m2(f.limit) : null, outstanding: m2(f.outstanding), over: m2(f.amountOver), overdue: m2(f.overdueAmount), currency: "SAR" } : null,
    grace: grace ? { id: grace.id, days: grace.days, until: grace.untilAt, reason: grace.reason, at: grace.createdAt, by: grace.actor } : null,
    graces: graceHistory(state.graces),
    hold: state.hold ? {
      id: state.hold.id, reason: state.hold.reason, basis: state.hold.basis, startsAt: state.hold.startsAt, endsAt: state.hold.endsAt,
      untilPaid: state.hold.endsAt == null, autoLiftAtEnd: state.hold.autoLiftAtEnd, autoLiftOnPayment: state.hold.autoLiftOnPayment, by: state.hold.createdBy,
    } : null,
    suggestedReason: { ar: BASIS_REASON_AR[basis], en: BASIS_REASON_EN[basis] },
    defaultHoldDays: customer?.defaultHoldDays ?? null,
    proposedHoldDays: customer?.defaultHoldDays ?? FALLBACK_HOLD_DAYS,
    can: { hold: opts.canHold },
  };
}
export type CreditView = NonNullable<Awaited<ReturnType<typeof creditView>>>;

/** The list's badges for many customers at once (read-only: nothing is settled from a list). */
export async function creditBadges(db: Db, customerIds: string[], now: Date) {
  const states = await loadCreditStates(db, customerIds, now);
  const out: Record<string, { overLimit: boolean; overdueDays: number; graceUntil: Date | null; hold: { endsAt: Date | null; untilPaid: boolean } | null }> = {};
  for (const [id, s] of states) {
    const w = creditWarning(s.flags, activeGrace(s.graces, now), s.hold);
    if (!w.any && !w.grace) continue;
    out[id] = { overLimit: w.overLimit, overdueDays: w.overdueDays, graceUntil: w.grace?.untilAt ?? null, hold: s.hold ? { endsAt: s.hold.endsAt, untilPaid: s.hold.endsAt == null } : null };
  }
  return out;
}

/** The customer's credit log, newest first (the account page's activity). */
export async function creditLog(db: Db, customerId: string, take = 100) {
  return db.customerCreditLog.findMany({
    where: { customerId }, orderBy: { createdAt: "desc" }, take,
    select: { id: true, kind: true, holdId: true, days: true, untilAt: true, reason: true, detail: true, createdAt: true, actor: { select: { id: true, name: true } } },
  });
}
