// «الموازنات» (feat/budgets-deferrals, 20261122090000_budgets_deferrals) — the GL budget and the budget-vs-actual report.
//
//   A budget: a name, a Gregorian fiscal year, optionally a branch, a status (DRAFT → APPROVED → ARCHIVED) and amounts per
//   P&L account per month, on the account's NATURAL side (a credit-normal account — revenue — credit-positive, a
//   debit-normal one — expenses, contra-revenue — debit-positive). It NEVER posts to the GL.
//   • DRAFT: edited (the grid), «توزيع بالتساوي» (./deferral-math spreadEvenly) and «نسخ من فعلي السنة السابقة»
//     (lastYearActuals) are helpers of the screen;
//   • APPROVED (accounting › journal_approve; the SoD setting decides whether the preparer may approve — recorded as
//     sodBypass): LOCKED by the database (gl_budget_guard / gl_budget_line_guard). A change is a REVISION: a new DRAFT of the
//     same family (rootId) with revisionNo + 1 and a reason; approving it archives the version it replaces, in one
//     transaction (at most one DRAFT and one APPROVED per family: partial unique indexes);
//   • ARCHIVED: final.
//   Budget vs actual: the actuals are the ledger's, read through the statements service (statements.netByAccount — the
//   aggregate the income statement uses, CLOSING excluded; the branch's lines only for a branch budget). Never a second sum
//   of the journals. By month and year-to-date: budget, actual, variance (actual − budget), variance % (of |budget|) and
//   whether it is favourable; sections by statement group, net profit; every cell drills to the account's general ledger.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { Decimal, ZERO, fix2, toDecimal, MoneyError } from "./money";
import { dayText, riyadhDay } from "./dates";
import { refuse } from "./refusals";
import { setAuditContext, type AuditContext } from "./audit";
import { sodPolicy, sodDecision } from "./sod";
import { loadAccountInfo, netByAccount, periodRange, GROUP_LABEL, type ReportGroup } from "./statements";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export const BUDGET_STATUSES = ["DRAFT", "APPROVED", "ARCHIVED"] as const;
export const PL_GROUPS: ReportGroup[] = ["REVENUE", "COST_OF_SALES", "OPERATING_EXPENSE", "OTHER_INCOME_EXPENSE", "ZAKAT"];
const MONTHS = 12;

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const endOfDay = (d: Date) => new Date(d.getTime() + 86_399_999);

function amountOf(v: unknown, what: string): Decimal {
  try {
    const d = toDecimal(typeof v === "number" ? (Number.isFinite(v) ? String(v) : "x") : String(v ?? ""));
    if (!d.equals(d.toDecimalPlaces(2))) throw new MoneyError("2 decimals");
    if (d.abs().greaterThanOrEqualTo("10000000000000000")) throw new MoneyError("too large");
    return d;
  } catch {
    throw refuse("AMOUNT", `(${what})`, `(${what})`);
  }
}

function yearOf(v: unknown): number {
  const y = Number(v);
  if (!Number.isInteger(y) || y < 2000 || y > 2200) throw refuse("BAD_INPUT", "fiscalYear is a year (2000–2200).", "السنة المالية غير صالحة.");
  return y;
}

/** A branch of the ledger's branch dimension (FinBranch), or null for the whole company. */
async function branchOf(db: Db, v: unknown): Promise<string | null> {
  const id = str(v, 64);
  if (!id) return null;
  if (!(await db.finBranch.findUnique({ where: { id }, select: { id: true } }))) throw refuse("DIMENSION_NOT_FOUND", "(branch)", "(الفرع)");
  return id;
}

/** The accounts a budget may carry: postable P&L accounts (revenue / expense) — active, or already on the budget. */
export async function budgetAccounts(db: Db = prisma, keep: string[] = []) {
  const info = await loadAccountInfo();
  const rows = await db.account.findMany({
    where: { type: { in: ["REVENUE", "EXPENSE"] }, allowPosting: true, OR: [{ isActive: true }, { id: { in: keep.length ? keep : ["-"] } }] },
    select: { id: true, code: true, nameAr: true, nameEn: true, type: true, normalBalance: true, isActive: true, _count: { select: { children: true } } },
    orderBy: { code: "asc" },
  });
  return rows.filter((a) => a._count.children === 0).map((a) => ({
    id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, type: String(a.type), normalBalance: a.normalBalance, isActive: a.isActive,
    group: (info.get(a.id)?.group ?? (String(a.type) === "REVENUE" ? "REVENUE" : "OPERATING_EXPENSE")) as ReportGroup,
  }));
}

