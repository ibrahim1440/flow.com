// P1 ERR-02 (owner decisions 1أ/2أ/3أ, 12 Nov 2026): the credit limit BLOCKS.
//
//   assertCreditLimit   — THE check, at creation / conversion only (never retroactive): a new order (POST /api/orders),
//                         a quotation turned into an order, a direct sale (at «أرسل», and again when a sale that waited
//                         for its discount approval completes). Refused 409 CREDIT_LIMIT when the customer has a limit
//                         and commitment (receivable + approved orders not invoiced, ./exposure.ts) + this order > the
//                         limit — the Arabic message carries the figures (limit, used, this order, excess). A customer
//                         with no limit is never blocked; a zero order (a sample) is exempt. The customer row is locked
//                         so two orders at once cannot both slip under the limit.
//   requestCreditOverride / decideCreditOverride — «اطلب اعتماد المشرف»: the rep asks for THIS order's amount with a
//                         reason; a holder of customers › sales_hold who is NOT the requester (CHECK too) approves with a
//                         documented reason, or refuses. The approval lets the requester's next order for the customer
//                         up to that amount through ONCE (consumed: USED, with the order) within 3 days. Audited
//                         (HrAuditLog) and notified, as the manual hold.
import type { Prisma } from "@/generated/prisma/client";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { Decimal } from "@/lib/accounting/money";
import { customerExposure, type Exposure } from "./exposure";

type Db = Prisma.TransactionClient;
export type CreditKind = "ORDER" | "QUOTE_ORDER" | "DIRECT_SALE";
type Actor = { id: string; name?: string | null; permissions: Permissions | Record<string, unknown> };
const audit = async (...a: Parameters<typeof import("@/lib/hr/core").audit>) => (await import("@/lib/hr/core")).audit(...a);
const db0 = async () => (await import("@/lib/db")).prisma;

export const OVERRIDE_DAYS = 3;
const KINDS: CreditKind[] = ["ORDER", "QUOTE_ORDER", "DIRECT_SALE"];

const refuse = (status: number, code: string, ar: string, en: string, extra: Record<string, unknown> = {}) =>
  ({ _appCode: status, code, message: ar, errorAr: ar, error: ar, errorEn: en, ...extra });

export const mayOverrideCredit = (p: Permissions | Record<string, unknown>) => hasSubPrivilege(p as Permissions, "customers", "sales_hold");

const money = (d: Decimal) => d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Abu Fahd (friction 13): the riyal sign on every figure of the on-screen refusal (the outbound texts keep «ر.س», D19 M1). */
const sar = (d: Decimal) => `${money(d)} ⃁`;

/** The refusal with its figures (pure; the screen shows them in the Figma 2033:28 sentence). */
export function creditLimitRefusal(e: Pick<Exposure, "receivable" | "approvedNotInvoiced" | "commitment" | "limit">, amount: Decimal) {
  const total = e.commitment.plus(amount);
  const excess = total.minus(e.limit!);
  // Gate R5 R1: a paid-ahead balance (negative receivable) reads «رصيد دائن (دفعات مقدّمة)», subtracted — never «عليه الحين -66.70».
  const credit = e.receivable.lessThan(0);
  const owedAr = credit ? `رصيد دائن (دفعات مقدّمة) ${sar(e.receivable.negated())} −` : `عليه الحين ${sar(e.receivable)} +`;
  const owedEn = credit ? `credit balance (paid ahead) ${money(e.receivable.negated())} −` : `owed ${money(e.receivable)} +`;
  const ar = credit
    ? `الطلب يتجاوز حد الائتمان: طلبات معتمدة ما انفوترت ${sar(e.approvedNotInvoiced)} + هذا الطلب ${sar(amount)} − ${owedAr.replace(/ −$/, "")} = ${sar(total)}، والحد ${sar(e.limit!)} — يتجاوزه بـ ${sar(excess)}. اطلب اعتماد المشرف، أو حصّل من العميل أول.`
    : `الطلب يتجاوز حد الائتمان: ${owedAr} طلبات معتمدة ما انفوترت ${sar(e.approvedNotInvoiced)} + هذا الطلب ${sar(amount)} = ${sar(total)}، والحد ${sar(e.limit!)} — يتجاوزه بـ ${sar(excess)}. اطلب اعتماد المشرف، أو حصّل من العميل أول.`;
  const en = credit
    ? `The order exceeds the credit limit: approved not invoiced ${money(e.approvedNotInvoiced)} + this order ${money(amount)} − ${owedEn.replace(/ −$/, "")} = ${money(total)}, limit ${money(e.limit!)} — over by ${money(excess)}. Ask a supervisor to approve, or collect first.`
    : `The order exceeds the credit limit: ${owedEn} approved not invoiced ${money(e.approvedNotInvoiced)} + this order ${money(amount)} = ${money(total)}, limit ${money(e.limit!)} — over by ${money(excess)}. Ask a supervisor to approve, or collect first.`;
  return refuse(409, "CREDIT_LIMIT", ar, en, {
    credit: { limit: e.limit!.toFixed(2), receivable: e.receivable.toFixed(2), approvedNotInvoiced: e.approvedNotInvoiced.toFixed(2), used: e.commitment.toFixed(2), order: amount.toFixed(2), total: total.toFixed(2), excess: excess.toFixed(2) },
  });
}

