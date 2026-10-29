// «قوالب التأجيل» (feat/budgets-deferrals, 20261122090000_budgets_deferrals) — prepaid expenses and deferred revenue
// recognised over N months.
//
//   Template  kind PREPAID_EXPENSE | DEFERRED_REVENUE, months (1–120), start rule (./deferral-math), the balance-sheet
//             account (NULL = the PREPAID_EXPENSES / DEFERRED_REVENUE role's account) and the P&L account (an expense for
//             a prepaid expense, a revenue for a deferred revenue). Editing a template changes later schedules only.
//   Schedule  made from a template + an amount + a start date, by hand («إنشاء جدول») or from a posted journal line, a
//             purchase invoice line or a sales invoice line (linked; at most that line's amount across its live
//             schedules; a journal line must sit on the schedule's balance-sheet account). It copies the template and
//             writes its lines (halalas, remainder in the last month). Nothing posts when it is made: the amount is
//             already on the balance-sheet account (the invoice / journal put it there).
//   Run       runDeferralRecognition({ month }) — the month's PENDING lines of ACTIVE schedules, ONE balanced entry through
//             the posting engine on the month's last day:
//                 prepaid expense   Dr P&L expense      / Cr prepaid (balance-sheet)
//                 deferred revenue  Dr deferred revenue / Cr P&L revenue
//             (one pair of lines per schedule, with its branch / cost centre). A closed or soft-closed period is refused
//             by the engine (nothing is recorded). Idempotent per (schedule, month): a recognised line is never picked
//             again (deferral_line_guard), so a second run of the month finds nothing due (status NOTHING_DUE) — a
//             retry is safe, and a schedule made later in the month is picked by the next run of that month. Before
//             go-live / while accounting is off: the run is recorded SKIPPED with no entry (the existing pattern).
//   Reverse   reverseDeferralRun(runId, reason) — the run's entry reversed through the engine ON ITS OWN DATE (so the
//             month is restated; a closed month is refused), the run REVERSED and its lines PENDING again.
//   The recurring-transactions builder schedules runDueDeferralRecognition() (every due month up to a day, oldest first);
//   the contract is in the Qoyod program's APIS.md.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { Decimal, ZERO, fix2, toDecimal } from "./money";
import { dayText, parseBusinessDay, riyadhDay } from "./dates";
import { refuse } from "./refusals";
import { setAuditContext, type AuditContext } from "./audit";
import { postEntry, reverseEntry, resolveRoles, postingRef } from "./posting-engine";
import { roleDef } from "./roles";
import { lockLineCapacity } from "./purchase-line-capacity";
import { netByAccount } from "./statements";
import { DEFERRAL_KINDS, START_RULES, MAX_DEFERRAL_MONTHS, deferralSplit, monthEnd, monthStart, monthKey, runEntryLines, type DeferralKind, type StartRule } from "./deferral-math";
export { runEntryLines };

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export const DEFERRAL_SOURCES = ["MANUAL", "JOURNAL_LINE", "SUPPLIER_INVOICE_LINE", "SALES_INVOICE_LINE"] as const;
export type DeferralSource = (typeof DEFERRAL_SOURCES)[number];
/** The posting role of each kind's balance-sheet side. */
export const KIND_ROLE: Record<DeferralKind, "PREPAID_EXPENSES" | "DEFERRED_REVENUE"> = { PREPAID_EXPENSE: "PREPAID_EXPENSES", DEFERRED_REVENUE: "DEFERRED_REVENUE" };
const KIND_TYPES: Record<DeferralKind, { balance: string; pl: string }> = { PREPAID_EXPENSE: { balance: "ASSET", pl: "EXPENSE" }, DEFERRED_REVENUE: { balance: "LIABILITY", pl: "REVENUE" } };

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const isKind = (v: unknown): v is DeferralKind => typeof v === "string" && (DEFERRAL_KINDS as readonly string[]).includes(v);
const isRule = (v: unknown): v is StartRule => typeof v === "string" && (START_RULES as readonly string[]).includes(v);

function monthsOf(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DEFERRAL_MONTHS) throw refuse("BAD_INPUT", `months is 1–${MAX_DEFERRAL_MONTHS}.`, `عدد الأشهر من 1 إلى ${MAX_DEFERRAL_MONTHS}.`);
  return n;
}

/** "YYYY-MM" (or a YYYY-MM-DD in it) → the month's first day. */
export function parseMonth(v: unknown): Date {
  const t = typeof v === "string" ? v.trim() : "";
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(t);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[1]) < 2000 || Number(m[1]) > 2200) throw refuse("BAD_INPUT", "month is YYYY-MM.", "الشهر بصيغة YYYY-MM.");
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
}

async function accountFor(db: Db, id: unknown, type: string, what: string) {
  const accountId = typeof id === "string" ? id : "";
  const a = accountId ? await db.account.findUnique({ where: { id: accountId }, select: { id: true, code: true, type: true, isActive: true, allowPosting: true, _count: { select: { children: true } } } }) : null;
  if (!a || !a.isActive || !a.allowPosting || a._count.children > 0) throw refuse("ACCOUNT_NOT_POSTABLE", `(${what})`, `(${what})`);
  if (String(a.type) !== type) throw refuse("DEFERRAL_ACCOUNT_TYPE", `(${what}: ${a.code} is ${String(a.type)}, not ${type})`, `(${what}: ${a.code})`);
  return a.id;
}

// ── templates ─────────────────────────────────────────────────────────────────────────────────────────────────────

const TEMPLATE_SELECT = {
  id: true, nameAr: true, nameEn: true, kind: true, months: true, startRule: true, balanceAccountId: true, plAccountId: true, isActive: true, createdBy: true, createdAt: true, updatedAt: true,
  balanceAccount: { select: { id: true, code: true, nameAr: true, nameEn: true } }, plAccount: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  _count: { select: { schedules: true } },
} satisfies Prisma.DeferralTemplateSelect;

export async function listTemplates(q: { active?: boolean } = {}) {
  const rows = await prisma.deferralTemplate.findMany({ where: q.active ? { isActive: true } : {}, orderBy: [{ isActive: "desc" }, { nameAr: "asc" }], select: TEMPLATE_SELECT });
  const roles = await prisma.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: ["PREPAID_EXPENSES", "DEFERRED_REVENUE"] } }, select: { role: true, account: { select: { id: true, code: true, nameAr: true, nameEn: true } } } });
  const roleAcc = new Map(roles.map((r) => [r.role, r.account]));
  return {
    templates: rows.map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), schedules: t._count.schedules, _count: undefined, balanceAccount: t.balanceAccount ?? roleAcc.get(KIND_ROLE[t.kind as DeferralKind]) ?? null, balanceFromRole: !t.balanceAccountId })),
    roles: { PREPAID_EXPENSES: roleAcc.get("PREPAID_EXPENSES") ?? null, DEFERRED_REVENUE: roleAcc.get("DEFERRED_REVENUE") ?? null },
  };
}

