// «عمولة عرض المحاسب» (owner decision, 1 Nov 2026). The accountant quotes customers without a deal (channel ACCOUNTING,
// 20261213090000) — no rep, no commission. When the customer belongs to a sales rep (Customer.accountOwnerId), the
// rep may have asked the accountant to quote in their place (busy, away, urgent). So, at issue:
//   · the quotation is marked PENDING (commissionDecision) with the rep it was issued under;
//   · the supervisors — holders of sales › lead_assign and of accounting › supervise — and the owner (every active
//     admin) are told in the app and by e-mail, ONE row per person; the rep is told too (info only);
//   · one of them decides: ASSIGNED — the quotation moves onto a new deal owned by the rep (channel SALES) and is from
//     then on the rep's deal like any other (the collection is recorded on the deal; the commission engine is
//     untouched); NONE — it stays the accounting section's, no deal, no commission. Reason required, audited, everyone
//     told of the outcome. Only while nothing has been paid against it.
//   · still PENDING after 3 Riyadh business days → a daily reminder (riding the daily notification run).
// A customer with no rep: nothing happens — the quotation simply carries no commission.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { notify } from "@/lib/notifications/notify";
import { effectivePermissions } from "@/lib/notifications/recipients";
import { audit } from "@/lib/hr/core";
import { businessDaysBetween, riyadhDayText } from "@/lib/services/invoicing/request-math";
import { requireStageFor } from "./stages";
import { advanceToQuotationStage, winOnAcceptedQuote } from "./lifecycle";
import { quoteRequestKey } from "./quote-to-order";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;
type AppError = { _appCode: number; message: string; errorEn: string; code: string };
const refuse = (status: number, code: string, message: string, errorEn: string): AppError => ({ _appCode: status, code, message, errorEn });

export const COMMISSION_REMINDER_BUSINESS_DAYS = 3;
export type CommissionDecision = "ASSIGNED" | "NONE";

/**
 * Who decides: a sales supervisor (sales › lead_assign) or an accounting supervisor (accounting › supervise). The owner
 * decides through the same keys (the admin template holds lead_assign; SIMPLE MODE gives the admin every key) — never by
 * role name.
 */
export function canDecideCommission(p: Permissions | Record<string, unknown>): boolean {
  const perms = p as Permissions;
  return (hasModuleAccess(perms, "sales") && hasSubPrivilege(perms, "sales", "lead_assign"))
    || (hasModuleAccess(perms, "accounting") && hasSubPrivilege(perms, "accounting", "supervise"));
}

const money = (v: { toString(): string }) => `${Number(v.toString()).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ⃁`;

/**
 * Notify one event, split by where each person can open the quotation: holders of the sales module get the Sales
 * address, the others (accounting only) the accounting section's. Disjoint sets, so still one row per person.
 */
async function notifySplit(db: Db, event: string, base: { dedupeKey: string; actorId: string | null; facts: Record<string, string | number | null>; people?: Record<string, string | string[] | null> }, quoteId: string) {
  const rows = await db.employee.findMany({ where: { active: true }, select: { id: true, role: true, permissions: true } });
  const salesIds: string[] = [], otherIds: string[] = [];
  for (const r of rows) (hasModuleAccess(effectivePermissions(r), "sales") ? salesIds : otherIds).push(r.id);
  const entity = { type: "Quote", id: quoteId };
  const a = await notify(db, { event, dedupeKey: base.dedupeKey, actorId: base.actorId, facts: { ...base.facts, via: "sales" }, people: base.people, entity, exclude: otherIds });
  const b = await notify(db, { event, dedupeKey: base.dedupeKey, actorId: base.actorId, facts: { ...base.facts, via: "accounting" }, people: base.people, entity, exclude: salesIds });
  return { recipients: [...a.recipients, ...b.recipients], inserted: a.inserted + b.inserted };
}

async function admins(db: Db): Promise<string[]> {
  return (await db.employee.findMany({ where: { role: "admin", active: true }, select: { id: true } })).map((e) => e.id);
}

type Head = {
  id: string; quoteNumber: string; status: string; channel: string; grandTotal: { toString(): string }; customerId: string | null; opportunityId: string | null;
  commissionDecision: string | null; commissionRepId: string | null; createdById: string | null; issuedAt: Date | null;
};
const HEAD = { id: true, quoteNumber: true, status: true, channel: true, grandTotal: true, customerId: true, opportunityId: true, commissionDecision: true, commissionRepId: true, createdById: true, issuedAt: true } as const;

async function namesOf(db: Db, q: { customerId: string | null; commissionRepId: string | null }, issuerId: string | null) {
  const [customer, rep, issuer] = await Promise.all([
    q.customerId ? db.customer.findUnique({ where: { id: q.customerId }, select: { name: true, nameAr: true } }) : null,
    q.commissionRepId ? db.employee.findUnique({ where: { id: q.commissionRepId }, select: { name: true } }) : null,
    issuerId ? db.employee.findUnique({ where: { id: issuerId }, select: { name: true } }) : null,
  ]);
  return { customerName: customer?.nameAr || customer?.name || "", customerNameEn: customer?.name || "", repName: rep?.name ?? "", issuerName: issuer?.name ?? "" };
}