/**
 * Refuse an order that takes the customer over the limit — unless the requester holds an approved override for this
 * customer covering the amount (consumed here, in the caller's transaction, once the order id is known via `consume`).
 * Returns the override to consume (or null).
 */
export async function assertCreditLimit(db: Db, input: { customerId: string | null | undefined; amount: Decimal; actorId: string | null | undefined; kind: CreditKind; exceptOrderId?: string | null; now?: Date; quoteId?: string | null }): Promise<{ overrideId: string } | null> {
  const { customerId, amount } = input;
  if (!customerId || !amount.greaterThan(0)) return null; // no customer, or a zero order (a sample): exempt
  const now = input.now ?? new Date();
  const lim = await db.customer.findUnique({ where: { id: customerId }, select: { creditLimit: true } });
  if (!lim || lim.creditLimit == null) return null; // no limit: never blocked (as before)
  // Serialise the credit decisions of one customer (two orders at once cannot both pass under the limit).
  await db.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
  const e = (await customerExposure(db, [customerId], now, { exceptOrderId: input.exceptOrderId ?? null })).get(customerId)!;
  if (e.commitment.plus(amount).lessThanOrEqualTo(e.limit!)) return null;
  if (input.actorId) {
    // Gate R1 M2: an approval is used only on the path it was asked for (a direct sale's never by POST /api/orders).
    // Gate R6 G1: an approval bound to a target (its request's resume — a held order, a quotation) is used only there: a
    // held order's never here (only POST /api/orders/[id]/payment-hold of that order), a quotation's only by its own
    // conversion.
    const candidates = await db.creditLimitOverride.findMany({
      where: { customerId, requestedById: input.actorId, kind: input.kind, status: "APPROVED", amount: { gte: amount.toFixed(2) }, expiresAt: { gt: now } },
      orderBy: { decidedAt: "asc" }, select: { id: true }, take: 20,
    });
    for (const c of candidates) {
      const t = await overrideTarget(db, c.id);
      if (t.orderId) continue;
      if (t.quoteId && t.quoteId !== (input.quoteId ?? null)) continue;
      return { overrideId: c.id };
    }
  }
  // Gate R1 M5: the figures are the customer's — a viewer for whom the customer is not in their book (e.g. a rep taking
  // an order for an unassigned customer) is refused WITHOUT them.
  if (input.actorId && !(await actorSeesCustomer(db, input.actorId, customerId))) throw creditLimitRefusalBare();
  throw creditLimitRefusal(e, amount);
}

async function actorSeesCustomer(db: Db, actorId: string, customerId: string): Promise<boolean> {
  const emp = await db.employee.findUnique({ where: { id: actorId }, select: { id: true, role: true, permissions: true } });
  if (!emp) return false;
  const permissions = typeof emp.permissions === "string" ? JSON.parse(emp.permissions) : emp.permissions;
  const { customerFiguresVisible } = await import("@/lib/services/sales/customer-access");
  return customerFiguresVisible({ id: emp.id, role: emp.role, permissions } as never, customerId, db as never);
}

/** The refusal without the customer's figures (gate R1 M5). */
export function creditLimitRefusalBare() {
  return refuse(409, "CREDIT_LIMIT", "الطلب يتجاوز حد ائتمان العميل — كلّم مشرفك.", "The order exceeds the customer's credit limit — talk to your supervisor.");
}