type TemplateInput = { nameAr?: unknown; nameEn?: unknown; kind?: unknown; months?: unknown; startRule?: unknown; balanceAccountId?: unknown; plAccountId?: unknown; isActive?: unknown };

export async function createTemplate(input: TemplateInput, ctx: AuditContext) {
  const nameAr = str(input.nameAr, 120);
  if (!nameAr) throw refuse("BAD_INPUT", "nameAr.", "اسم القالب مطلوب.");
  if (!isKind(input.kind)) throw refuse("BAD_INPUT", "kind is PREPAID_EXPENSE | DEFERRED_REVENUE.");
  const kind = input.kind;
  const months = monthsOf(input.months);
  const startRule = input.startRule === undefined ? "START_MONTH" : input.startRule;
  if (!isRule(startRule)) throw refuse("BAD_INPUT", "startRule is START_MONTH | NEXT_MONTH | DAILY_PRORATA.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const plAccountId = await accountFor(tx, input.plAccountId, KIND_TYPES[kind].pl, kind === "PREPAID_EXPENSE" ? "expense account" : "revenue account");
    const balanceAccountId = input.balanceAccountId ? await accountFor(tx, input.balanceAccountId, KIND_TYPES[kind].balance, "balance-sheet account") : null;
    if (!balanceAccountId) await resolveRoles(tx, [KIND_ROLE[kind]]); // the role's account must exist to fall back to it
    const t = await tx.deferralTemplate.create({ data: { nameAr, nameEn: str(input.nameEn, 120), kind, months, startRule, balanceAccountId, plAccountId, createdBy: ctx.actorId, updatedBy: ctx.actorId }, select: { id: true } });
    return tx.deferralTemplate.findUniqueOrThrow({ where: { id: t.id }, select: TEMPLATE_SELECT });
  }, TX_OPTS);
}

/** Edit a template (later schedules only) or (de)activate it. Its kind never changes. */
export async function updateTemplate(id: string, input: TemplateInput, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const t = await tx.deferralTemplate.findUnique({ where: { id }, select: { kind: true } });
    if (!t) throw refuse("NOT_FOUND");
    const kind = t.kind as DeferralKind;
    if (input.kind !== undefined && input.kind !== kind) throw refuse("BAD_INPUT", "A template keeps its kind.", "نوع القالب لا يتغير.");
    const data: Prisma.DeferralTemplateUncheckedUpdateInput = { updatedBy: ctx.actorId };
    if (input.nameAr !== undefined) { const n = str(input.nameAr, 120); if (!n) throw refuse("BAD_INPUT", "nameAr."); data.nameAr = n; }
    if (input.nameEn !== undefined) data.nameEn = str(input.nameEn, 120);
    if (input.months !== undefined) data.months = monthsOf(input.months);
    if (input.startRule !== undefined) { if (!isRule(input.startRule)) throw refuse("BAD_INPUT", "startRule."); data.startRule = input.startRule; }
    if (input.plAccountId !== undefined) data.plAccountId = await accountFor(tx, input.plAccountId, KIND_TYPES[kind].pl, "P&L account");
    if (input.balanceAccountId !== undefined) data.balanceAccountId = input.balanceAccountId ? await accountFor(tx, input.balanceAccountId, KIND_TYPES[kind].balance, "balance-sheet account") : null;
    if (input.isActive !== undefined) { if (typeof input.isActive !== "boolean") throw refuse("BAD_INPUT", "isActive."); data.isActive = input.isActive; }
    await tx.deferralTemplate.update({ where: { id }, data });
    return tx.deferralTemplate.findUniqueOrThrow({ where: { id }, select: TEMPLATE_SELECT });
  }, TX_OPTS);
}