type BudgetRow = Prisma.GlBudgetGetPayload<{ include: { lines: true } }>;

function headerJson(b: Omit<BudgetRow, "lines">) {
  return {
    id: b.id, name: b.name, fiscalYear: b.fiscalYear, branchId: b.branchId, status: b.status, rootId: b.rootId, revisionOfId: b.revisionOfId,
    revisionNo: b.revisionNo, revisionReason: b.revisionReason, notes: b.notes, createdBy: b.createdBy, createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(), updatedBy: b.updatedBy, approvedBy: b.approvedBy, approvedAt: b.approvedAt?.toISOString() ?? null,
    sodBypass: b.sodBypass, archivedBy: b.archivedBy, archivedAt: b.archivedAt?.toISOString() ?? null,
  };
}

/** «الموازنات»: every budget (newest year first), with its totals by side. */
export async function listBudgets(q: { year?: number | null; status?: string | null } = {}) {
  const where: Prisma.GlBudgetWhereInput = {};
  if (q.year) where.fiscalYear = q.year;
  if (q.status && (BUDGET_STATUSES as readonly string[]).includes(q.status)) where.status = q.status;
  const [rows, branches] = await Promise.all([
    prisma.glBudget.findMany({ where, orderBy: [{ fiscalYear: "desc" }, { name: "asc" }, { revisionNo: "desc" }], include: { lines: { select: { amount: true, account: { select: { normalBalance: true } } } } } }),
    prisma.finBranch.findMany({ select: { id: true, code: true, nameAr: true, nameEn: true } }),
  ]);
  const bn = new Map(branches.map((b) => [b.id, b]));
  return rows.map((b) => {
    let credit = ZERO, debit = ZERO;
    for (const l of b.lines) { if (l.account.normalBalance === "CREDIT") credit = credit.plus(l.amount); else debit = debit.plus(l.amount); }
    const { lines, ...h } = b;
    return { ...headerJson(h), branch: b.branchId ? bn.get(b.branchId) ?? null : null, lineCount: lines.length, totals: { creditNatural: fix2(credit), debitNatural: fix2(debit), net: fix2(credit.minus(debit)) } };
  });
}

/** One budget: its header, its lines as a grid (account → 12 months), the accounts it may carry and its family. */
export async function getBudget(id: string, db: Db = prisma) {
  const b = await db.glBudget.findUnique({ where: { id }, include: { lines: true } });
  if (!b) throw refuse("NOT_FOUND");
  const [accounts, family, branch] = await Promise.all([
    budgetAccounts(db, b.lines.map((l) => l.accountId)),
    db.glBudget.findMany({ where: { rootId: b.rootId }, orderBy: { revisionNo: "asc" }, select: { id: true, revisionNo: true, status: true, approvedAt: true, revisionReason: true, createdAt: true } }),
    b.branchId ? db.finBranch.findUnique({ where: { id: b.branchId }, select: { id: true, code: true, nameAr: true, nameEn: true } }) : null,
  ]);
  const grid = new Map<string, string[]>();
  for (const l of b.lines) {
    const row = grid.get(l.accountId) ?? Array.from({ length: MONTHS }, () => "0.00");
    row[l.month - 1] = new Decimal(l.amount).toFixed(2);
    grid.set(l.accountId, row);
  }
  const { lines: _lines, ...h } = b; void _lines;
  return {
    ...headerJson(h), branch,
    grid: [...grid].map(([accountId, months]) => ({ accountId, months })),
    accounts,
    family: family.map((f) => ({ ...f, approvedAt: f.approvedAt?.toISOString() ?? null, createdAt: f.createdAt.toISOString() })),
  };
}

type GridInput = { accountId: unknown; months: unknown }[];