/** Mark the approval used by the order (same transaction as the order). */
export async function consumeCreditOverride(db: Db, overrideId: string, orderId: string, actorId: string, now: Date = new Date()) {
  const n = await db.creditLimitOverride.updateMany({ where: { id: overrideId, status: "APPROVED" }, data: { status: "USED", usedOrderId: orderId, usedAt: now } });
  if (n.count !== 1) throw refuse(409, "CREDIT_OVERRIDE_USED", "اعتماد تجاوز الحد انستخدم من قبل — اطلب اعتماد جديد.", "The credit-limit approval was already used — ask for a new one.");
  const row = await db.creditLimitOverride.findUniqueOrThrow({ where: { id: overrideId }, select: { customerId: true, amount: true } });
  await audit(db, { action: "CREDIT_OVERRIDE_USED", entityType: "Customer", entityId: row.customerId, actorId, after: { overrideId, orderId, amount: row.amount.toString() } });
}

/** «اطلب اعتماد المشرف»: the rep asks to let THIS order (its amount) through. Refused when it is not over the limit. */
/**
 * Abu Fahd M1 / H2: the refused request, kept with the override so the rep resumes it with one tap once approved
 * (/dashboard/sales/credit-resume/[id]): the endpoint it went to (only the endpoints that refuse with CREDIT_LIMIT) and
 * its body (bounded). Re-sent as the rep, re-checked in full by that endpoint — nothing here is trusted.
 */
const RESUME_PATHS = [/^\/api\/sales\/direct-sale$/, /^\/api\/orders$/, /^\/api\/orders\/[A-Za-z0-9_-]{1,64}\/payment-hold$/, /^\/api\/sales\/quotes\/[A-Za-z0-9_-]{1,64}\/create-order$/];
export type CreditResume = { path: string; body: Record<string, unknown> | null };
export function parseResume(raw: unknown): CreditResume | null {
  const r = raw as { path?: unknown; body?: unknown } | null;
  if (!r || typeof r !== "object" || typeof r.path !== "string" || !RESUME_PATHS.some((re) => re.test(r.path as string))) return null;
  const body = r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body as Record<string, unknown> : null;
  if (body && JSON.stringify(body).length > 16_000) return null;
  return { path: r.path, body };
}