// ── schedules ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function nextScheduleNumber(tx: Tx, on: Date): Promise<string> {
  const y = on.getUTCFullYear();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`deferral:number:${y}`}, 0))`;
  const rows = await tx.$queryRaw<{ n: string | null }[]>`SELECT max("number") AS n FROM "DeferralSchedule" WHERE "number" LIKE ${`DEF-${y}-%`}`;
  const last = rows[0]?.n ? Number(rows[0].n.slice(-6)) : 0;
  return `DEF-${y}-${String(last + 1).padStart(6, "0")}`;
}

/**
 * A linked source line (council F1): it exists, and its amount covers every live schedule made from it. Returns where the
 * amount sits today — a journal line ON the balance-sheet account (no entry), or an invoice line booked to P&L: the
 * purchase line's expense-category account (an EXPENSE line of a POSTED invoice, prepaid only) or the sales revenue
 * account (a line of an ISSUED tax invoice, deferred revenue only) — which the schedule's reclass entry moves.
 */
async function checkSource(tx: Tx, type: DeferralSource, id: string | null, total: Decimal, balanceAccountId: string, kind: DeferralKind): Promise<{ reclassFrom: string | null }> {
  if (type === "MANUAL") return { reclassFrom: null };
  if (!id) throw refuse("BAD_INPUT", "sourceId.");
  let cap: Decimal, reclassFrom: string | null = null;
  if (type === "JOURNAL_LINE") {
    const l = await tx.journalEntryLine.findUnique({ where: { id }, select: { accountId: true, debit: true, credit: true, journalEntry: { select: { status: true } } } });
    if (!l || !["POSTED", "REVERSED"].includes(String(l.journalEntry.status))) throw refuse("DEFERRAL_SOURCE", "(journal line not found or not posted)", "(سطر القيد غير موجود أو غير مرحّل)");
    if (String(l.journalEntry.status) === "REVERSED") throw refuse("DEFERRAL_SOURCE", "(its entry is reversed)", "(قيده معكوس)");
    if (l.accountId !== balanceAccountId) throw refuse("DEFERRAL_SOURCE", "(the journal line is not on the schedule's balance-sheet account)", "(سطر القيد ليس على حساب الميزانية الخاص بالجدول)");
    cap = new Decimal(l.debit).plus(l.credit);
  } else if (type === "SUPPLIER_INVOICE_LINE") {
    if (kind !== "PREPAID_EXPENSE") throw refuse("DEFERRAL_SOURCE", "(a purchase line makes a prepaid expense)", "(سطر المشتريات يُنشئ مصروفًا مدفوعًا مقدماً)");
    // One capacity per purchase line, shared with «الأصول الثابتة» (council F1), under the line's row lock — the same
    // lock the fixed-asset register takes; no separate advisory lock for this source.
    const c = await lockLineCapacity(tx, id);
    const l = c?.line;
    if (!c || !l) throw refuse("DEFERRAL_SOURCE", "(purchase invoice line not found)", "(سطر فاتورة المشتريات غير موجود)");
    if (l.kind !== "EXPENSE" || !l.expenseCategory || String(l.invoice.status) !== "POSTED") throw refuse("DEFERRAL_SOURCE", "(an expense line of a posted purchase invoice)", "(سطر مصروف من فاتورة مشتريات مرحّلة)");
    if (total.greaterThan(c.remaining)) {
      throw refuse("DEFERRAL_SOURCE", `(more than the line's remaining ${c.remaining.toFixed(2)} of ${c.capacity.toFixed(2)}: fixed assets ${c.used.fixedAssets.toFixed(2)}, deferrals ${c.used.deferrals.toFixed(2)})`,
        `(أكثر من المتبقي في السطر ${c.remaining.toFixed(2)} من ${c.capacity.toFixed(2)}: مستخدم في أصل ثابت ${c.used.fixedAssets.toFixed(2)}، تأجيل ${c.used.deferrals.toFixed(2)})`);
    }
    return { reclassFrom: l.expenseCategory.accountId };
  } else {
    if (kind !== "DEFERRED_REVENUE") throw refuse("DEFERRAL_SOURCE", "(a sales line makes a deferred revenue)", "(سطر المبيعات يُنشئ إيرادًا مؤجلًا)");
    const l = await tx.salesInvoiceLine.findUnique({ where: { id }, select: { lineNet: true, invoice: { select: { status: true, kind: true } } } });
    if (!l) throw refuse("DEFERRAL_SOURCE", "(sales invoice line not found)", "(سطر فاتورة المبيعات غير موجود)");
    if (String(l.invoice.status) !== "ISSUED" || String(l.invoice.kind) !== "INVOICE") throw refuse("DEFERRAL_SOURCE", "(a line of an issued tax invoice)", "(سطر من فاتورة ضريبية صادرة)");
    cap = new Decimal(l.lineNet);
    reclassFrom = (await resolveRoles(tx, ["SALES_REVENUE"])).get("SALES_REVENUE")!;
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`deferral:source:${type}:${id}`}, 0))`;
  const used = await tx.deferralSchedule.aggregate({ where: { sourceType: type, sourceId: id, status: { not: "CANCELLED" } }, _sum: { totalAmount: true } });
  if (new Decimal(used._sum.totalAmount ?? 0).plus(total).greaterThan(cap)) throw refuse("DEFERRAL_SOURCE", `(more than the line's ${cap.toFixed(2)})`, `(أكثر من مبلغ السطر ${cap.toFixed(2)})`);
  return { reclassFrom };
}

type ScheduleInput = { templateId?: unknown; amount?: unknown; startDate?: unknown; description?: unknown; sourceType?: unknown; sourceId?: unknown; branchId?: unknown; costCenterId?: unknown; initialMode?: unknown; reclassAccountId?: unknown; plAccountId?: unknown };

