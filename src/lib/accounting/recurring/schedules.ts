// «المعاملات المتكررة» (feat/recurring-journals, 20261120090000_recurring_journals) — the recurring transactions: list,
// read (with runs and the audit trail), save, pause / resume, cancel and the auto-post authorisation.
//
// What a run makes is FROZEN when the schedule is saved ("payload"): the journal lines of a template at its total, the
// lines of a copied journal, or the customer and lines of a copied sales invoice. Editing a template later does not
// change a schedule (re-save the schedule to take the new lines), and ANY edit of a schedule withdraws its auto-post
// authorisation — the authoriser approved those exact lines (council: a standing journal is approved as a whole).
//
// Auto-post (journals only): set by a holder of accounting › journal_post with a recent step-up (the route), recorded
// with who and when; under the SoD setting the authoriser is not the schedule's preparer (SOD_SELF_APPROVAL), as for
// a manual journal's approval. Invoices are always created as drafts: issuing (numbering, ZATCA signing, the entry) is
// a person's act.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "../audit";
import { refuse } from "../refusals";
import { AccountingError } from "../errors";
import { dayText, parseBusinessDay, riyadhDay, addDaysUtc } from "../dates";
import { Decimal, ZERO, roundMoney } from "../money";
import { sodDecision, sodPolicy } from "../sod";
import { postingRef } from "../posting-engine";
import { applyTemplate, type AppliedLine } from "./template-math";
import { applyRefusal, checkTemplateAccounts } from "./templates";
import { firstIndexOnOrAfter, occurrenceDate, parseRule, upcoming, type ScheduleRule } from "./schedule";
import { parseLines as parseInvoiceLines } from "@/lib/services/invoicing/pricing";
import { KINDS, SOURCE_TYPES, refText, type RecurringKind, type RecurringSourceType } from "./shared";

type Tx = Prisma.TransactionClient;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export type JournalPayload = { kind: "JOURNAL"; description: string; lines: AppliedLine[]; sourceLabel: string | null };
export type SalesLine = {
  description: string; descriptionEn: string | null; productSkuId: string | null; skuCode: string | null; quantity: string; unit: string;
  unitPrice: string; discountPercent: string; taxCategory: string; taxRatePercent: string; exemptionReasonCode: string | null; exemptionReason: string | null;
};
export type SalesPayload = {
  kind: "SALES_INVOICE"; customerId: string; customerName: string; family: string; paymentTermsDays: number | null; notes: string | null;
  lines: SalesLine[]; grandTotal: string; sourceNumber: string | null;
  /** The Riyadh day the prices were copied (each draft says «الأسعار من الجدول بتاريخ …»). */
  pricedAt: string;
};
export type Payload = JournalPayload | SalesPayload;

export type ScheduleInput = {
  name?: unknown; description?: unknown; kind?: unknown; sourceType?: unknown; templateId?: unknown; totalAmount?: unknown;
  sourceEntryId?: unknown; sourceInvoiceId?: unknown; frequency?: unknown; interval?: unknown; startDate?: unknown; endDate?: unknown;
  maxOccurrences?: unknown; expectedUpdatedAt?: unknown;
};

export const ruleOf = (s: { frequency: string; interval: number; startDate: Date; endDate: Date | null; maxOccurrences: number | null }): ScheduleRule => ({
  frequency: s.frequency as ScheduleRule["frequency"], interval: s.interval, startDate: dayText(s.startDate), endDate: s.endDate ? dayText(s.endDate) : null, maxOccurrences: s.maxOccurrences,
});

/** The journal a run makes, as manual-journal lines (validated by the journal service at run time). */
export const journalLines = (p: JournalPayload) => p.lines.map((l) => ({
  accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description ?? undefined,
  branchId: l.branchId, costCenterId: l.costCenterId, partyType: l.partyType, partyId: l.partyId,
}));