/** The grid as rows (account, month 1–12, amount ≠ 0), validated against the accounts a budget may carry. */
async function parseGrid(db: Db, grid: unknown, keep: string[]): Promise<{ accountId: string; month: number; amount: Decimal }[]> {
  if (!Array.isArray(grid)) throw refuse("BAD_INPUT", "grid is a list of { accountId, months[12] }.", "الجدول غير صالح.");
  if (grid.length > 2000) throw refuse("BAD_INPUT", "grid: at most 2000 accounts.");
  const allowed = new Set((await budgetAccounts(db, keep)).map((a) => a.id));
  const seen = new Set<string>();
  const out: { accountId: string; month: number; amount: Decimal }[] = [];
  for (const r of grid as GridInput) {
    const accountId = typeof r?.accountId === "string" ? r.accountId : "";
    if (!allowed.has(accountId)) throw refuse("BAD_INPUT", `(account ${accountId || "?"} is not a postable P&L account)`, "(الموازنة لحسابات الإيرادات والمصروفات القابلة للترحيل فقط)");
    if (seen.has(accountId)) throw refuse("BAD_INPUT", "(an account appears twice)");
    seen.add(accountId);
    if (!Array.isArray(r.months) || r.months.length !== MONTHS) throw refuse("BAD_INPUT", "months: 12 amounts.");
    r.months.forEach((m, i) => {
      const a = m === null || m === undefined || m === "" ? ZERO : amountOf(m, `month ${i + 1}`);
      if (!a.isZero()) out.push({ accountId, month: i + 1, amount: a });
    });
  }
  return out;
}

/** «موازنة جديدة»: a DRAFT (optionally with its grid). */
export async function createBudget(input: { name?: unknown; fiscalYear?: unknown; branchId?: unknown; notes?: unknown; grid?: unknown }, ctx: AuditContext) {
  const name = str(input.name, 120);
  if (!name) throw refuse("BAD_INPUT", "name.", "اسم الموازنة مطلوب.");
  const fiscalYear = yearOf(input.fiscalYear);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const branchId = await branchOf(tx, input.branchId);
    const lines = input.grid === undefined ? [] : await parseGrid(tx, input.grid, []);
    const id = `glb_${crypto.randomUUID().replace(/-/g, "")}`;
    await tx.glBudget.create({ data: { id, rootId: id, name, fiscalYear, branchId, notes: str(input.notes, 1000), createdBy: ctx.actorId, updatedBy: ctx.actorId } });
    if (lines.length) await tx.glBudgetLine.createMany({ data: lines.map((l) => ({ budgetId: id, ...l })) });
    return getBudget(id, tx);
  }, TX_OPTS);
}

/** Save a DRAFT: its name / notes and its whole grid (cells changed are updated, cells now zero removed, new cells added). */
export async function saveBudget(id: string, input: { name?: unknown; notes?: unknown; grid?: unknown }, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await tx.$queryRaw`SELECT "id" FROM "GlBudget" WHERE "id" = ${id} FOR UPDATE`;
    const b = await tx.glBudget.findUnique({ where: { id }, include: { lines: true } });
    if (!b) throw refuse("NOT_FOUND");
    if (b.status !== "DRAFT") throw refuse("BUDGET_LOCKED");
    const data: Prisma.GlBudgetUpdateInput = { updatedBy: ctx.actorId };
    if (input.name !== undefined) { const n = str(input.name, 120); if (!n) throw refuse("BAD_INPUT", "name.", "اسم الموازنة مطلوب."); data.name = n; }
    if (input.notes !== undefined) data.notes = str(input.notes, 1000);
    await tx.glBudget.update({ where: { id }, data });
    if (input.grid !== undefined) {
      const want = await parseGrid(tx, input.grid, b.lines.map((l) => l.accountId));
      const key = (a: string, m: number) => `${a}#${m}`;
      const have = new Map(b.lines.map((l) => [key(l.accountId, l.month), l]));
      const wantKeys = new Set(want.map((w) => key(w.accountId, w.month)));
      const gone = b.lines.filter((l) => !wantKeys.has(key(l.accountId, l.month))).map((l) => l.id);
      if (gone.length) await tx.glBudgetLine.deleteMany({ where: { id: { in: gone } } });
      const add: { budgetId: string; accountId: string; month: number; amount: Decimal }[] = [];
      for (const w of want) {
        const h = have.get(key(w.accountId, w.month));
        if (!h) add.push({ budgetId: id, ...w });
        else if (!new Decimal(h.amount).equals(w.amount)) await tx.glBudgetLine.update({ where: { id: h.id }, data: { amount: w.amount } });
      }
      if (add.length) await tx.glBudgetLine.createMany({ data: add });
    }
    return getBudget(id, tx);
  }, TX_OPTS);
}