/** The lines a schedule would get (the screen's preview; no write). */
export async function previewSchedule(input: ScheduleInput) {
  const t = typeof input.templateId === "string" ? await prisma.deferralTemplate.findUnique({ where: { id: input.templateId }, select: { months: true, startRule: true } }) : null;
  if (!t) throw refuse("NOT_FOUND", "(template)");
  const start = (() => { try { return parseBusinessDay(String(input.startDate ?? "")); } catch { throw refuse("BAD_INPUT", "startDate is YYYY-MM-DD."); } })();
  try {
    return deferralSplit(String(input.amount ?? ""), t.months, start, t.startRule as StartRule).map((l) => ({ ...l, periodStart: dayText(l.periodStart) }));
  } catch (e) {
    throw refuse("DEFERRAL_AMOUNT", `(${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Pure: the entry moving a schedule's amount between the balance-sheet account and another account (reclass / cancel). */
export function moveLines(kind: string, toBalance: boolean, amount: Decimal, balanceAccountId: string, otherAccountId: string, memo: string, dims: { branchId: string | null; costCenterId: string | null }) {
  const amt = amount.toFixed(2);
  // prepaid: the balance side is a debit when the amount moves IN; deferred revenue: a credit.
  const balanceDebit = (kind === "PREPAID_EXPENSE") === toBalance;
  return [
    { accountId: balanceAccountId, [balanceDebit ? "debit" : "credit"]: amt, description: memo, dims },
    { accountId: otherAccountId, [balanceDebit ? "credit" : "debit"]: amt, description: memo, dims },
  ];
}

/**
 * Does creating this schedule write the GL? Its initial RECLASS entry does (an invoice-line source always; a manual
 * schedule when «أعد التصنيف» is chosen) — the route then also asks for accounting › journal_post through the central
 * gate (the uniform register model). ON_ACCOUNT posts nothing.
 */
export function schedulePosts(input: Pick<ScheduleInput, "sourceType" | "initialMode">): boolean {
  const t = input.sourceType ?? "MANUAL";
  return t === "SUPPLIER_INVOICE_LINE" || t === "SALES_INVOICE_LINE" || (t === "MANUAL" && input.initialMode === "RECLASS");
}

/**
 * «إنشاء جدول تأجيل»: the schedule and its lines, from an active template, an amount and a start date. Council F1: where
 * the amount sits decides the entry — ON_ACCOUNT (already on the balance-sheet account: a journal-line source, or by
 * hand) posts nothing; RECLASS (booked to P&L: an invoice-line source, or by hand «أعد التصنيف من حساب …») posts ONE
 * reclass entry for the total at the start date (prepaid Dr balance / Cr that account; deferred Dr that account / Cr
 * balance), so the expense / revenue is never counted twice. Before go-live the reclass is SKIPPED (the opening covers it).
 */
export async function createSchedule(input: ScheduleInput, ctx: AuditContext) {
  const description = str(input.description, 300);
  if (!description) throw refuse("BAD_INPUT", "description.", "الوصف مطلوب.");
  let start: Date;
  try { start = parseBusinessDay(String(input.startDate ?? "")); } catch { throw refuse("BAD_INPUT", "startDate is YYYY-MM-DD.", "تاريخ البدء بصيغة YYYY-MM-DD."); }
  const sourceType = (input.sourceType ?? "MANUAL") as DeferralSource;
  if (!(DEFERRAL_SOURCES as readonly string[]).includes(sourceType)) throw refuse("BAD_INPUT", "sourceType.");
  const sourceId = sourceType === "MANUAL" ? null : str(input.sourceId, 64);
  const askedMode = input.initialMode === undefined || input.initialMode === null || input.initialMode === "" ? null : String(input.initialMode);
  if (askedMode && !["ON_ACCOUNT", "RECLASS"].includes(askedMode)) throw refuse("BAD_INPUT", "initialMode is ON_ACCOUNT | RECLASS.");
  let total: Decimal;
  try { total = toDecimal(String(input.amount ?? "")); if (!total.equals(total.toDecimalPlaces(2)) || total.lte(0)) throw new Error(); } catch { throw refuse("AMOUNT", "(amount > 0, 2 decimals)"); }
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const t = typeof input.templateId === "string" ? await tx.deferralTemplate.findUnique({ where: { id: input.templateId } }) : null;
    if (!t) throw refuse("NOT_FOUND", "(template)", "(القالب)");
    if (!t.isActive) throw refuse("DEFERRAL_TEMPLATE_INACTIVE");
    const kind = t.kind as DeferralKind;
    const balanceAccountId = t.balanceAccountId ?? (await resolveRoles(tx, [KIND_ROLE[kind]])).get(KIND_ROLE[kind])!;
    await accountFor(tx, balanceAccountId, KIND_TYPES[kind].balance, roleDef(KIND_ROLE[kind])?.en ?? "balance-sheet account");
    await accountFor(tx, t.plAccountId, KIND_TYPES[kind].pl, "P&L account");
    const branchId = str(input.branchId, 64), costCenterId = str(input.costCenterId, 64);
    if (branchId && !(await tx.finBranch.findUnique({ where: { id: branchId }, select: { id: true } }))) throw refuse("DIMENSION_NOT_FOUND", "(branch)", "(الفرع)");
    if (costCenterId && !(await tx.finCostCenter.findUnique({ where: { id: costCenterId }, select: { id: true } }))) throw refuse("DIMENSION_NOT_FOUND", "(cost centre)", "(مركز التكلفة)");
    let split;
    try { split = deferralSplit(total.toFixed(2), t.months, start, t.startRule as StartRule); } catch (e) { throw refuse("DEFERRAL_AMOUNT", `(${e instanceof Error ? e.message : String(e)})`); }
    const src = await checkSource(tx, sourceType, sourceId, total, balanceAccountId, kind);
    let initialMode: "ON_ACCOUNT" | "RECLASS", reclassAccountId: string | null = null;
    if (sourceType === "JOURNAL_LINE") {
      if (askedMode === "RECLASS") throw refuse("DEFERRAL_SOURCE", "(a journal-line source is already on the balance-sheet account: no reclass)", "(سطر القيد على حساب الميزانية مسبقًا: لا إعادة تصنيف)");
      initialMode = "ON_ACCOUNT";
    } else if (sourceType !== "MANUAL") {
      if (askedMode === "ON_ACCOUNT") throw refuse("DEFERRAL_SOURCE", "(an invoice line was booked to P&L: it is reclassified)", "(سطر الفاتورة قُيّد في قائمة الدخل: يُعاد تصنيفه)");
      initialMode = "RECLASS"; reclassAccountId = src.reclassFrom;
    } else if (askedMode === "RECLASS") {
      initialMode = "RECLASS";
      reclassAccountId = await accountFor(tx, input.reclassAccountId, KIND_TYPES[kind].pl, kind === "PREPAID_EXPENSE" ? "the expense account to reclassify from" : "the revenue account to reclassify from");
    } else initialMode = "ON_ACCOUNT";
    if (reclassAccountId === balanceAccountId) throw refuse("DEFERRAL_SOURCE", "(the reclass account is the balance-sheet account)");
    // Council follow-up: an invoice-line schedule recognises back into the LINE's own account (its expense category /
    // sales revenue) — not the template's — unless the user deliberately names another (`plAccountId`): then the
    // schedule records it (plAccountId ≠ reclassAccountId, shown as «حساب الإثبات يختلف عن حساب السطر», audited with a reason).
    let plAccountId = t.plAccountId;
    const fromLine = sourceType === "SUPPLIER_INVOICE_LINE" || sourceType === "SALES_INVOICE_LINE";
    if (fromLine) plAccountId = reclassAccountId!;
    if (input.plAccountId !== undefined && input.plAccountId !== null && input.plAccountId !== "") {
      if (!fromLine) throw refuse("BAD_INPUT", "plAccountId is chosen only for an invoice-line schedule (the template decides otherwise).");
      plAccountId = await accountFor(tx, input.plAccountId, KIND_TYPES[kind].pl, "recognition account");
      if (plAccountId !== reclassAccountId) await setAuditContext(tx, { ...ctx, reason: `recognition account differs from the line's account (${sourceType} ${sourceId})` });
    }
    const id = `dfs_${crypto.randomUUID().replace(/-/g, "")}`;
    const number = await nextScheduleNumber(tx, start);
    let reclassStatus: string | null = null, reclassEntryId: string | null = null;
    if (initialMode === "RECLASS") {
      const r = await postEntry(tx, {
        source: { module: "accounting", type: "DEFERRAL_SCHEDULE", id, event: "RECLASSIFIED" }, date: dayText(start), createdBy: ctx.actorId,
        memo: `إعادة تصنيف إلى ${kind === "PREPAID_EXPENSE" ? "مصروف مدفوع مقدماً" : "إيراد مؤجل"} · ${number} · ${description}`.slice(0, 500),
        lines: moveLines(kind, true, total, balanceAccountId, reclassAccountId!, `${number} · ${description}`.slice(0, 500), { branchId, costCenterId }),
      });
      reclassStatus = r.status === "posted" ? "POSTED" : "SKIPPED";
      reclassEntryId = r.status === "posted" ? r.entryId : null;
    }
    await tx.deferralSchedule.create({
      data: {
        id, number, templateId: t.id, kind, months: t.months, startRule: t.startRule, startDate: start, totalAmount: total, balanceAccountId, plAccountId,
        description, sourceType, sourceId, branchId, costCenterId, initialMode, reclassAccountId, reclassStatus, reclassEntryId, createdBy: ctx.actorId,
        lines: { create: split.map((l) => ({ seq: l.seq, periodStart: l.periodStart, amount: l.amount })) },
      },
      select: { id: true },
    });
    return getSchedule(id, tx);
  }, TX_OPTS);
}