async function journalPayloadFrom(tx: Tx, kind: RecurringSourceType, input: ScheduleInput, name: string): Promise<{ payload: JournalPayload; templateId: string | null; sourceEntryId: string | null; total: Decimal | null }> {
  if (kind === "TEMPLATE") {
    const id = str(input.templateId, 64);
    if (!id) throw refuse("RECURRING_INVALID", "(templateId)", "(اختر القالب)");
    const t = await tx.journalTemplate.findUnique({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    if (!t) throw refuse("NOT_FOUND", "(template)", "(القالب)");
    if (!t.isActive) throw refuse("TEMPLATE_ARCHIVED");
    const tl = t.lines.map((l) => ({ accountId: l.accountId, side: l.side as "D" | "C", amount: l.amount?.toFixed(2) ?? null, percent: l.percent?.toFixed(4) ?? null, description: l.description, branchId: l.branchId, costCenterId: l.costCenterId, partyType: l.partyType, partyId: l.partyId }));
    let lines: AppliedLine[];
    try {
      lines = applyTemplate(t.amountMode as "FIXED" | "PERCENT", tl, typeof input.totalAmount === "string" || typeof input.totalAmount === "number" ? String(input.totalAmount) : null);
    } catch (e) {
      applyRefusal(e);
    }
    return { payload: { kind: "JOURNAL", description: t.description ?? name, lines, sourceLabel: t.name }, templateId: t.id, sourceEntryId: null, total: t.amountMode === "PERCENT" ? roundMoney(String(input.totalAmount)) : null };
  }
  const id = str(input.sourceEntryId, 64);
  if (!id) throw refuse("RECURRING_INVALID", "(sourceEntryId)", "(اختر القيد المنسوخ)");
  const e = await tx.journalEntry.findUnique({ where: { id }, include: { lines: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } } });
  if (!e) throw refuse("NOT_FOUND", "(journal)", "(القيد)");
  if (e.type !== "MANUAL") throw refuse("RECURRING_INVALID", "(only a manual journal is copied)", "(يُنسخ القيد اليدوي فقط)");
  const lines: AppliedLine[] = e.lines.map((l) => ({
    accountId: l.accountId, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2), description: l.description,
    branchId: l.branchId, costCenterId: l.costCenterId, partyType: l.partyType, partyId: l.partyId,
  }));
  const ref = postingRef(e) ?? `#${e.entryNo}`;
  return { payload: { kind: "JOURNAL", description: e.description ?? name, lines, sourceLabel: ref }, templateId: null, sourceEntryId: e.id, total: null };
}

async function salesPayloadFrom(tx: Tx, input: ScheduleInput): Promise<{ payload: SalesPayload; sourceInvoiceId: string }> {
  const id = str(input.sourceInvoiceId, 64);
  if (!id) throw refuse("RECURRING_INVALID", "(sourceInvoiceId)", "(اختر الفاتورة المنسوخة)");
  const inv = await tx.salesInvoice.findUnique({ where: { id }, include: { lines: { orderBy: [{ position: "asc" }, { id: "asc" }] } } });
  if (!inv) throw refuse("NOT_FOUND", "(sales invoice)", "(فاتورة المبيعات)");
  if (inv.kind !== "INVOICE") throw refuse("RECURRING_INVALID", "(a credit or debit note is not repeated)", "(لا يتكرر الإشعار الدائن أو المدين)");
  if (!inv.lines.length) throw refuse("RECURRING_INVALID", "(the invoice has no lines)", "(الفاتورة بلا بنود)");
  const customer = await tx.customer.findUnique({ where: { id: inv.customerId }, select: { name: true, nameAr: true } });
  if (!customer) throw refuse("NOT_FOUND", "(customer)", "(العميل)");
  const lines: SalesLine[] = inv.lines.map((l) => ({
    description: l.description, descriptionEn: l.descriptionEn, productSkuId: l.productSkuId, skuCode: l.skuCode, quantity: l.quantity.toFixed(3), unit: l.unit,
    unitPrice: l.unitPrice.toFixed(2), discountPercent: l.discountPercent.toFixed(2), taxCategory: l.taxCategory, taxRatePercent: l.taxRatePercent.toFixed(2),
    exemptionReasonCode: l.exemptionReasonCode, exemptionReason: l.exemptionReason,
  }));
  const { problems } = parseInvoiceLines(lines);
  if (problems.length) throw refuse("RECURRING_INVALID", `(${problems.map((p) => p.en).join("; ")})`, `(${problems.map((p) => p.ar).join("؛ ")})`);
  return {
    sourceInvoiceId: inv.id,
    payload: {
      kind: "SALES_INVOICE", customerId: inv.customerId, customerName: customer.nameAr ?? customer.name, family: inv.family, paymentTermsDays: inv.paymentTermsDays,
      notes: inv.notes, lines, grandTotal: new Decimal(inv.grandTotal.toString()).toFixed(2), sourceNumber: inv.number ?? null, pricedAt: dayText(riyadhDay()),
    },
  };
}