/**
 * At issue of an ACCOUNTING quotation (same transaction as the issue): PENDING + the notifications when the customer
 * has a rep; nothing otherwise. Idempotent: an already-decided or already-pending quotation is left as it is.
 */
export async function onAccountingQuoteIssued(tx: Tx, quoteId: string, actorId: string) {
  const q = await tx.quote.findUnique({ where: { id: quoteId }, select: HEAD });
  if (!q || q.channel !== "ACCOUNTING" || !q.customerId || q.commissionDecision) return { pending: false };
  const customer = await tx.customer.findUnique({ where: { id: q.customerId }, select: { accountOwnerId: true, accountOwner: { select: { active: true } } } });
  const repId = customer?.accountOwnerId && customer.accountOwner?.active ? customer.accountOwnerId : null;
  if (!repId) return { pending: false };
  await tx.quote.update({ where: { id: q.id }, data: { commissionDecision: "PENDING", commissionRepId: repId } });
  const names = await namesOf(tx, { customerId: q.customerId, commissionRepId: repId }, actorId);
  const facts = { quoteId: q.id, quoteNumber: q.quoteNumber, amount: money(q.grandTotal), ...names };
  await notifySplit(tx, "sales.accounting_quote_commission", { dedupeKey: q.id, actorId, facts, people: { admins: await admins(tx) } }, q.id);
  await notify(tx, { event: "sales.accounting_quote_for_rep", dedupeKey: q.id, actorId, facts: { ...facts, via: "sales" }, people: { rep: repId }, entity: { type: "Quote", id: q.id } });
  return { pending: true, repId };
}

/** Has anything been paid against this quotation (its order's collections, its invoices' applied receipts)? */
export async function paidAgainst(db: Db, q: { id: string; quoteNumber: string | null }): Promise<boolean> {
  // An unnumbered draft (owner decision, quote-45 round) has no order by number — never match the orders WITHOUT one.
  const orders = q.quoteNumber ? await db.order.findMany({ where: { quotationNumber: q.quoteNumber }, select: { id: true } }) : [];
  const orderIds = orders.map((o) => o.id);
  const invoices = orderIds.length ? await db.salesInvoice.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } }) : [];
  const invoiceIds = invoices.map((i) => i.id);
  const collections = await db.salesCollection.count({
    where: {
      status: { in: ["PENDING_VERIFICATION", "APPROVED"] },
      OR: [{ quoteId: q.id }, ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []), ...(invoiceIds.length ? [{ invoiceId: { in: invoiceIds } }] : [])],
    },
  });
  if (collections > 0) return true;
  if (!invoiceIds.length) return false;
  return (await db.arApplication.count({ where: { invoiceId: { in: invoiceIds }, status: "APPLIED" } })) > 0;
}