const ACC = { select: { id: true, code: true, nameAr: true, nameEn: true } } as const;
const SCHEDULE_INCLUDE = {
  template: { select: { id: true, nameAr: true, nameEn: true } },
  balanceAccount: ACC, plAccount: ACC, reclassAccount: ACC, cancelAccount: ACC,
  lines: { orderBy: { seq: "asc" as const }, include: { run: { select: { id: true, status: true, journalEntryId: true } } } },
} satisfies Prisma.DeferralScheduleInclude;
type ScheduleRow = Prisma.DeferralScheduleGetPayload<{ include: typeof SCHEDULE_INCLUDE }>;

/** What is left on the balance-sheet account for a schedule: its PENDING lines — none after a «إثبات الباقي الآن» cancel. */
function remainingOf(s: { cancelMode: string | null; lines: { status: string; amount: Prisma.Decimal | Decimal }[] }): Decimal {
  if (s.cancelMode === "RECOGNIZE_NOW") return ZERO;
  return s.lines.filter((l) => l.status === "PENDING").reduce((a, l) => a.plus(l.amount), ZERO);
}

function scheduleJson(s: ScheduleRow) {
  const recognised = s.lines.filter((l) => l.status === "RECOGNIZED").reduce((a, l) => a.plus(l.amount), ZERO);
  return {
    id: s.id, number: s.number, kind: s.kind, months: s.months, startRule: s.startRule, startDate: dayText(s.startDate), totalAmount: fix2(new Decimal(s.totalAmount)),
    recognised: fix2(recognised), remaining: fix2(remainingOf(s)), description: s.description, sourceType: s.sourceType, sourceId: s.sourceId,
    branchId: s.branchId, costCenterId: s.costCenterId, status: s.status, createdBy: s.createdBy, createdAt: s.createdAt.toISOString(),
    initialMode: s.initialMode, reclassAccount: s.reclassAccount, reclassStatus: s.reclassStatus, reclassEntryId: s.reclassEntryId,
    /** «حساب الإثبات يختلف عن حساب السطر»: an invoice-line schedule recognising into another account than its line's. */
    plDiffersFromLine: (s.sourceType === "SUPPLIER_INVOICE_LINE" || s.sourceType === "SALES_INVOICE_LINE") && s.plAccountId !== s.reclassAccountId,
    cancelledAt: s.cancelledAt?.toISOString() ?? null, cancelledBy: s.cancelledBy, cancelReason: s.cancelReason,
    cancelMode: s.cancelMode, cancelDate: s.cancelDate ? dayText(s.cancelDate) : null, cancelAccount: s.cancelAccount, cancelAmount: s.cancelAmount ? fix2(new Decimal(s.cancelAmount)) : null, cancelStatus: s.cancelStatus, cancelEntryId: s.cancelEntryId,
    template: s.template, balanceAccount: s.balanceAccount, plAccount: s.plAccount,
    lines: s.lines.map((l) => ({ id: l.id, seq: l.seq, month: monthKey(l.periodStart), periodStart: dayText(l.periodStart), amount: fix2(new Decimal(l.amount)), status: l.status, runId: l.runId, runStatus: l.run?.status ?? null, journalEntryId: l.run?.journalEntryId ?? null })),
  };
}

export async function getSchedule(id: string, db: Db = prisma) {
  const s = await db.deferralSchedule.findUnique({ where: { id }, include: SCHEDULE_INCLUDE });
  if (!s) throw refuse("NOT_FOUND");
  return scheduleJson(s);
}

export async function listSchedules(q: { status?: string | null; kind?: string | null; take?: number; skip?: number } = {}) {
  const where: Prisma.DeferralScheduleWhereInput = {};
  if (q.status && ["ACTIVE", "COMPLETED", "CANCELLED"].includes(q.status)) where.status = q.status;
  if (q.kind && isKind(q.kind)) where.kind = q.kind;
  const take = Math.min(Math.max(q.take ?? 50, 1), 200), skip = Math.max(q.skip ?? 0, 0);
  const [rows, total] = await Promise.all([
    prisma.deferralSchedule.findMany({ where, orderBy: [{ createdAt: "desc" }], take, skip, include: SCHEDULE_INCLUDE }),
    prisma.deferralSchedule.count({ where }),
  ]);
  return { items: rows.map(scheduleJson), total, take, skip };
}

/**
 * «إلغاء الجدول» (council F4) — no later month is recognised; the remainder (its PENDING lines):
 *   RECOGNIZE_NOW «إثبات الباقي الآن»  one entry on `date` (default today) — prepaid Dr target / Cr balance, deferred Dr
 *                                      balance / Cr target; target = `accountId` or the P&L account (the reclass account
 *                                      to undo a reclass). Its runs can no longer be reversed (the months would count twice).
 *   KEEP «إبقاء في الحساب»            no entry; the remainder stays on the balance-sheet account and in the reconciliation
 *                                      (the reason is the required note).
 */
export async function cancelSchedule(id: string, inp: { reason?: unknown; mode?: unknown; accountId?: unknown; date?: unknown }, ctx: AuditContext) {
  const r = str(inp.reason, 500);
  if (!r || r.length < 3) throw refuse("REASON_REQUIRED");
  const mode = inp.mode === undefined ? null : String(inp.mode);
  if (mode !== "RECOGNIZE_NOW" && mode !== "KEEP") throw refuse("BAD_INPUT", "mode is RECOGNIZE_NOW | KEEP.", "اختر: إثبات الباقي الآن أو إبقاؤه في الحساب.");
  let day = riyadhDay();
  if (inp.date !== undefined && inp.date !== null && inp.date !== "") { try { day = parseBusinessDay(String(inp.date)); } catch { throw refuse("BAD_INPUT", "date is YYYY-MM-DD."); } }
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    await tx.$queryRaw`SELECT "id" FROM "DeferralSchedule" WHERE "id" = ${id} FOR UPDATE`;
    const s = await tx.deferralSchedule.findUnique({ where: { id }, include: { lines: { where: { status: "PENDING" }, select: { amount: true } } } });
    if (!s) throw refuse("NOT_FOUND");
    if (s.status === "CANCELLED") throw refuse("DEFERRAL_STATE");
    const remaining = s.lines.reduce((a, l) => a.plus(l.amount), ZERO);
    let cancelAccountId: string | null = null, cancelStatus = "NONE", cancelEntryId: string | null = null;
    if (mode === "RECOGNIZE_NOW") {
      cancelAccountId = inp.accountId ? await postableAccount(tx, inp.accountId, s.balanceAccountId) : s.plAccountId;
      if (remaining.gt(0)) {
        const memo = `إثبات باقي جدول التأجيل عند إلغائه · ${s.number} · ${s.description}`.slice(0, 500);
        const e = await postEntry(tx, {
          source: { module: "accounting", type: "DEFERRAL_SCHEDULE", id, event: "CANCEL_RECOGNIZED" }, date: dayText(day), createdBy: ctx.actorId, memo,
          lines: moveLines(s.kind, false, remaining, s.balanceAccountId, cancelAccountId, memo, { branchId: s.branchId, costCenterId: s.costCenterId }),
        });
        cancelStatus = e.status === "posted" ? "POSTED" : "SKIPPED";
        cancelEntryId = e.status === "posted" ? e.entryId : null;
      }
    }
    await tx.deferralSchedule.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: ctx.actorId, cancelReason: r, cancelMode: mode, cancelDate: day, cancelAccountId, cancelAmount: remaining, cancelStatus, cancelEntryId } });
    return getSchedule(id, tx);
  }, TX_OPTS);
}