/** Delete a DRAFT (never an approved or archived budget: the database refuses it). */
export async function deleteDraftBudget(id: string, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? "delete draft budget" });
    const b = await tx.glBudget.findUnique({ where: { id }, select: { status: true } });
    if (!b) throw refuse("NOT_FOUND");
    if (b.status !== "DRAFT") throw refuse("BUDGET_LOCKED");
    await tx.glBudget.delete({ where: { id } });
    return { id, deleted: true };
  }, TX_OPTS);
}

/**
 * «اعتماد الموازنة»: DRAFT → APPROVED (accounting › journal_approve at the route). The preparer (creator or last editor)
 * approves only when the SoD setting allows self-approval (SIMPLE MODE does) — recorded as sodBypass. A revision's approval
 * archives the version it replaces in the same transaction. From here the database refuses every change.
 */
export async function approveBudget(id: string, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await tx.$queryRaw`SELECT "id" FROM "GlBudget" WHERE "id" = ${id} FOR UPDATE`;
    const b = await tx.glBudget.findUnique({ where: { id }, select: { status: true, rootId: true, createdBy: true, updatedBy: true, _count: { select: { lines: true } } } });
    if (!b) throw refuse("NOT_FOUND");
    if (b.status !== "DRAFT") throw refuse("BUDGET_STATE");
    if (b._count.lines === 0) throw refuse("BUDGET_EMPTY");
    const self = b.createdBy === ctx.actorId || b.updatedBy === ctx.actorId;
    if (self && !sodDecision(await sodPolicy(tx), "SELF_APPROVAL")) throw refuse("SOD_SELF_APPROVAL_BUDGET");
    const now = new Date();
    await tx.glBudget.updateMany({ where: { rootId: b.rootId, status: "APPROVED" }, data: { status: "ARCHIVED", archivedAt: now, archivedBy: ctx.actorId, updatedBy: ctx.actorId } });
    await tx.glBudget.update({ where: { id }, data: { status: "APPROVED", approvedAt: now, approvedBy: ctx.actorId, sodBypass: self, updatedBy: ctx.actorId } });
    return getBudget(id, tx);
  }, TX_OPTS);
}

/** «تعديل (نسخة جديدة)»: a revision of an APPROVED budget — a DRAFT copy (its grid), revisionNo + 1, with a reason. */
export async function reviseBudget(id: string, reason: unknown, ctx: AuditContext) {
  const r = str(reason, 500);
  if (!r || r.length < 3) throw refuse("REASON_REQUIRED");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    await tx.$queryRaw`SELECT "id" FROM "GlBudget" WHERE "id" = ${id} FOR UPDATE`;
    const b = await tx.glBudget.findUnique({ where: { id }, include: { lines: true } });
    if (!b) throw refuse("NOT_FOUND");
    if (b.status !== "APPROVED") throw refuse("BUDGET_STATE");
    const open = await tx.glBudget.findFirst({ where: { rootId: b.rootId, status: "DRAFT" }, select: { id: true } });
    if (open) throw refuse("BUDGET_REVISION_OPEN", `(${open.id})`);
    const top = await tx.glBudget.aggregate({ where: { rootId: b.rootId }, _max: { revisionNo: true } });
    const nid = `glb_${crypto.randomUUID().replace(/-/g, "")}`;
    await tx.glBudget.create({ data: { id: nid, rootId: b.rootId, revisionOfId: b.id, revisionNo: (top._max.revisionNo ?? 1) + 1, revisionReason: r, name: b.name, fiscalYear: b.fiscalYear, branchId: b.branchId, notes: b.notes, createdBy: ctx.actorId, updatedBy: ctx.actorId } });
    if (b.lines.length) await tx.glBudgetLine.createMany({ data: b.lines.map((l) => ({ budgetId: nid, accountId: l.accountId, month: l.month, amount: l.amount })) });
    return getBudget(nid, tx);
  }, TX_OPTS);
}

/** «أرشفة»: a DRAFT or an APPROVED budget → ARCHIVED (final). */
export async function archiveBudget(id: string, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const b = await tx.glBudget.findUnique({ where: { id }, select: { status: true } });
    if (!b) throw refuse("NOT_FOUND");
    if (b.status === "ARCHIVED") throw refuse("BUDGET_STATE");
    await tx.glBudget.update({ where: { id }, data: { status: "ARCHIVED", archivedAt: new Date(), archivedBy: ctx.actorId, updatedBy: ctx.actorId } });
    return getBudget(id, tx);
  }, TX_OPTS);
}