/** The journal payload is a valid manual journal on today's chart (balanced, manual accounts, dimensions). */
async function checkJournalPayload(tx: Tx, p: JournalPayload) {
  let d = ZERO, c = ZERO;
  for (const l of p.lines) { d = d.plus(l.debit); c = c.plus(l.credit); }
  if (p.lines.length < 2 || !d.equals(c) || d.isZero()) throw refuse("UNBALANCED");
  await checkTemplateAccounts(tx, p.lines.map((l) => ({ accountId: l.accountId, side: new Decimal(l.debit).isZero() ? "C" : "D", branchId: l.branchId, costCenterId: l.costCenterId, partyType: l.partyType, partyId: l.partyId })));
}

/** The next occurrence at / after `from` (index ≥ `minIndex`) → { nextIndex, nextRunDate, status }. */
function position(rule: ScheduleRule, fromDay: string, minIndex: number): { nextIndex: number; nextRunDate: Date | null; done: boolean } {
  const k = firstIndexOnOrAfter(rule, fromDay, minIndex);
  if (k === null) return { nextIndex: rule.maxOccurrences ?? minIndex, nextRunDate: null, done: true };
  return { nextIndex: k, nextRunDate: parseBusinessDay(occurrenceDate(rule, k)!), done: false };
}

/** Create (id null) or edit a recurring transaction. An edit withdraws auto-post; the next run is recomputed from the
 *  later of today and the day after the last run (no back-fill, no repeat of a date that already ran). */
export async function saveSchedule(input: ScheduleInput, id: string | null, ctx: AuditContext) {
  const name = str(input?.name, 120);
  if (!name) throw refuse("RECURRING_INVALID", "(name)", "(اكتب الاسم)");
  const description = str(input?.description, 500);
  const kind = (KINDS as readonly string[]).includes(String(input?.kind)) ? (input.kind as RecurringKind) : null;
  const sourceType = (SOURCE_TYPES as readonly string[]).includes(String(input?.sourceType)) ? (input.sourceType as RecurringSourceType) : null;
  if (!kind || !sourceType || (kind === "JOURNAL") !== (sourceType !== "SALES_INVOICE")) {
    throw refuse("RECURRING_INVALID", "(kind JOURNAL from TEMPLATE / JOURNAL, or SALES_INVOICE from SALES_INVOICE)", "(النوع والمصدر غير متوافقين)");
  }
  const { rule, problems } = parseRule(input as Record<string, unknown>);
  if (!rule) {
    const e = refuse("RECURRING_INVALID", `(${problems.map((p) => p.en).join("; ")})`, `(${problems.map((p) => p.ar).join("؛ ")})`);
    (e as AccountingError & { problems?: unknown }).problems = problems;
    throw e;
  }
  if (!occurrenceDate(rule, 0)) throw refuse("RECURRING_INVALID", "(the rule has no occurrence)", "(القاعدة لا تنتج أي تاريخ)");

  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    let payload: Payload, templateId: string | null = null, sourceEntryId: string | null = null, sourceInvoiceId: string | null = null, total: Decimal | null = null;
    if (kind === "JOURNAL") {
      const j = await journalPayloadFrom(tx, sourceType, input, name);
      await checkJournalPayload(tx, j.payload);
      ({ payload, templateId, sourceEntryId, total } = j);
    } else {
      const s = await salesPayloadFrom(tx, input);
      ({ payload, sourceInvoiceId } = s);
    }
    const today = dayText(riyadhDay());
    const data = {
      name, description, kind, sourceType, templateId, sourceEntryId, sourceInvoiceId, totalAmount: total, payload: payload as unknown as Prisma.InputJsonValue,
      frequency: rule.frequency, interval: rule.interval, startDate: parseBusinessDay(rule.startDate), endDate: rule.endDate ? parseBusinessDay(rule.endDate) : null,
      maxOccurrences: rule.maxOccurrences ?? null, updatedBy: ctx.actorId, autoPost: false, autoPostApprovedBy: null, autoPostApprovedAt: null, autoPostSodBypass: false,
    };
    if (!id) {
      // A new schedule starts at its first occurrence on / after the start date (a past start date is allowed: its past
      // occurrences are due on the first run — the form says so).
      const pos = position(rule, rule.startDate, 0);
      const created = await tx.recurringSchedule.create({
        data: { ...data, createdBy: ctx.actorId, nextIndex: pos.nextIndex, nextRunDate: pos.nextRunDate, status: pos.done ? "COMPLETED" : "ACTIVE" },
        select: { id: true },
      });
      return getSchedule(created.id, tx);
    }
    const cur = (await tx.$queryRaw<{ id: string; status: string; updatedAt: Date }[]>`SELECT "id", "status", "updatedAt" FROM "RecurringSchedule" WHERE "id" = ${id} FOR UPDATE`)[0];
    if (!cur) throw refuse("NOT_FOUND");
    if (cur.status === "COMPLETED" || cur.status === "CANCELLED") throw refuse("RECURRING_STATE");
    const expected = input.expectedUpdatedAt ? Date.parse(String(input.expectedUpdatedAt)) : NaN;
    if (!Number.isFinite(expected) || expected !== cur.updatedAt.getTime()) throw refuse("RECURRING_STALE");
    const last = await tx.recurringRun.findFirst({ where: { scheduleId: id }, orderBy: { dueDate: "desc" }, select: { dueDate: true } });
    const from = last ? [today, dayText(addDaysUtc(last.dueDate, 1))].sort()[1] : [today, rule.startDate].sort()[1];
    const pos = position(rule, from, 0);
    const status = pos.done ? "COMPLETED" : cur.status;
    await tx.recurringSchedule.update({
      where: { id },
      data: { ...data, nextIndex: pos.nextIndex, nextRunDate: pos.nextRunDate, status, ...(status === "COMPLETED" ? { pausedAt: null, pausedBy: null, pauseReason: null } : {}) },
    });
    return getSchedule(id, tx);
  }, TX_OPTS);
}