/** An active postable leaf, not the balance-sheet account itself. */
async function postableAccount(db: Db, id: unknown, notId: string) {
  const accountId = typeof id === "string" ? id : "";
  const a = accountId ? await db.account.findUnique({ where: { id: accountId }, select: { id: true, code: true, isActive: true, allowPosting: true, _count: { select: { children: true } } } }) : null;
  if (!a || !a.isActive || !a.allowPosting || a._count.children > 0) throw refuse("ACCOUNT_NOT_POSTABLE");
  if (a.id === notId) throw refuse("BAD_INPUT", "(not the balance-sheet account itself)");
  return a.id;
}

// ── the monthly recognition run ───────────────────────────────────────────────────────────────────────────────────

export type RunSummary = {
  id: string; month: string; entryDate: string; status: string; skipReason: string | null; journalEntryId: string | null; journalRef: string | null;
  total: string; lineCount: number; createdBy: string; createdAt: string; reversedAt: string | null; reversedBy: string | null; reverseReason: string | null; reversalEntryId: string | null;
};
export type RunResult = { status: "RECORDED"; month: string; run: RunSummary } | { status: "NOTHING_DUE"; month: string; run: null; existingRuns: RunSummary[] };

async function runJson(db: Db, id: string): Promise<RunSummary> {
  const r = await db.deferralRun.findUniqueOrThrow({ where: { id } });
  const je = r.journalEntryId ? await db.journalEntry.findUnique({ where: { id: r.journalEntryId }, select: { postingYear: true, postingSeq: true } }) : null;
  return {
    id: r.id, month: monthKey(r.periodStart), entryDate: dayText(r.entryDate), status: r.status, skipReason: r.skipReason, journalEntryId: r.journalEntryId, journalRef: je ? postingRef(je) : null,
    total: fix2(new Decimal(r.total)), lineCount: r.lineCount, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
    reversedAt: r.reversedAt?.toISOString() ?? null, reversedBy: r.reversedBy, reverseReason: r.reverseReason, reversalEntryId: r.reversalEntryId,
  };
}

/**
 * «تشغيل الاعتراف الشهري» for one month — EXPORTED for the recurring-transactions builder (APIS.md).
 *   input.month      "YYYY-MM"
 *   input.actorId    who runs it (a person, or the scheduler's system actor)
 *   input.scheduleIds  optional: only these schedules (default: every ACTIVE schedule with the month PENDING)
 * Returns RECORDED (the run: POSTED with its entry, or SKIPPED before go-live) or NOTHING_DUE (with the month's runs).
 * Throws the engine's refusals (PERIOD_CLOSED / PERIOD_SOFT_CLOSED, ROLE_NOT_MAPPED, ACCOUNT_NOT_POSTABLE …): nothing is
 * then recorded. Safe to call again: a recognised (schedule, month) is never recognised twice.
 */
export async function runDeferralRecognition(input: { month: string; actorId: string; scheduleIds?: string[]; audit?: Omit<AuditContext, "actorId"> }): Promise<RunResult> {
  const periodStart = parseMonth(input.month);
  if (typeof input.actorId !== "string" || !input.actorId) throw refuse("BAD_INPUT", "actorId.");
  const month = monthKey(periodStart);
  const entryDate = monthEnd(periodStart);
  // A month is recognised in it or after it, never in advance.
  if (periodStart > monthStart(riyadhDay())) throw refuse("DEFERRAL_FUTURE_MONTH", `(${month})`, `(${month})`);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...(input.audit ?? {}), actorId: input.actorId, reason: input.audit?.reason ?? `deferral recognition ${month}` });
    // One run of a month at a time (a second caller waits, then finds nothing due).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`deferral:run:${month}`}, 0))`;
    const lines = await tx.deferralScheduleLine.findMany({
      where: { periodStart, status: "PENDING", schedule: { status: "ACTIVE", ...(input.scheduleIds?.length ? { id: { in: input.scheduleIds } } : {}) } },
      include: { schedule: { select: { id: true, number: true, kind: true, description: true, balanceAccountId: true, plAccountId: true, branchId: true, costCenterId: true } } },
      orderBy: [{ schedule: { number: "asc" } }],
    });
    if (!lines.length) {
      const existing = await tx.deferralRun.findMany({ where: { periodStart }, orderBy: { createdAt: "asc" }, select: { id: true } });
      return { status: "NOTHING_DUE" as const, month, run: null, existingRuns: await Promise.all(existing.map((r) => runJson(tx, r.id))) };
    }
    const total = lines.reduce((s, l) => s.plus(l.amount), ZERO);
    const runId = `dfr_${crypto.randomUUID().replace(/-/g, "")}`;
    const entryLines = runEntryLines(lines.map((l) => ({ ...l.schedule, amount: new Decimal(l.amount) })));
    const posted = await postEntry(tx, {
      source: { module: "accounting", type: "DEFERRAL_RUN", id: runId, event: "RECOGNIZED" }, date: dayText(entryDate),
      memo: `الاعتراف الشهري بالمؤجلات ${month} (${lines.length} ${lines.length === 1 ? "جدول" : "جداول"})`, createdBy: input.actorId, lines: entryLines,
    });
    await tx.deferralRun.create({
      data: {
        id: runId, periodStart, entryDate, status: posted.status === "posted" ? "POSTED" : "SKIPPED", skipReason: posted.status === "skipped" ? posted.reason : null,
        journalEntryId: posted.status === "posted" ? posted.entryId : null, total, lineCount: lines.length, createdBy: input.actorId,
      },
    });
    await tx.deferralScheduleLine.updateMany({ where: { id: { in: lines.map((l) => l.id) }, status: "PENDING" }, data: { status: "RECOGNIZED", runId } });
    // A schedule whose every line is recognised is COMPLETED.
    const ids = [...new Set(lines.map((l) => l.schedule.id))];
    const open = await tx.deferralScheduleLine.groupBy({ by: ["scheduleId"], where: { scheduleId: { in: ids }, status: "PENDING" }, _count: { _all: true } });
    const stillOpen = new Set(open.map((o) => o.scheduleId));
    const done = ids.filter((i) => !stillOpen.has(i));
    if (done.length) await tx.deferralSchedule.updateMany({ where: { id: { in: done }, status: "ACTIVE" }, data: { status: "COMPLETED" } });
    return { status: "RECORDED" as const, month, run: await runJson(tx, runId) };
  }, TX_OPTS);
}