// ── actuals ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The 12 month ranges of a year (the statements service's month ranges). */
const monthRanges = (year: number) => Array.from({ length: MONTHS }, (_, i) => { const r = periodRange("month", year, i + 1); return { from: r.from, to: r.to, excludeTypes: ["CLOSING"] }; });

/** The natural sign of an account: credit-normal accounts read credit-positive, debit-normal debit-positive. */
const signOf = (normalBalance: string) => (normalBalance === "CREDIT" ? -1 : 1);

/**
 * The ledger's actuals of a year by P&L account and month, on each account's natural side (the statements service;
 * the year-end CLOSING entry excluded, as in the income statement). `branchId`: that branch's lines only.
 */
export async function plActuals(year: number, branchId: string | null) {
  const [net, accounts] = await Promise.all([netByAccount(monthRanges(year), { branchId }), loadAccountInfo()]);
  const out = new Map<string, Decimal[]>();
  for (const [id, v] of net) {
    const a = accounts.get(id);
    if (!a || !PL_GROUPS.includes(a.group)) continue;
    const s = signOf(a.normalBalance);
    if (v.every((x) => x.isZero())) continue;
    out.set(id, v.map((x) => (s === 1 ? x : x.negated())));
  }
  return out;
}

/** «نسخ من فعلي السنة السابقة»: last year's actuals as a grid (the screen fills the draft with it). */
export async function lastYearActuals(year: number, branchId: string | null) {
  const y = yearOf(year) - 1;
  const act = await plActuals(y, branchId ? await branchOf(prisma, branchId) : null);
  const allowed = new Set((await budgetAccounts()).map((a) => a.id));
  return { year: y, grid: [...act].filter(([id]) => allowed.has(id)).map(([accountId, v]) => ({ accountId, months: v.map(fix2) })) };
}

// ── budget vs actual ──────────────────────────────────────────────────────────────────────────────────────────────

const pct = (variance: Decimal, budget: Decimal) => (budget.isZero() ? null : variance.times(100).dividedBy(budget.abs()).toDecimalPlaces(1).toFixed(1));

export type Cell = { budget: string; actual: string; variance: string; variancePct: string | null; favourable: boolean | null };
function cell(budget: Decimal, actual: Decimal, creditNormal: boolean | null): Cell {
  const variance = actual.minus(budget);
  return { budget: fix2(budget), actual: fix2(actual), variance: fix2(variance), variancePct: pct(variance, budget), favourable: creditNormal === null || variance.isZero() ? null : creditNormal ? variance.greaterThan(0) : variance.lessThan(0) };
}

/**
 * «الموازنة مقابل الفعلي»: per P&L account on the budget or with actuals in the year (the branch's, for a branch budget),
 * by month and year-to-date (through `through`, 1–12; default: this month for the current year, 12 for a past one).
 * Sections by statement group, each with its subtotal; net profit (revenue-side minus cost-side). Every account row drills
 * to its general ledger.
 */