/** The supervisors' decision. ASSIGNED: a deal for the rep, the quotation (and its order, if any) moves onto it. */
export async function decideAccountingQuoteCommission(tx: Tx, input: { quoteId: string; decision: unknown; reason: unknown; actor: { id: string; permissions: Permissions } }) {
  if (!canDecideCommission(input.actor.permissions)) throw refuse(403, "FORBIDDEN", "قرار العمولة لمشرف المبيعات أو مشرف المحاسبة أو المدير.", "Only a sales or accounting supervisor or the owner decides the commission.");
  const decision = input.decision === "ASSIGNED" || input.decision === "NONE" ? input.decision : null;
  if (!decision) throw refuse(400, "BAD_DECISION", "اختر «إسناد العمولة للمندوب» أو «بدون عمولة».", "Choose ASSIGNED or NONE.");
  const reason = typeof input.reason === "string" ? input.reason.trim().replace(/\s+/g, " ").slice(0, 500) : "";
  if (reason.length < 3) throw refuse(400, "REASON_REQUIRED", "اكتب سبب القرار.", "Give the reason for the decision.");
  await tx.$queryRaw`SELECT "id" FROM "Quote" WHERE "id" = ${input.quoteId} FOR UPDATE`;
  const q = await tx.quote.findUnique({ where: { id: input.quoteId }, select: HEAD });
  if (!q) throw refuse(404, "NOT_FOUND", "عرض السعر غير موجود.", "Quotation not found.");
  if (q.commissionDecision !== "PENDING") {
    throw refuse(409, "NOT_PENDING", q.commissionDecision ? "تم القرار على عمولة هذا العرض من قبل." : "هذا العرض ما عليه قرار عمولة (العميل غير تابع لمندوب).", "There is no pending commission decision on this quotation.");
  }
  if (await paidAgainst(tx, q)) {
    throw refuse(409, "ALREADY_PAID", "انسجل تحصيل على هذا العرض، فما يمديك تُسند العمولة الحين. راجع قسم العمولات لو تحتاج تسوية.", "A payment is already recorded against this quotation; the commission can no longer be assigned.");
  }
  if (decision === "ASSIGNED" && !["ISSUED", "ACCEPTED"].includes(q.status)) {
    throw refuse(409, "QUOTE_NOT_CURRENT", "تُسند العمولة على عرض صادر أو مقبول فقط.", "Only an issued or accepted quotation can be assigned.");
  }
  const repId = q.commissionRepId;
  if (decision === "ASSIGNED" && !repId) throw refuse(409, "NO_REP", "ما فيه مندوب مسجل لهذا العرض.", "No rep is recorded on this quotation.");
  const now = new Date();
  let opportunityId: string | null = null;
  if (decision === "ASSIGNED") {
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: q.customerId! }, select: { name: true, nameAr: true } });
    const stage = await requireStageFor(tx, "QUALIFICATION");
    const deal = await tx.opportunity.create({
      data: { title: `${customer.nameAr || customer.name} · عرض المحاسب ${q.quoteNumber}`, customerId: q.customerId, stageId: stage.id, outcome: "OPEN", amount: q.grandTotal.toString(), ownerId: repId! },
      select: { id: true },
    });
    opportunityId = deal.id;
    await tx.opportunityStageEvent.create({ data: { opportunityId: deal.id, toStageId: stage.id, toOutcome: "OPEN", reason: `Commission assigned on the accountant's quotation ${q.quoteNumber}: ${reason}`.slice(0, 500), actorId: input.actor.id } });
    await tx.quote.update({ where: { id: q.id }, data: { channel: "SALES", opportunityId: deal.id, commissionDecision: "ASSIGNED", commissionDecidedById: input.actor.id, commissionDecidedAt: now, commissionReason: reason } });
    await advanceToQuotationStage(tx, deal.id, input.actor.id);
    if (q.status === "ACCEPTED") await winOnAcceptedQuote(tx, deal.id, input.actor.id);
    // Its order (one per quotation, found by the number it carries) joins the deal as the normal flow links it.
    const order = await tx.order.findFirst({ where: { quotationNumber: q.quoteNumber }, select: { id: true } });
    if (order) {
      const requestKey = quoteRequestKey(q.id);
      const exists = await tx.opportunityOrder.findUnique({ where: { requestKey }, select: { id: true } });
      if (!exists) await tx.opportunityOrder.create({ data: { opportunityId: deal.id, quoteId: q.id, orderId: order.id, isFirstOrder: true, requestKey, createdById: input.actor.id } });
    }
  } else {
    await tx.quote.update({ where: { id: q.id }, data: { commissionDecision: "NONE", commissionDecidedById: input.actor.id, commissionDecidedAt: now, commissionReason: reason } });
  }
  await audit(tx, { action: decision === "ASSIGNED" ? "QUOTE_COMMISSION_ASSIGNED" : "QUOTE_COMMISSION_NONE", entityType: "Quote", entityId: q.id, actorId: input.actor.id, before: { commissionDecision: "PENDING", repId }, after: { commissionDecision: decision, reason, opportunityId } });
  const names = await namesOf(tx, { customerId: q.customerId, commissionRepId: repId }, q.createdById);
  const decider = await tx.employee.findUnique({ where: { id: input.actor.id }, select: { name: true } });
  await notifySplit(tx, "sales.accounting_quote_decided", {
    dedupeKey: `${q.id}:${decision}`, actorId: input.actor.id,
    facts: { quoteId: q.id, quoteNumber: q.quoteNumber, decision, reason, deciderName: decider?.name ?? "", ...names },
    people: { rep: repId, issuer: q.createdById, admins: await admins(tx) },
  }, q.id);
  return { decision, opportunityId };
}

/** The daily reminder: PENDING for 3+ Riyadh business days since issue — once per quotation per day. */
export async function accountingQuoteReminders(now: Date = new Date()) {
  const pending = await prisma.quote.findMany({ where: { commissionDecision: "PENDING", channel: "ACCOUNTING" }, select: HEAD, take: 500 });
  const today = riyadhDayText(now);
  let notified = 0, due = 0;
  for (const q of pending) {
    if (!q.issuedAt) continue;
    const days = businessDaysBetween(riyadhDayText(q.issuedAt), today);
    if (days < COMMISSION_REMINDER_BUSINESS_DAYS) continue;
    due++;
    const names = await namesOf(prisma, q, q.createdById);
    const r = await notifySplit(prisma, "sales.accounting_quote_reminder", {
      dedupeKey: `${q.id}:${today}`, actorId: null,
      facts: { quoteId: q.id, quoteNumber: q.quoteNumber, days, ...names },
      people: { admins: await admins(prisma) },
    }, q.id);
    notified += r.inserted;
  }
  return { due, notified };
}