/** The months up to `asOf` (default today, Riyadh) that still have PENDING lines of ACTIVE schedules, oldest first. */
export async function dueMonths(asOf: Date = riyadhDay()): Promise<{ month: string; lines: number; amount: string }[]> {
  const rows = await prisma.deferralScheduleLine.groupBy({ by: ["periodStart"], where: { status: "PENDING", periodStart: { lte: monthStart(asOf) }, schedule: { status: "ACTIVE" } }, _count: { _all: true }, _sum: { amount: true }, orderBy: { periodStart: "asc" } });
  return rows.map((r) => ({ month: monthKey(r.periodStart), lines: r._count._all, amount: fix2(new Decimal(r._sum.amount ?? 0)) }));
}

/**
 * Every due month up to `asOf`, oldest first — what a scheduler calls (APIS.md). Stops at the first refusal (a closed
 * period, an unmapped account …) and reports it; the months before it stay recorded.
 */
export async function runDueDeferralRecognition(input: { actorId: string; asOf?: string; audit?: Omit<AuditContext, "actorId"> }) {
  const asOf = input.asOf ? (() => { try { return parseBusinessDay(input.asOf!); } catch { throw refuse("BAD_INPUT", "asOf is YYYY-MM-DD."); } })() : riyadhDay();
  const results: RunResult[] = [];
  for (const m of await dueMonths(asOf)) {
    try {
      results.push(await runDeferralRecognition({ month: m.month, actorId: input.actorId, audit: input.audit }));
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { results, stoppedAt: { month: m.month, code: err.code ?? "ERROR", message: err.message ?? String(e) } };
    }
  }
  return { results, stoppedAt: null };
}