export async function budgetVsActual(id: string, opts: { through?: number | null } = {}) {
  const b = await prisma.glBudget.findUnique({ where: { id }, include: { lines: true } });
  if (!b) throw refuse("NOT_FOUND");
  const today = riyadhDay();
  const defThrough = b.fiscalYear < today.getUTCFullYear() ? 12 : b.fiscalYear > today.getUTCFullYear() ? 0 : today.getUTCMonth() + 1;
  const through = opts.through === null || opts.through === undefined ? defThrough : opts.through;
  if (!Number.isInteger(through) || through < 0 || through > 12) throw refuse("BAD_INPUT", "through is a month 0–12.");
  const [accounts, actuals] = await Promise.all([loadAccountInfo(), plActuals(b.fiscalYear, b.branchId)]);
  const budget = new Map<string, Decimal[]>();
  for (const l of b.lines) {
    const row = budget.get(l.accountId) ?? Array.from({ length: MONTHS }, () => ZERO);
    row[l.month - 1] = new Decimal(l.amount);
    budget.set(l.accountId, row);
  }
  const ids = [...new Set([...budget.keys(), ...actuals.keys()])];
  const zero12 = () => Array.from({ length: MONTHS }, () => ZERO);
  const yearStart = `${b.fiscalYear}-01-01`;
  type Row = { accountId: string; code: string; name: string; nameEn: string; normalBalance: string; group: ReportGroup; budgeted: boolean; months: Cell[]; ytd: Cell; fullYearBudget: string; ledgerHref: string; monthHrefs: string[]; contrib: { budget: Decimal[]; actual: Decimal[] } };
  const rows: Row[] = [];
  for (const id of ids) {
    const a = accounts.get(id);
    if (!a) continue;
    const bud = budget.get(id) ?? zero12();
    const act = actuals.get(id) ?? zero12();
    const credit = a.normalBalance === "CREDIT";
    const ytdB = bud.slice(0, through).reduce((s, x) => s.plus(x), ZERO);
    const ytdA = act.slice(0, through).reduce((s, x) => s.plus(x), ZERO);
    const sgn = credit ? 1 : -1; // contribution to profit
    rows.push({
      accountId: id, code: a.code, name: a.nameAr ?? a.nameEn, nameEn: a.nameEn, normalBalance: a.normalBalance, group: PL_GROUPS.includes(a.group) ? a.group : "OPERATING_EXPENSE",
      budgeted: budget.has(id),
      months: bud.map((x, i) => cell(x, act[i], credit)),
      ytd: cell(ytdB, ytdA, credit),
      fullYearBudget: fix2(bud.reduce((s, x) => s.plus(x), ZERO)),
      ledgerHref: `/dashboard/accounting/reports?view=ledger&accountId=${encodeURIComponent(id)}&from=${yearStart}&to=${dayText(periodRange("month", b.fiscalYear, Math.max(through, 1)).to)}`,
      monthHrefs: Array.from({ length: MONTHS }, (_, i) => { const r = periodRange("month", b.fiscalYear, i + 1); return `/dashboard/accounting/reports?view=ledger&accountId=${encodeURIComponent(id)}&from=${dayText(r.from)}&to=${dayText(r.to)}`; }),
      contrib: { budget: bud.map((x) => x.times(sgn)), actual: act.map((x) => x.times(sgn)) },
    });
  }
  rows.sort((x, y) => x.code.localeCompare(y.code));
  // A section's subtotal is on its own side: revenue as profit contribution, the cost groups as cost (its negation).
  const sumCells = (rs: Row[], side: 1 | -1, label: string) => {
    const mb = zero12(), ma = zero12();
    for (const r of rs) for (let i = 0; i < MONTHS; i++) { mb[i] = mb[i].plus(r.contrib.budget[i].times(side)); ma[i] = ma[i].plus(r.contrib.actual[i].times(side)); }
    const yb = mb.slice(0, through).reduce((s, x) => s.plus(x), ZERO), ya = ma.slice(0, through).reduce((s, x) => s.plus(x), ZERO);
    const credit = side === 1;
    return { label, months: mb.map((x, i) => cell(x, ma[i], credit)), ytd: cell(yb, ya, credit), fullYearBudget: fix2(mb.reduce((s, x) => s.plus(x), ZERO)), raw: { mb, ma } };
  };
  const sections = PL_GROUPS.map((g) => {
    const rs = rows.filter((r) => r.group === g);
    const side: 1 | -1 = g === "REVENUE" ? 1 : -1;
    const t = sumCells(rs, side, g);
    const [ar, en] = GROUP_LABEL[g];
    return { key: g, ar, en, rows: rs.map(({ contrib: _c, ...r }) => { void _c; return r; }), total: { months: t.months, ytd: t.ytd, fullYearBudget: t.fullYearBudget } };
  }).filter((s) => s.rows.length);
  const np = sumCells(rows, 1, "NET_PROFIT");
  const branch = b.branchId ? await prisma.finBranch.findUnique({ where: { id: b.branchId }, select: { id: true, code: true, nameAr: true, nameEn: true } }) : null;
  const { lines: _l, ...h } = b; void _l;
  return {
    budget: { ...headerJson(h), branch },
    through, months: Array.from({ length: MONTHS }, (_, i) => { const r = periodRange("month", b.fiscalYear, i + 1); return { n: i + 1, from: dayText(r.from), to: dayText(r.to) }; }),
    basis: { actuals: "general ledger (posted and reversed entries with their reversals; the year-end closing entry excluded)", branch: b.branchId ? "the branch's journal lines" : "the whole company", sign: "each account on its natural side; variance = actual − budget" },
    sections,
    netProfit: { months: np.months, ytd: np.ytd, fullYearBudget: np.fullYearBudget },
    asOf: dayText(endOfDay(today)),
  };
}