async function lockSchedule(tx: Tx, id: string) {
  const row = (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "RecurringSchedule" WHERE "id" = ${id} FOR UPDATE`)[0];
  if (!row) throw refuse("NOT_FOUND");
  return tx.recurringSchedule.findUniqueOrThrow({ where: { id } });
}

/** Pause («إيقاف مؤقت») or resume («استئناف»). A resume does not back-fill: the next run is the first occurrence on /
 *  after today (from the schedule's current position). */
export async function setPaused(id: string, paused: boolean, ctx: AuditContext, reason?: unknown) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const s = await lockSchedule(tx, id);
    if (paused) {
      if (s.status !== "ACTIVE") throw refuse("RECURRING_STATE");
      await tx.recurringSchedule.update({ where: { id }, data: { status: "PAUSED", pausedAt: new Date(), pausedBy: ctx.actorId, pauseReason: str(reason, 500), updatedBy: ctx.actorId } });
    } else {
      if (s.status !== "PAUSED") throw refuse("RECURRING_STATE");
      const pos = position(ruleOf(s), dayText(riyadhDay()), s.nextIndex);
      await tx.recurringSchedule.update({
        where: { id },
        data: { status: pos.done ? "COMPLETED" : "ACTIVE", nextIndex: pos.nextIndex, nextRunDate: pos.nextRunDate, pausedAt: null, pausedBy: null, pauseReason: null, updatedBy: ctx.actorId },
      });
    }
    return getSchedule(id, tx);
  }, TX_OPTS);
}

/** Cancel: no further runs; the schedule and its history stay (never deleted). */
export async function cancelSchedule(id: string, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const s = await lockSchedule(tx, id);
    if (s.status === "COMPLETED" || s.status === "CANCELLED") throw refuse("RECURRING_STATE");
    await tx.recurringSchedule.update({ where: { id }, data: { status: "CANCELLED", nextRunDate: null, pausedAt: null, pausedBy: null, pauseReason: null, autoPost: false, autoPostSodBypass: false, updatedBy: ctx.actorId } });
    return getSchedule(id, tx);
  }, TX_OPTS);
}

/** Authorise (or withdraw) auto-post of a recurring JOURNAL. The route has checked journal_post + step-up. */
export async function setAutoPost(id: string, on: boolean, ctx: AuditContext, expectedUpdatedAt?: unknown) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const s = await lockSchedule(tx, id);
    if (s.kind !== "JOURNAL") throw refuse("AUTO_POST_JOURNALS_ONLY");
    if (s.status === "COMPLETED" || s.status === "CANCELLED") throw refuse("RECURRING_STATE");
    const expected = expectedUpdatedAt ? Date.parse(String(expectedUpdatedAt)) : NaN;
    if (Number.isFinite(expected) && expected !== s.updatedAt.getTime()) throw refuse("RECURRING_STALE");
    if (on) {
      // Authorising a standing journal is approving it and posting it in one act (council F1): the SoD setting's two
      // rules both apply — the preparer authorises it only when self-approval is allowed (recorded as autoPostSodBypass,
      // carried to every journal it posts), and only when the approver may post.
      const policy = await sodPolicy(tx);
      const self = s.createdBy === ctx.actorId || s.updatedBy === ctx.actorId;
      if (self && !sodDecision(policy, "SELF_APPROVAL")) throw refuse("SOD_SELF_APPROVAL");
      if (!sodDecision(policy, "APPROVER_POSTS")) throw refuse("SOD_APPROVER_POSTS");
      await tx.recurringSchedule.update({ where: { id }, data: { autoPost: true, autoPostApprovedBy: ctx.actorId, autoPostApprovedAt: new Date(), autoPostSodBypass: self } });
    } else {
      await tx.recurringSchedule.update({ where: { id }, data: { autoPost: false, autoPostApprovedBy: null, autoPostApprovedAt: null, autoPostSodBypass: false, updatedBy: ctx.actorId } });
    }
    return getSchedule(id, tx);
  }, TX_OPTS);
}

type Row = Prisma.RecurringScheduleGetPayload<{ include: { template: { select: { id: true; name: true; isActive: true } } } }>;

function payloadTotal(p: Payload): string {
  if (p.kind === "SALES_INVOICE") return p.grandTotal;
  return p.lines.reduce((s, l) => s.plus(l.debit), ZERO).toFixed(2);
}

/** The API shape of a schedule (dates as YYYY-MM-DD). */
export function scheduleView(s: Row) {
  const p = s.payload as unknown as Payload;
  return {
    id: s.id, ref: refText(s.refNo), refNo: s.refNo, name: s.name, description: s.description, kind: s.kind as RecurringKind, sourceType: s.sourceType as RecurringSourceType,
    templateId: s.templateId, template: s.template, sourceEntryId: s.sourceEntryId, sourceInvoiceId: s.sourceInvoiceId,
    totalAmount: s.totalAmount ? s.totalAmount.toFixed(2) : null, amount: payloadTotal(p), payload: p,
    frequency: s.frequency, interval: s.interval, startDate: dayText(s.startDate), endDate: s.endDate ? dayText(s.endDate) : null, maxOccurrences: s.maxOccurrences,
    nextIndex: s.nextIndex, nextRunDate: s.nextRunDate ? dayText(s.nextRunDate) : null, status: s.status, autoPost: s.autoPost,
    autoPostApprovedBy: s.autoPostApprovedBy, autoPostApprovedAt: s.autoPostApprovedAt, autoPostSodBypass: s.autoPostSodBypass, pausedAt: s.pausedAt, pausedBy: s.pausedBy, pauseReason: s.pauseReason, lastRunAt: s.lastRunAt,
    createdBy: s.createdBy, updatedBy: s.updatedBy, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}
export type ScheduleView = ReturnType<typeof scheduleView>;

/** FAILED runs still waiting for «إعادة المحاولة» (a cancelled transaction's are not counted): the total and per schedule. */
export async function failedRunCounts(db: Tx | typeof prisma = prisma): Promise<{ total: number; bySchedule: Map<string, number> }> {
  const g = await db.recurringRun.groupBy({ by: ["scheduleId"], where: { status: "FAILED", schedule: { status: { not: "CANCELLED" } } }, _count: { _all: true } });
  const bySchedule = new Map(g.map((x) => [x.scheduleId, x._count._all]));
  return { total: g.reduce((t, x) => t + x._count._all, 0), bySchedule };
}

const INCLUDE = { template: { select: { id: true, name: true, isActive: true } } } as const;

export async function listSchedules(q: { kind?: string | null; status?: string | null; take?: number; skip?: number; text?: string | null } = {}) {
  const where: Prisma.RecurringScheduleWhereInput = {};
  if (q.kind && (KINDS as readonly string[]).includes(q.kind)) where.kind = q.kind;
  if (q.status) where.status = { in: q.status.split(",").filter((x) => ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"].includes(x)) };
  const text = (q.text ?? "").trim().slice(0, 80);
  if (text) {
    const n = Number(text.replace(/^REC-?/i, ""));
    where.OR = [{ name: { contains: text, mode: "insensitive" } }, ...(Number.isInteger(n) && n > 0 ? [{ refNo: n }] : [])];
  }
  const take = Math.min(Math.max(q.take ?? 25, 1), 200), skip = Math.max(q.skip ?? 0, 0);
  const [rows, total, byKind, due, failedRuns] = await Promise.all([
    prisma.recurringSchedule.findMany({ where, include: INCLUDE, orderBy: [{ createdAt: "desc" }], take, skip }),
    prisma.recurringSchedule.count({ where }),
    prisma.recurringSchedule.groupBy({ by: ["kind"], _count: { _all: true } }),
    prisma.recurringSchedule.count({ where: { status: "ACTIVE", nextRunDate: { lte: riyadhDay() } } }),
    failedRunCounts(),
  ]);
  return {
    items: rows.map((r) => ({ ...scheduleView(r), failedRuns: failedRuns.bySchedule.get(r.id) ?? 0 })), total, take, skip,
    byKind: Object.fromEntries(byKind.map((b) => [b.kind, b._count._all])), dueNow: due, failedRuns: failedRuns.total,
  };
}

/** One schedule with its next dates, its runs (with links) and its audit trail. */
export async function getSchedule(id: string, db: Tx | typeof prisma = prisma) {
  const s = await db.recurringSchedule.findUnique({ where: { id }, include: INCLUDE });
  if (!s) throw refuse("NOT_FOUND");
  const runs = await db.recurringRun.findMany({ where: { scheduleId: id }, orderBy: { dueDate: "desc" }, take: 200 });
  const jeIds = runs.map((r) => r.journalEntryId).filter((x): x is string => !!x);
  const invIds = runs.map((r) => r.salesInvoiceId).filter((x): x is string => !!x);
  const [jes, invs, audit] = await Promise.all([
    jeIds.length ? db.journalEntry.findMany({ where: { id: { in: jeIds } }, select: { id: true, entryNo: true, postingYear: true, postingSeq: true, status: true } }) : [],
    invIds.length ? db.salesInvoice.findMany({ where: { id: { in: invIds } }, select: { id: true, number: true, status: true } }) : [],
    db.accountingAuditLog.findMany({
      where: { OR: [{ entityType: "RecurringSchedule", entityId: id }, ...(runs.length ? [{ entityType: "RecurringRun", entityId: { in: runs.map((r) => r.id) } }] : [])] },
      orderBy: { at: "desc" }, take: 100, select: { id: true, at: true, actorId: true, action: true, entityType: true, entityId: true, reason: true, before: true, after: true },
    }),
  ]);
  const je = new Map(jes.map((j) => [j.id, j])), inv = new Map(invs.map((i) => [i.id, i]));
  const view = scheduleView(s);
  const rule = ruleOf(s);
  return {
    ...view,
    upcoming: s.status === "ACTIVE" || s.status === "PAUSED" ? upcoming(rule, s.nextIndex, 5) : [],
    runs: runs.map((r) => {
      const j = r.journalEntryId ? je.get(r.journalEntryId) : null, i = r.salesInvoiceId ? inv.get(r.salesInvoiceId) : null;
      return {
        id: r.id, occurrenceIndex: r.occurrenceIndex, dueDate: dayText(r.dueDate), status: r.status, skipReason: r.skipReason, errorCode: r.errorCode, errorMessage: r.errorMessage,
        attempts: r.attempts, trigger: r.trigger, actorId: r.actorId, createdAt: r.createdAt, updatedAt: r.updatedAt,
        autoPost: r.autoPost, autoPostBy: r.autoPostBy, autoPostSodBypass: r.autoPostSodBypass,
        document: j ? { type: "JOURNAL", id: j.id, ref: postingRef(j) ?? `#${j.entryNo}`, status: j.status, href: `/dashboard/accounting/journals/${j.id}` }
          : i ? { type: "SALES_INVOICE", id: i.id, ref: i.number ?? null, status: i.status, href: `/dashboard/sales/invoices/${i.id}` } : null,
      };
    }),
    audit: audit.map((a) => ({ id: a.id, at: a.at, actorId: a.actorId, action: a.action, entityType: a.entityType, entityId: a.entityId, reason: a.reason, changed: changedKeys(a.before, a.after) })),
  };
}
export type ScheduleDetail = Awaited<ReturnType<typeof getSchedule>>;

const NOISE = new Set(["updatedAt", "createdAt", "id", "tenantId"]);
function changedKeys(b: unknown, a: unknown): string[] {
  const before = (b && typeof b === "object" ? b : {}) as Record<string, unknown>, after = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !NOISE.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k])).slice(0, 12);
}