export async function requestCreditOverride(actor: Actor, input: { customerId: unknown; amount: unknown; kind: unknown; reason: unknown; resume?: unknown }) {
  const customerId = typeof input.customerId === "string" ? input.customerId : "";
  let kind = KINDS.includes(input.kind as CreditKind) ? (input.kind as CreditKind) : null;
  // Gate R5 B6: a request that names a resume is checked on the server (override-resume.ts) — its kind and amount come from
  // the resume (the held order's remaining, the quotation, the stored body priced here), never from the client.
  const resume = input.resume == null ? null : parseResume(input.resume);
  if (input.resume != null && !resume) throw refuse(409, "RESUME_INVALID", "الطلب المحفوظ غير صالح.", "The stored request is not valid.");
  if (resume && !kind) kind = "ORDER";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  let amount: Decimal;
  try { amount = new Decimal(String(input.amount ?? "")); } catch { amount = new Decimal(0); }
  if (!customerId || !kind) throw refuse(400, "BAD_INPUT", "بيانات الطلب ناقصة.", "The request is incomplete.");
  if (!resume && (!amount.isFinite() || !amount.greaterThan(0) || amount.greaterThan("100000000"))) throw refuse(400, "AMOUNT_INVALID", "مبلغ الطلب غير صحيح.", "The order amount is not valid.");
  if (reason.length < 5 || reason.length > 500) throw refuse(400, "REASON_REQUIRED", "اكتب سبب الطلب (5 أحرف على الأقل).", "Write the reason (at least 5 characters).", { field: "reason" });
  const prisma = await db0();
  return prisma.$transaction(async (tx) => {
    const { customerInScope } = await import("@/lib/services/sales/customer-access");
    if (!(await customerInScope(actor as never, customerId))) throw refuse(404, "NOT_FOUND", "العميل غير موجود.", "Customer not found.");
    const c = await tx.customer.findUnique({ where: { id: customerId }, select: { creditLimit: true, name: true, nameAr: true } });
    if (!c) throw refuse(404, "NOT_FOUND", "العميل غير موجود.", "Customer not found.");
    if (c.creditLimit == null) throw refuse(409, "NO_LIMIT", "العميل ما له حد ائتمان — ما يحتاج اعتماد.", "The customer has no credit limit — nothing to approve.");
    const e = (await customerExposure(tx, [customerId])).get(customerId)!;
    let commitment = e.commitment;
    if (resume) {
      const { checkResume } = await import("./override-resume");
      const r = await checkResume(tx as never, actor as never, customerId, resume);
      kind = r.kind;
      amount = new Decimal(r.amount.toFixed(2));
      // A held order is already in the commitment: its own position (never the order twice).
      if (r.commitment) commitment = new Decimal(r.commitment.toFixed(2));
    }
    if (!amount.greaterThan(0) || amount.greaterThan("100000000")) throw refuse(400, "AMOUNT_INVALID", "مبلغ الطلب غير صحيح.", "The order amount is not valid.");
    if (commitment.plus(amount).lessThanOrEqualTo(e.limit!)) throw refuse(409, "WITHIN_LIMIT", "الطلب داخل حد الائتمان — كمّل بدون اعتماد.", "The order is within the credit limit — go ahead without an approval.");
    const open = await tx.creditLimitOverride.findFirst({ where: { customerId, requestedById: actor.id, status: "PENDING" }, select: { id: true } });
    if (open) throw refuse(409, "ALREADY_PENDING", "عندك طلب اعتماد لهالعميل ينتظر المشرف.", "You already have a request for this customer waiting for a supervisor.", { requestId: open.id });
    const row = await tx.creditLimitOverride.create({
      data: { customerId, kind: kind!, amount: amount.toFixed(2), limitAt: e.limit!.toFixed(2), commitmentAt: commitment.toFixed(2), reason, requestedById: actor.id },
      select: { id: true },
    });
    await audit(tx, { action: "CREDIT_OVERRIDE_REQUESTED", entityType: "Customer", entityId: customerId, actorId: actor.id, after: { requestId: row.id, kind, amount: amount.toFixed(2), limit: e.limit!.toFixed(2), used: commitment.toFixed(2), reason, resume } as never });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, { event: "customers.credit_override_pending", dedupeKey: row.id, actorId: actor.id, entity: { type: "Customer", id: customerId }, facts: { customerName: c.nameAr || c.name, amount: amount.toFixed(2), reason } });
    return { id: row.id, status: "PENDING" as const };
  });
}

/** The supervisor's decision: APPROVE (a documented reason of 5+) or REJECT (a reason). Never the requester. */
export async function decideCreditOverride(actor: Actor, id: string, input: { decision: unknown; note: unknown }, now: Date = new Date()) {
  if (!mayOverrideCredit(actor.permissions)) throw refuse(403, "FORBIDDEN", "اعتماد تجاوز حد الائتمان للمشرف (إيقاف البيع).", "Approving a credit-limit override needs customers › sales_hold.");
  const decision = input.decision === "APPROVE" ? "APPROVED" : input.decision === "REJECT" ? "REJECTED" : null;
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (!decision) throw refuse(400, "BAD_INPUT", "القرار غير صحيح.", "Invalid decision.");
  if (note.length < 5 || note.length > 500) throw refuse(400, "REASON_REQUIRED", "اكتب سبب القرار (5 أحرف على الأقل).", "Write the reason for the decision (at least 5 characters).", { field: "note" });
  const prisma = await db0();
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CreditLimitOverride" WHERE "id" = ${id} FOR UPDATE`;
    if (!rows[0]) throw refuse(404, "NOT_FOUND", "الطلب غير موجود.", "Request not found.");
    const r = await tx.creditLimitOverride.findUniqueOrThrow({ where: { id } });
    if (r.status !== "PENDING") throw refuse(409, "DECIDED", "الطلب تقرر من قبل.", "The request was already decided.");
    if (r.requestedById === actor.id) throw refuse(403, "SELF_APPROVAL", "ما تقدر تعتمد طلبك أنت — يعتمده مشرف ثاني.", "You cannot decide your own request — another supervisor decides it.");
    // Gate R6 G1: a request for a HELD order is only about that order — once it is released (or cancelled) there is nothing
    // to approve: refused (the request lapses on its own — expireCreditOverrides).
    if (decision === "APPROVED") {
      const t = await overrideTarget(tx, id);
      if (t.orderId) {
        const o = await tx.order.findUnique({ where: { id: t.orderId }, select: { paymentHold: true, status: true } });
        if (!o || o.paymentHold !== "REJECTED" || o.status === "Cancelled") {
          throw refuse(409, "TARGET_RELEASED", "الطلب انفك — ما يحتاج اعتماد.", "The order was released — nothing to approve.");
        }
      }
    }
    await tx.creditLimitOverride.update({
      where: { id },
      data: { status: decision, decidedById: actor.id, decidedAt: now, decisionNote: note, ...(decision === "APPROVED" ? { expiresAt: new Date(now.getTime() + OVERRIDE_DAYS * 86_400_000) } : {}) },
    });
    await audit(tx, { action: decision === "APPROVED" ? "CREDIT_OVERRIDE_APPROVED" : "CREDIT_OVERRIDE_REJECTED", entityType: "Customer", entityId: r.customerId, actorId: actor.id, after: { requestId: id, amount: r.amount.toString(), kind: r.kind, reason: r.reason, note, requestedById: r.requestedById } });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, { event: "customers.credit_override_decided", dedupeKey: `${id}:${decision}`, actorId: actor.id, entity: { type: "Customer", id: r.customerId }, people: { requester: r.requestedById }, facts: { decision: decision === "APPROVED" ? "APPROVE" : "REJECT", note, amount: r.amount.toString(), customerId: r.customerId, requestId: id, resumable: decision === "APPROVED" && (await resumeOf(tx, id)) ? 1 : null } });
    return { id, status: decision };
  });
}