/** «عكس التشغيل»: the run's entry reversed on its own date (a closed month is refused), the run REVERSED, its lines PENDING. */
export async function reverseDeferralRun(runId: string, reason: unknown, ctx: AuditContext) {
  const r = str(reason, 500);
  if (!r || r.length < 3) throw refuse("REASON_REQUIRED");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    await tx.$queryRaw`SELECT "id" FROM "DeferralRun" WHERE "id" = ${runId} FOR UPDATE`;
    const run = await tx.deferralRun.findUnique({ where: { id: runId } });
    if (!run) throw refuse("NOT_FOUND");
    if (run.status === "REVERSED") throw refuse("DEFERRAL_STATE");
    const month = monthKey(run.periodStart);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`deferral:run:${month}`}, 0))`;
    // Council F4: a month of a schedule whose remainder was recognised at its cancel is not taken back (it would count twice).
    const blocked = await tx.deferralScheduleLine.count({ where: { runId, schedule: { cancelMode: "RECOGNIZE_NOW" } } });
    if (blocked) throw refuse("DEFERRAL_STATE", "(a schedule of this run was cancelled with its remainder recognised)", "(أحد جداول هذا التشغيل أُلغي بإثبات باقيه)");
    let reversalEntryId: string | null = null;
    if (run.journalEntryId) {
      const rev = await reverseEntry(tx, { entryId: run.journalEntryId, reason: r, actorId: ctx.actorId, date: dayText(run.entryDate) });
      reversalEntryId = rev.entryId;
    }
    await tx.deferralRun.update({ where: { id: runId }, data: { status: "REVERSED", reversedAt: new Date(), reversedBy: ctx.actorId, reverseReason: r, reversalEntryId } });
    const lines = await tx.deferralScheduleLine.findMany({ where: { runId }, select: { id: true, scheduleId: true } });
    await tx.deferralScheduleLine.updateMany({ where: { runId }, data: { status: "PENDING", runId: null } });
    const ids = [...new Set(lines.map((l) => l.scheduleId))];
    if (ids.length) await tx.deferralSchedule.updateMany({ where: { id: { in: ids }, status: "COMPLETED" }, data: { status: "ACTIVE" } });
    return runJson(tx, runId);
  }, TX_OPTS);
}

export async function listRuns(q: { take?: number } = {}) {
  const rows = await prisma.deferralRun.findMany({ orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }], take: Math.min(Math.max(q.take ?? 50, 1), 200), select: { id: true } });
  return Promise.all(rows.map((r) => runJson(prisma, r.id)));
}

export async function getRun(id: string) {
  const run = await runJson(prisma, id).catch(() => { throw refuse("NOT_FOUND"); });
  const lines = await prisma.deferralScheduleLine.findMany({ where: { runId: id }, include: { schedule: { select: { id: true, number: true, kind: true, description: true } } }, orderBy: { schedule: { number: "asc" } } });
  // A reversed run released its lines (PENDING again): it lists none; its entry and its reversal stay in the journal.
  return { ...run, lines: lines.map((l) => ({ id: l.id, amount: fix2(new Decimal(l.amount)), schedule: l.schedule })) };
}

// ── reconciliation, go-live opening, backlog ──────────────────────────────────────────────────────────────────────

type LiveSchedule = Prisma.DeferralScheduleGetPayload<{ include: { balanceAccount: { select: { code: true; nameAr: true; nameEn: true } }; lines: { select: { amount: true; status: true; periodStart: true; run: { select: { status: true; entryDate: true } } } } } }>;

async function liveSchedules(db: Db): Promise<LiveSchedule[]> {
  return db.deferralSchedule.findMany({ include: { balanceAccount: { select: { code: true, nameAr: true, nameEn: true } }, lines: { select: { amount: true, status: true, periodStart: true, run: { select: { status: true, entryDate: true } } } } } });
}

/**
 * A schedule's unrecognised amount as of a day: its amount less the lines recognised by runs dated on / before it — and
 * the months ending before go-live, which are recognised outside the books whether or not they were run (a run of them is
 * SKIPPED) — and nothing once its remainder was recognised at a cancel dated on / before it.
 */
function unrecognisedAsOf(s: LiveSchedule, asOf: Date, goLive: Date | null): Decimal {
  if (s.startDate > asOf) return ZERO;
  if (s.cancelMode === "RECOGNIZE_NOW" && s.cancelDate && s.cancelDate <= asOf) return ZERO;
  const done = s.lines.filter((l) => (l.status === "RECOGNIZED" && l.run && l.run.entryDate <= asOf) || (goLive && monthEnd(l.periodStart) < goLive)).reduce((a, l) => a.plus(l.amount), ZERO);
  return new Decimal(s.totalAmount).minus(done);
}

/**
 * Council F2 — what the books cannot hold for a schedule at go-live: a schedule started before go-live whose amount never
 * came in through an engine entry (not a journal-line source, its reclass not POSTED) carries, at go-live, its lines of the
 * months that end on / after the go-live day (earlier months are recognised outside the books: SKIPPED). A cancel before
 * go-live that recognised the remainder leaves nothing.
 */
function openingAmountOf(s: LiveSchedule, goLive: Date): Decimal {
  if (s.startDate >= goLive || s.sourceType === "JOURNAL_LINE" || s.reclassStatus === "POSTED") return ZERO;
  if (s.cancelMode === "RECOGNIZE_NOW" && s.cancelDate && s.cancelDate < goLive) return ZERO;
  return s.lines.filter((l) => monthEnd(l.periodStart) >= goLive).reduce((a, l) => a.plus(l.amount), ZERO);
}

/** «المؤجلات غير المعترف بها» — the go-live opening per balance-sheet account (prepaid: a debit; deferred revenue: a credit). */
export async function openingDeferrals(db: Db = prisma): Promise<{ accountId: string; code: string; name: string; kind: string; amount: string; schedules: number }[]> {
  const st = await db.accountingSettings.findUnique({ where: { id: "singleton" }, select: { goLiveDate: true } });
  if (!st?.goLiveDate) return [];
  const by = new Map<string, { accountId: string; code: string; name: string; kind: string; amount: Decimal; schedules: number }>();
  for (const s of await liveSchedules(db)) {
    const v = openingAmountOf(s, st.goLiveDate);
    if (v.isZero()) continue;
    const e = by.get(s.balanceAccountId) ?? { accountId: s.balanceAccountId, code: s.balanceAccount.code, name: s.balanceAccount.nameAr ?? s.balanceAccount.nameEn, kind: s.kind, amount: ZERO, schedules: 0 };
    e.amount = e.amount.plus(v); e.schedules += 1;
    by.set(s.balanceAccountId, e);
  }
  return [...by.values()].sort((a, b) => a.code.localeCompare(b.code)).map((e) => ({ ...e, amount: fix2(e.amount) }));
}

/**
 * «مطابقة الحسابات»: per balance-sheet account used by a schedule that still has an unrecognised amount (active, completed
 * last month, or cancelled with the remainder kept — until it is zero), that amount as of `asOf` beside the account's
 * ledger balance (the statements service). The opening still to post (F2) explains a difference; the rest is UNEXPLAINED
 * (amounts on the account no schedule covers, or a schedule whose amount was never booked there).
 */
export async function deferralReconciliation(asOf: Date = riyadhDay()) {
  const st = await prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { goLiveDate: true, openingEntryId: true } });
  const all = await liveSchedules(prisma);
  type Row = { accountId: string; code: string; name: string; nameEn: string; kind: string; unrecognised: Decimal; opening: Decimal; schedules: number };
  const byAcc = new Map<string, Row>();
  for (const s of all) {
    const u = unrecognisedAsOf(s, asOf, st?.goLiveDate ?? null);
    const o = !st?.openingEntryId && st?.goLiveDate && st.goLiveDate <= asOf ? openingAmountOf(s, st.goLiveDate) : ZERO;
    if (u.isZero() && o.isZero() && !byAcc.has(s.balanceAccountId)) continue;
    const e = byAcc.get(s.balanceAccountId) ?? { accountId: s.balanceAccountId, code: s.balanceAccount.code, name: s.balanceAccount.nameAr ?? s.balanceAccount.nameEn, nameEn: s.balanceAccount.nameEn, kind: s.kind, unrecognised: ZERO, opening: ZERO, schedules: 0 };
    e.unrecognised = e.unrecognised.plus(u); e.opening = e.opening.plus(o);
    if (!u.isZero()) e.schedules += 1;
    byAcc.set(s.balanceAccountId, e);
  }
  const net = byAcc.size ? await netByAccount([{ from: null, to: asOf }]) : new Map<string, Decimal[]>();
  return [...byAcc.values()].sort((a, b) => a.code.localeCompare(b.code)).map((e) => {
    const n = (net.get(e.accountId)?.[0] ?? ZERO);
    const gl = e.kind === "PREPAID_EXPENSE" ? n : n.negated();
    const diff = gl.minus(e.unrecognised);
    const unexplained = diff.plus(e.opening);
    return { accountId: e.accountId, code: e.code, name: e.name, nameEn: e.nameEn, kind: e.kind, schedules: e.schedules, unrecognised: fix2(e.unrecognised), glBalance: fix2(gl), difference: fix2(diff), openingPending: fix2(e.opening), unexplained: fix2(unexplained),
      status: diff.isZero() ? "MATCHED" : unexplained.isZero() ? "EXPLAINED" : "UNEXPLAINED" };
  });
}

/**
 * Council F6 — «تنبيه المتأخرات» for the deferrals page and the accountant dashboard (APIS.md): the months up to `asOf`
 * (default today) with PENDING lines of ACTIVE schedules; `overdue` = those before the current month; `stoppedAt` = the
 * oldest due month that cannot run now and why (PERIOD_CLOSED / PERIOD_SOFT_CLOSED; NOT_RUN when nothing stops it: it
 * simply has not been run).
 */
export async function deferralBacklog(asOf: Date = riyadhDay()) {
  const due = await dueMonths(asOf);
  const current = monthKey(asOf);
  const overdue = due.filter((m) => m.month < current);
  let stoppedAt: { month: string; reason: "PERIOD_CLOSED" | "PERIOD_SOFT_CLOSED" | "NOT_RUN" } | null = null;
  for (const m of overdue) {
    const end = monthEnd(parseMonth(m.month));
    const p = await prisma.fiscalPeriod.findFirst({ where: { startDate: { lte: end }, endDate: { gte: end } }, select: { status: true } });
    const st = String(p?.status ?? "OPEN");
    if (st === "CLOSED" || st === "LOCKED") { stoppedAt = { month: m.month, reason: st === "CLOSED" ? "PERIOD_CLOSED" : "PERIOD_SOFT_CLOSED" }; break; }
    if (!stoppedAt) stoppedAt = { month: m.month, reason: "NOT_RUN" };
    break;
  }
  return { asOf: dayText(asOf), due, dueCount: due.length, overdueCount: overdue.length, overdueAmount: fix2(overdue.reduce((a, m) => a.plus(m.amount), ZERO)), stoppedAt };
}