/** Gate R6 G1: what an override is bound to — the held order or the quotation its request's resume names (none: free). */
export async function overrideTarget(db: Db, requestId: string): Promise<{ orderId: string | null; quoteId: string | null }> {
  const r = await resumeOf(db, requestId);
  return {
    orderId: r?.path.match(/^\/api\/orders\/([^/]+)\/payment-hold$/)?.[1] ?? null,
    quoteId: r?.path.match(/^\/api\/sales\/quotes\/([^/]+)\/create-order$/)?.[1] ?? null,
  };
}

/**
 * Gate R7: «اسحب الطلب» — the requester withdraws their own PENDING request (notably one left open because they released
 * the held order themselves). WITHDRAWN: no decider (20261231130000_credit_override_withdrawn), the time in decidedAt;
 * audited CREDIT_OVERRIDE_WITHDRAWN; off the supervisor's inbox (it lists PENDING only). 404 for anyone else's request.
 */
export async function withdrawCreditOverride(actor: Actor, id: string, now: Date = new Date()) {
  const prisma = await db0();
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CreditLimitOverride" WHERE "id" = ${id} FOR UPDATE`;
    const r = rows[0] ? await tx.creditLimitOverride.findUnique({ where: { id }, select: { id: true, status: true, requestedById: true, customerId: true, amount: true, kind: true } }) : null;
    if (!r || r.requestedById !== actor.id) throw refuse(404, "NOT_FOUND", "الطلب غير موجود.", "Request not found.");
    if (r.status !== "PENDING") throw refuse(409, "NOT_PENDING", "الطلب ما عاد ينتظر — ما ينسحب.", "The request is no longer waiting — it cannot be withdrawn.");
    await tx.creditLimitOverride.update({ where: { id }, data: { status: "WITHDRAWN", decidedAt: now, decisionNote: "سحبه المندوب" } });
    await audit(tx, { action: "CREDIT_OVERRIDE_WITHDRAWN", entityType: "Customer", entityId: r.customerId, actorId: actor.id, after: { requestId: id, amount: r.amount.toString(), kind: r.kind } });
    return { id, status: "WITHDRAWN" as const };
  });
}

/** The request kept with an override (its CREDIT_OVERRIDE_REQUESTED audit), or null. */
export async function resumeOf(db: Db, requestId: string): Promise<CreditResume | null> {
  const a = await db.hrAuditLog.findFirst({ where: { action: "CREDIT_OVERRIDE_REQUESTED", after: { path: ["requestId"], equals: requestId } }, select: { after: true } });
  return parseResume((a?.after as { resume?: unknown } | null)?.resume ?? null);
}

/** Lapse approvals not used in time (read-side, no job): called by the screens that list them. */
export async function expireCreditOverrides(db: Db, now: Date = new Date()) {
  await db.creditLimitOverride.updateMany({ where: { status: "APPROVED", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
}
