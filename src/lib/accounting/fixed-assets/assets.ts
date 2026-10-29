// «الأصول الثابتة» — the categories, the register (DRAFT → ACTIVE), capitalisation from a purchase invoice's EXPENSE
// line, additions (capital improvements) and disposals (sale / scrap). Every write runs in one transaction with its
// audit context; each recorded event is a FixedAssetEvent row and, when the books are on, ONE balanced engine entry
// (module "accounting", source FIXED_ASSET / FA_ADDITION / FA_DISPOSAL). Before go-live the register is kept and the
// entry is skipped (the engine's switch — the existing pattern); the opening carries what was skipped (./opening.ts).
//
// Posting rules (council 01 · chief accountant):
//   acquisition (MANUAL)            Dr asset cost                          Cr the account it was paid from
//   capitalisation (PURCHASE_INVOICE) Dr asset cost                        Cr the EXPENSE line's account (a reclass)
//   addition                        Dr asset cost                          Cr the account / the invoice line's account
//   revision (change of estimate)   no entry — a new useful life and / or residual value from its date (prospective)
//   disposal                        Dr depreciation expense (to the day)   Cr accumulated depreciation
//                                   Dr accumulated depreciation (all)      Cr asset cost
//                                   Dr loss on disposal (the net book value; no proceeds)
// Any disposal for value — sale or scrap — is refused (council F1): it needs the e-invoiced sales line «بيع أصل ثابت» (FOLLOWUPS.md) — this
// register never feeds the VAT return itself. Every posting also passes the segregation-of-duties setting (faSod).
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { Decimal, ZERO, roundMoney } from "../money";
import { addDaysUtc, dayText, riyadhDay } from "../dates";
import { setAuditContext, type AuditContext } from "../audit";
import { postEntry, reverseEntry, resolveRoles, type PostingLineInput } from "../posting-engine";
import { opsRefuse } from "../ops/refusals";
import { linesWithCapacity, lockLineCapacity } from "../purchase-line-capacity";
import {
  type Tx, str, f2, dec, money, day, notFuture, intIn, rate, method, attachments, categoryAccounts, checkCategoryAccount, checkCounterAccount,
  glFate, assertPeriodOpen, nextFaNumber, scheduleOf, recordedThrough, lockAsset, openingPendingGuard, categoryAccountsSoft, assertGoLiveFirstOfMonth, faSod,
} from "./common";
import { accumulatedTarget, chargeThrough, isFullyDepreciated, lifeEnd, projection, monthStart, doubleDecliningRate, type Schedule } from "./schedule";

const SRC = (type: string, id: string, event: string) => ({ module: "accounting" as const, type, id, event });
const line = (accountId: string, side: "debit" | "credit", amount: Decimal, description: string, branchId: string | null): PostingLineInput | null =>
  amount.gt(0) ? { accountId, [side]: amount.toFixed(2), description, dims: { branchId } } : null;
const lines = (xs: (PostingLineInput | null)[]) => xs.filter((x): x is PostingLineInput => !!x);

// ─── Categories ───────────────────────────────────────────────────────────────────────────────

export async function listCategories(opts: { all?: boolean } = {}) {
  const rows = await prisma.fixedAssetCategory.findMany({
    where: opts.all ? {} : { isActive: true }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    include: { costAccount: { select: { code: true, nameAr: true, nameEn: true } }, accumAccount: { select: { code: true, nameAr: true, nameEn: true } }, expenseAccount: { select: { code: true, nameAr: true, nameEn: true } }, gainLossAccount: { select: { code: true, nameAr: true, nameEn: true } }, _count: { select: { assets: true } } },
  });
  const roles = await prisma.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: ["FA_COST", "FA_ACCUMULATED_DEPRECIATION", "FA_DEPRECIATION_EXPENSE", "FA_DISPOSAL_GAIN_LOSS"] } }, include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } } });
  const role = (k: string) => { const r = roles.find((x) => x.role === k); return r ? { id: r.account.id, code: r.account.code, name: r.account.nameAr ?? r.account.nameEn } : null; };
  const acc = (a: { code: string; nameAr: string | null; nameEn: string } | null, fallback: ReturnType<typeof role>) => a ? { code: a.code, name: a.nameAr ?? a.nameEn, fromRole: false } : fallback ? { code: fallback.code, name: fallback.name, fromRole: true } : null;
  return {
    roles: { cost: role("FA_COST"), accum: role("FA_ACCUMULATED_DEPRECIATION"), expense: role("FA_DEPRECIATION_EXPENSE"), gainLoss: role("FA_DISPOSAL_GAIN_LOSS") },
    rows: rows.map((c) => ({
      id: c.id, code: c.code, nameAr: c.nameAr, nameEn: c.nameEn, usefulLifeMonths: c.usefulLifeMonths, method: c.method, decliningRatePercent: c.decliningRatePercent ? dec(c.decliningRatePercent).toFixed(4) : null,
      residualPercent: dec(c.residualPercent).toFixed(2), zakatDeductible: c.zakatDeductible, isLeasehold: c.isLeasehold, isActive: c.isActive, assets: c._count.assets,
      costAccountId: c.costAccountId, accumAccountId: c.accumAccountId, expenseAccountId: c.expenseAccountId, gainLossAccountId: c.gainLossAccountId,
      accounts: { cost: acc(c.costAccount, role("FA_COST")), accum: acc(c.accumAccount, role("FA_ACCUMULATED_DEPRECIATION")), expense: acc(c.expenseAccount, role("FA_DEPRECIATION_EXPENSE")), gainLoss: acc(c.gainLossAccount, role("FA_DISPOSAL_GAIN_LOSS")) },
    })),
  };
}

export type CategoryInput = {
  id?: string | null; code?: string; nameAr?: string; nameEn?: string | null; usefulLifeMonths?: number | string; method?: string; decliningRatePercent?: string | number | null;
  residualPercent?: string | number; costAccountId?: string | null; accumAccountId?: string | null; expenseAccountId?: string | null; gainLossAccountId?: string | null;
  zakatDeductible?: boolean; isLeasehold?: boolean; isActive?: boolean;
};

/** Create or edit a category (its defaults apply to assets created after; an asset keeps its own life / method). */
export async function saveCategory(input: CategoryInput, ctx: AuditContext) {
  const code = str(input?.code, 40)?.toUpperCase() ?? null;
  const nameAr = str(input?.nameAr, 120);
  if (!nameAr || (!input?.id && (!code || !/^[A-Z0-9_]{2,40}$/.test(code)))) throw opsRefuse("FA_CATEGORY_INVALID");
  let life: number;
  try { life = intIn(input.usefulLifeMonths, 1, 1200, "usefulLifeMonths"); } catch { throw opsRefuse("FA_CATEGORY_INVALID"); }
  const m = (() => { try { return method(input.method); } catch { throw opsRefuse("FA_CATEGORY_INVALID"); } })();
  const dbRate = m === "DECLINING_BALANCE" ? (input.decliningRatePercent === null || input.decliningRatePercent === undefined || input.decliningRatePercent === "" ? doubleDecliningRate(life) : rate(input.decliningRatePercent)) : null;
  let residual: Decimal;
  try { residual = dec(String(input.residualPercent ?? "0")); } catch { throw opsRefuse("FA_CATEGORY_INVALID"); }
  if (residual.isNegative() || !residual.lt(100) || !residual.equals(residual.toDecimalPlaces(2))) throw opsRefuse("FA_CATEGORY_INVALID");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const data = {
      nameAr, nameEn: str(input.nameEn, 120), usefulLifeMonths: life, method: m, decliningRatePercent: dbRate, residualPercent: residual,
      costAccountId: await checkCategoryAccount(tx, str(input.costAccountId, 64), "cost"), accumAccountId: await checkCategoryAccount(tx, str(input.accumAccountId, 64), "accum"),
      expenseAccountId: await checkCategoryAccount(tx, str(input.expenseAccountId, 64), "expense"), gainLossAccountId: await checkCategoryAccount(tx, str(input.gainLossAccountId, 64), "gainLoss"),
      zakatDeductible: input.zakatDeductible !== false, isLeasehold: input.isLeasehold === true, isActive: input.isActive !== false, updatedBy: ctx.actorId,
    };
    if (data.isLeasehold && life > LEASEHOLD_MAX_MONTHS) throw opsRefuse("FA_LEASE_TERM");
    if (input.id) {
      const cur = await tx.fixedAssetCategory.findUnique({ where: { id: input.id } });
      if (!cur) throw opsRefuse("OPS_NOT_FOUND");
      return tx.fixedAssetCategory.update({ where: { id: input.id }, data });
    }
    if (await tx.fixedAssetCategory.findUnique({ where: { code: code as string } })) throw opsRefuse("FA_CATEGORY_CODE_EXISTS");
    const sortOrder = ((await tx.fixedAssetCategory.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1;
    return tx.fixedAssetCategory.create({ data: { ...data, code: code as string, sortOrder, createdBy: ctx.actorId } });
  }, TX_OPTS);
}

// ─── Leasehold improvements (council F5) ──────────────────────────────────────────────────────

/** «الأقل من 5 سنوات ومدة العقد»: the life of a leasehold improvement is at most 60 months and ends by the lease end. */
export const LEASEHOLD_MAX_MONTHS = 60;

export function checkLeaseTerm(cat: { isLeasehold: boolean }, life: number, inServiceDate: Date | null, leaseEndDate: Date | null): void {
  if (!cat.isLeasehold) return;
  if (!leaseEndDate || life > LEASEHOLD_MAX_MONTHS) throw opsRefuse("FA_LEASE_TERM");
  if (inServiceDate && lifeEnd({ inServiceDate, usefulLifeMonths: life }) > leaseEndDate) throw opsRefuse("FA_LEASE_TERM", `(${dayText(leaseEndDate)})`, `(${dayText(leaseEndDate)})`);
}

/** The asset's Zakat treatment: its own flag, else its category's (council F4). */
export const zakatDeductibleOf = (a: { zakatDeductible: boolean | null; category: { zakatDeductible: boolean } }) => a.zakatDeductible ?? a.category.zakatDeductible;

// ─── Capitalisable purchase-invoice lines ─────────────────────────────────────────────────────
// One capacity per purchase line, shared with «قوالب التأجيل» (council F1): src/lib/accounting/purchase-line-capacity.ts.

export { lineCapacity } from "../purchase-line-capacity";

/** The EXPENSE lines of posted purchase invoices that still have capacity (newest first), with what uses them. */
export async function capitalisableLines(opts: { supplierId?: string | null } = {}) {
  return linesWithCapacity(opts);
}

/**
 * The line to capitalise from, locked (the shared row lock); its remaining capacity — after every capitalisation AND
 * every deferral schedule made from it — covers `amount`. Returns the account the invoice debited (the expense
 * category's — verified on the invoice's entry when it posted) and whether the invoice is in the books.
 */
async function invoiceLineFor(tx: Tx, lineId: unknown, amount: Decimal, on: Date) {
  const id = str(lineId, 64);
  if (!id) throw opsRefuse("FA_INVOICE_LINE");
  const c = await lockLineCapacity(tx, id);
  const l = c?.line;
  if (!c || !l || l.kind !== "EXPENSE" || l.invoice.status !== "POSTED" || !l.expenseCategory) throw opsRefuse("FA_INVOICE_LINE");
  if (on < l.invoice.invoiceDate) throw opsRefuse("FA_INVALID", "The date is on or after the invoice date.", "التاريخ في تاريخ الفاتورة أو بعده.");
  if (!amount.gt(0) || amount.gt(c.remaining)) {
    const why = c.used.deferrals.gt(0) ? ` (${c.remaining.toFixed(2)}; deferred ${c.used.deferrals.toFixed(2)})` : c.remaining.toFixed(2);
    const whyAr = c.used.deferrals.gt(0) ? ` (${c.remaining.toFixed(2)}؛ مستخدم في تأجيل ${c.used.deferrals.toFixed(2)})` : c.remaining.toFixed(2);
    throw opsRefuse("FA_INVOICE_AMOUNT", why, whyAr);
  }
  const accountId = l.expenseCategory.accountId;
  if (l.invoice.journalEntryId) {
    const hit = await tx.journalEntryLine.count({ where: { journalEntryId: l.invoice.journalEntryId, accountId, debit: { gt: 0 } } });
    if (!hit) throw opsRefuse("FA_INVOICE_ACCOUNT_CHANGED");
  }
  return { line: l, accountId, inBooks: !!l.invoice.journalEntryId };
}

// ─── The register ─────────────────────────────────────────────────────────────────────────────

const ASSET_INCLUDE = {
  category: { select: { id: true, code: true, nameAr: true, nameEn: true, zakatDeductible: true, isLeasehold: true } },
  branch: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  supplier: { select: { id: true, name: true } },
  supplierInvoice: { select: { id: true, number: true, supplierRef: true } },
  counterAccount: { select: { id: true, code: true, nameAr: true, nameEn: true } },
} satisfies Prisma.FixedAssetInclude;
type AssetFull = Prisma.FixedAssetGetPayload<{ include: typeof ASSET_INCLUDE }>;

export function assetView(a: AssetFull) {
  const nbv = dec(a.cost).minus(a.accumulatedDepreciation);
  const live = a.status !== "DRAFT" && a.inServiceDate && a.basisDate;
  const end = a.inServiceDate ? lifeEnd({ inServiceDate: a.inServiceDate, usefulLifeMonths: a.usefulLifeMonths }) : null;
  return {
    id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, status: a.status, category: a.category, branch: a.branch, location: a.location, supplier: a.supplier,
    supplierInvoice: a.supplierInvoice, supplierInvoiceLineId: a.supplierInvoiceLineId, acquisitionKind: a.acquisitionKind, counterAccount: a.counterAccount,
    acquisitionDate: dayText(a.acquisitionDate), inServiceDate: a.inServiceDate ? dayText(a.inServiceDate) : null, lifeEnd: end ? dayText(end) : null,
    cost: f2(a.cost), residualValue: f2(a.residualValue), usefulLifeMonths: a.usefulLifeMonths, method: a.method, decliningRatePercent: a.decliningRatePercent ? dec(a.decliningRatePercent).toFixed(4) : null,
    openingAccumulated: f2(a.openingAccumulated), accumulatedDepreciation: f2(a.accumulatedDepreciation), netBookValue: a.status === "DISPOSED" ? "0.00" : nbv.toFixed(2),
    depreciatedThrough: a.depreciatedThrough ? dayText(a.depreciatedThrough) : null, serialNumber: a.serialNumber, custodianEmployeeId: a.custodianEmployeeId,
    attachments: (a.attachments as { name: string; url: string }[] | null) ?? [], notes: a.notes,
    zakatDeductible: a.zakatDeductible, zakatDeductibleEffective: zakatDeductibleOf(a), leaseEndDate: a.leaseEndDate ? dayText(a.leaseEndDate) : null, activatedAt: a.activatedAt?.toISOString() ?? null, activatedBy: a.activatedBy,
    createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
    nextMonth: live ? (() => { const s = scheduleOf(a); const from = monthStart(addDaysUtc(recordedThrough(a) as Date, 1)); return projection(s, dec(a.accumulatedDepreciation), recordedThrough(a), from, 1)[0] ?? null; })() : null,
  };
}

export async function listAssets(q: { status?: string | null; categoryId?: string | null; branchId?: string | null; search?: string | null; take?: number; skip?: number } = {}) {
  const where: Prisma.FixedAssetWhereInput = {
    // categoryId / branchId: one id, or several separated by commas (the filter card's multi-select).
    ...(q.status && q.status !== "ALL" ? { status: q.status } : {}), ...(q.categoryId ? { categoryId: { in: q.categoryId.split(",").filter(Boolean) } } : {}), ...(q.branchId ? { branchId: { in: q.branchId.split(",").filter(Boolean) } } : {}),
    ...(q.search ? { OR: [{ code: { contains: q.search, mode: "insensitive" } }, { nameAr: { contains: q.search } }, { nameEn: { contains: q.search, mode: "insensitive" } }, { serialNumber: { contains: q.search, mode: "insensitive" } }] } : {}),
  };
  const [rows, total, sums] = await Promise.all([
    prisma.fixedAsset.findMany({ where, include: ASSET_INCLUDE, orderBy: [{ code: "asc" }], take: Math.min(q.take ?? 50, 200), skip: q.skip ?? 0 }),
    prisma.fixedAsset.count({ where }),
    prisma.fixedAsset.groupBy({ by: ["status"], _count: { _all: true }, _sum: { cost: true, accumulatedDepreciation: true } }),
  ]);
  const live = sums.filter((s) => s.status === "ACTIVE" || s.status === "FULLY_DEPRECIATED");
  const cost = live.reduce((t, s) => t.plus(s._sum.cost ?? 0), ZERO), acc = live.reduce((t, s) => t.plus(s._sum.accumulatedDepreciation ?? 0), ZERO);
  return {
    total, rows: rows.map(assetView),
    summary: { byStatus: Object.fromEntries(sums.map((s) => [s.status, s._count._all])), cost: cost.toFixed(2), accumulated: acc.toFixed(2), netBookValue: cost.minus(acc).toFixed(2) },
  };
}

export async function getAsset(id: string) {
  const a = await prisma.fixedAsset.findUnique({ where: { id }, include: { ...ASSET_INCLUDE, events: { orderBy: [{ eventDate: "asc" }, { createdAt: "asc" }] }, additions: { orderBy: { createdAt: "asc" } }, disposals: { orderBy: { createdAt: "asc" } }, depreciationLines: { orderBy: { toDate: "asc" }, include: { run: { select: { number: true, status: true } } } } } });
  if (!a) throw opsRefuse("FA_NOT_FOUND");
  const custodian = a.custodianEmployeeId ? await prisma.hrEmployee.findUnique({ where: { id: a.custodianEmployeeId }, select: { id: true, fullNameAr: true, fullNameEn: true, employeeNo: true } }).catch(() => null) : null;
  const live = (a.status === "ACTIVE" || a.status === "FULLY_DEPRECIATED") && a.inServiceDate && a.basisDate;
  const s = live ? scheduleOf(a) : null;
  const through = recordedThrough(a);
  const sched = s && through ? projection(s, dec(a.accumulatedDepreciation), through, monthStart(addDaysUtc(through, 1)), 24) : [];
  const accounts = await categoryAccountsSoft(prisma, await prisma.fixedAssetCategory.findUniqueOrThrow({ where: { id: a.categoryId } }));
  return {
    ...assetView(a), custodian, accounts,
    events: a.events.map((e) => ({ id: e.id, kind: e.kind, eventDate: dayText(e.eventDate), costDelta: f2(e.costDelta), accumDelta: f2(e.accumDelta), sourceType: e.sourceType, sourceId: e.sourceId, reversal: !!e.reversesEventId, glState: e.glState, journalEntryId: e.journalEntryId })),
    additions: a.additions.map(additionView), disposals: a.disposals.map(disposalView),
    depreciation: a.depreciationLines.map((l) => ({ id: l.id, runId: l.runId, run: l.run.number, runStatus: l.run.status, periodKey: l.periodKey, fromDate: dayText(l.fromDate), toDate: dayText(l.toDate), amount: f2(l.amount), voided: !!l.voidedAt })),
    projection: sched,
  };
}

export type AssetInput = {
  code?: string | null; nameAr?: string; nameEn?: string | null; categoryId?: string; branchId?: string | null; location?: string | null; supplierId?: string | null;
  acquisitionKind?: string; supplierInvoiceLineId?: string | null; counterAccountId?: string | null; acquisitionDate?: string; inServiceDate?: string | null;
  cost?: string | number; residualValue?: string | number | null; usefulLifeMonths?: string | number | null; method?: string | null; decliningRatePercent?: string | number | null;
  openingAccumulated?: string | number | null; serialNumber?: string | null; custodianEmployeeId?: string | null; attachments?: unknown; notes?: string | null;
  /** null / "" = the category's; true / false overrides it. */
  zakatDeductible?: boolean | string | null; leaseEndDate?: string | null;
};

/** The per-asset Zakat override from a form / JSON value: null (the category's), true or false. */
function zakatFlag(v: unknown, cur: boolean | null = null): boolean | null {
  if (v === undefined) return cur;
  if (v === null || v === "" || v === "CATEGORY") return null;
  if (v === true || v === "true" || v === "DEDUCTED") return true;
  if (v === false || v === "false" || v === "NOT_DEDUCTED") return false;
  throw opsRefuse("FA_INVALID", "zakatDeductible is null, true or false.", "معالجة الزكاة: حسب التصنيف أو مخصوم أو غير مخصوم.");
}

async function cleanAsset(tx: Tx, input: AssetInput, cur: { categoryId: string } | null) {
  const nameAr = str(input?.nameAr, 200);
  if (!nameAr) throw opsRefuse("FA_INVALID", "nameAr.", "اسم الأصل مطلوب.");
  const categoryId = str(input.categoryId, 64) ?? cur?.categoryId ?? null;
  const cat = categoryId ? await tx.fixedAssetCategory.findUnique({ where: { id: categoryId } }) : null;
  if (!cat || (!cat.isActive && cat.id !== cur?.categoryId)) throw opsRefuse("FA_INVALID", "Choose an active category.", "اختر فئة نشطة.");
  const kind = String(input.acquisitionKind ?? "MANUAL");
  if (!["PURCHASE_INVOICE", "MANUAL", "OPENING"].includes(kind)) throw opsRefuse("FA_INVALID", "acquisitionKind.", "طريقة الاقتناء.");
  const acquisitionDate = day(input.acquisitionDate, "acquisitionDate");
  notFuture(acquisitionDate);
  const inServiceDate = input.inServiceDate ? day(input.inServiceDate, "inServiceDate") : null;
  if (inServiceDate && inServiceDate < acquisitionDate) throw opsRefuse("FA_INVALID", "The in-service date is on or after the acquisition date.", "تاريخ بدء الاستخدام في تاريخ الاقتناء أو بعده.");
  const cost = money(input.cost, "cost", { allowZero: true });
  const life = input.usefulLifeMonths === null || input.usefulLifeMonths === undefined || input.usefulLifeMonths === "" ? cat.usefulLifeMonths : intIn(input.usefulLifeMonths, 1, 1200, "usefulLifeMonths");
  const m = input.method ? method(input.method) : (cat.method as "STRAIGHT_LINE" | "DECLINING_BALANCE");
  const dbRate = m === "DECLINING_BALANCE" ? (input.decliningRatePercent ? rate(input.decliningRatePercent) : cat.decliningRatePercent ? dec(cat.decliningRatePercent) : doubleDecliningRate(life)) : null;
  const residual = input.residualValue === null || input.residualValue === undefined || input.residualValue === "" ? roundMoney(cost.times(cat.residualPercent).div(100)) : money(input.residualValue, "residualValue", { allowZero: true });
  if (residual.gt(cost)) throw opsRefuse("FA_RESIDUAL");
  const openingAccumulated = kind === "OPENING" ? money(input.openingAccumulated ?? "0", "openingAccumulated", { allowZero: true }) : null;
  if (openingAccumulated && openingAccumulated.gt(cost.minus(residual))) throw opsRefuse("FA_RESIDUAL");
  const branchId = str(input.branchId, 64);
  if (branchId && !(await tx.finBranch.findUnique({ where: { id: branchId }, select: { id: true } }))) throw opsRefuse("FA_INVALID", "branch.", "الفرع غير موجود.");
  let supplierId = str(input.supplierId, 64);
  if (supplierId && !(await tx.supplier.findUnique({ where: { id: supplierId }, select: { id: true } }))) throw opsRefuse("FA_INVALID", "supplier.", "المورد غير موجود.");
  const custodianEmployeeId = str(input.custodianEmployeeId, 64);
  if (custodianEmployeeId && !(await tx.hrEmployee.findUnique({ where: { id: custodianEmployeeId }, select: { id: true } }))) throw opsRefuse("FA_INVALID", "custodian.", "الموظف المسؤول غير موجود.");
  let supplierInvoiceId: string | null = null, supplierInvoiceLineId: string | null = null;
  if (kind === "PURCHASE_INVOICE") {
    supplierInvoiceLineId = str(input.supplierInvoiceLineId, 64);
    const l = supplierInvoiceLineId ? await tx.supplierInvoiceLine.findUnique({ where: { id: supplierInvoiceLineId }, select: { kind: true, invoice: { select: { id: true, supplierId: true, status: true } } } }) : null;
    if (!l || l.kind !== "EXPENSE" || l.invoice.status !== "POSTED") throw opsRefuse("FA_INVOICE_LINE");
    supplierInvoiceId = l.invoice.id;
    supplierId = l.invoice.supplierId;
  }
  const counterAccountId = kind === "MANUAL" && input.counterAccountId ? await checkCounterAccount(tx, input.counterAccountId) : null;
  const leaseEndDate = cat.isLeasehold && input.leaseEndDate ? day(input.leaseEndDate, "leaseEndDate") : null;
  if (leaseEndDate && !(leaseEndDate > acquisitionDate)) throw opsRefuse("FA_LEASE_TERM");
  checkLeaseTerm(cat, life, inServiceDate, leaseEndDate);
  return {
    nameAr, nameEn: str(input.nameEn, 200), categoryId: cat.id, branchId, location: str(input.location, 200), supplierId, supplierInvoiceId, supplierInvoiceLineId,
    acquisitionKind: kind, counterAccountId, acquisitionDate, inServiceDate, cost, residualValue: residual, usefulLifeMonths: life, method: m, decliningRatePercent: dbRate,
    openingAccumulated, serialNumber: str(input.serialNumber, 120), custodianEmployeeId, attachments: attachments(input.attachments), notes: str(input.notes, 2000),
    zakatDeductible: zakatFlag(input.zakatDeductible), leaseEndDate,
  };
}

/** A new DRAFT asset (nothing reaches the books until it is activated). A blank code gets the next «FA-YYYY-NNNNNN». */
export async function createAsset(input: AssetInput, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const data = await cleanAsset(tx, input, null);
    let code = str(input.code, 40);
    if (code && (await tx.fixedAsset.findUnique({ where: { code } }))) throw opsRefuse("FA_INVALID", "The code is used by another asset.", "الرمز مستخدم لأصل آخر.");
    if (!code) code = await nextFaNumber(tx, "FA", riyadhDay());
    const a = await tx.fixedAsset.create({ data: { ...data, code, status: "DRAFT", createdBy: ctx.actorId, updatedBy: ctx.actorId }, include: ASSET_INCLUDE });
    return assetView(a);
  }, TX_OPTS);
}

/**
 * Edit an asset. A DRAFT: everything. An asset in the books: only what does not change its amounts or schedule
 * (names, branch, location, serial number, custodian, attachments, notes — the database freezes the rest).
 */
export async function updateAsset(id: string, input: AssetInput, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const cur = await lockAsset(tx, id);
    if (cur.status === "DRAFT") {
      const data = await cleanAsset(tx, input, cur);
      const code = str(input.code, 40) ?? cur.code;
      if (code !== cur.code && (await tx.fixedAsset.findUnique({ where: { code } }))) throw opsRefuse("FA_INVALID", "The code is used by another asset.", "الرمز مستخدم لأصل آخر.");
      return assetView(await tx.fixedAsset.update({ where: { id }, data: { ...data, code, updatedBy: ctx.actorId }, include: ASSET_INCLUDE }));
    }
    if (cur.status === "DISPOSED") throw opsRefuse("FA_STATE");
    const nameAr = input.nameAr !== undefined ? str(input.nameAr, 200) : cur.nameAr;
    if (!nameAr) throw opsRefuse("FA_INVALID", "nameAr.", "اسم الأصل مطلوب.");
    const branchId = input.branchId !== undefined ? str(input.branchId, 64) : cur.branchId;
    if (branchId && !(await tx.finBranch.findUnique({ where: { id: branchId }, select: { id: true } }))) throw opsRefuse("FA_INVALID", "branch.", "الفرع غير موجود.");
    const custodianEmployeeId = input.custodianEmployeeId !== undefined ? str(input.custodianEmployeeId, 64) : cur.custodianEmployeeId;
    if (custodianEmployeeId && custodianEmployeeId !== cur.custodianEmployeeId && !(await tx.hrEmployee.findUnique({ where: { id: custodianEmployeeId }, select: { id: true } }))) throw opsRefuse("FA_INVALID", "custodian.", "الموظف المسؤول غير موجود.");
    return assetView(await tx.fixedAsset.update({ where: { id }, data: {
      nameAr, nameEn: input.nameEn !== undefined ? str(input.nameEn, 200) : cur.nameEn, branchId, location: input.location !== undefined ? str(input.location, 200) : cur.location,
      serialNumber: input.serialNumber !== undefined ? str(input.serialNumber, 120) : cur.serialNumber, custodianEmployeeId,
      ...(input.attachments !== undefined ? { attachments: attachments(input.attachments) ?? [] } : {}), notes: input.notes !== undefined ? str(input.notes, 2000) : cur.notes,
      zakatDeductible: zakatFlag(input.zakatDeductible, cur.zakatDeductible), updatedBy: ctx.actorId,
    }, include: ASSET_INCLUDE }));
  }, TX_OPTS);
}

export async function deleteDraft(id: string, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const cur = await lockAsset(tx, id);
    if (cur.status !== "DRAFT") throw opsRefuse("FA_KEPT");
    await tx.fixedAsset.delete({ where: { id } });
    return { deleted: true };
  }, TX_OPTS);
}

/**
 * «تفعيل الأصل»: the asset enters the register — its acquisition is recorded (ACQUISITION, or OPENING at go-live) and,
 * when the books are on, posted: MANUAL Dr cost / Cr the paying account; PURCHASE_INVOICE Dr cost / Cr the expense
 * account the invoice debited (a reclass; skipped — like the invoice — when the invoice is not in the books);
 * OPENING no entry (the opening balances carry it). Depreciation starts on the in-service date.
 */
export async function activateAsset(id: string, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const a = await lockAsset(tx, id);
    if (a.status !== "DRAFT") throw opsRefuse("FA_STATE");
    if (!a.inServiceDate) throw opsRefuse("FA_INVALID", "The in-service date is required.", "تاريخ بدء الاستخدام مطلوب.");
    const cost = dec(a.cost), residual = dec(a.residualValue);
    if (!cost.gt(0)) throw opsRefuse("FA_INVALID", "cost is above zero.", "التكلفة أكبر من صفر.");
    if (a.inServiceDate > riyadhDay()) throw opsRefuse("FA_FUTURE_DATE");
    checkLeaseTerm(a.category, a.usefulLifeMonths, a.inServiceDate, a.leaseEndDate);
    const now = new Date();
    if (a.acquisitionKind === "OPENING") {
      const st = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { goLiveDate: true, openingEntryId: true } });
      if (!st?.goLiveDate) throw opsRefuse("FA_GO_LIVE_REQUIRED");
      assertGoLiveFirstOfMonth(st.goLiveDate);
      if (st.openingEntryId) throw opsRefuse("FA_OPENING_FINAL");
      if (!(a.inServiceDate < st.goLiveDate) || !(a.acquisitionDate < st.goLiveDate)) throw opsRefuse("FA_INVALID", "An opening asset was acquired and in service before the go-live date.", "الأصل الافتتاحي اقتُني وبدأ استخدامه قبل تاريخ بدء المحاسبة.");
      const accum = dec(a.openingAccumulated ?? 0);
      const eve = addDaysUtc(st.goLiveDate, -1);
      await tx.fixedAssetEvent.create({ data: { assetId: id, kind: "OPENING", eventDate: eve, costDelta: cost, accumDelta: accum, sourceType: "ASSET", sourceId: id, glState: "OPENING", createdBy: ctx.actorId } });
      await tx.fixedAsset.update({ where: { id }, data: {
        status: isFullyDepreciated(cost, residual, accum) ? "FULLY_DEPRECIATED" : "ACTIVE", accumulatedDepreciation: accum, depreciatedThrough: eve, basisDate: st.goLiveDate, basisAccumulated: accum,
        activatedAt: now, activatedBy: ctx.actorId, updatedBy: ctx.actorId } });
      return { asset: assetView(await tx.fixedAsset.findUniqueOrThrow({ where: { id }, include: ASSET_INCLUDE })), glState: "OPENING", journalEntryId: null };
    }
    const d = a.acquisitionDate;
    await assertPeriodOpen(tx, d);
    const fate = await glFate(tx, d);
    const acc = await categoryAccounts(tx, a.category, fate.post ? ["cost"] : []);
    let counter = "", post = fate.post;
    if (a.acquisitionKind === "MANUAL") {
      // The paying account is needed when the entry posts; before go-live (no chart yet) the opening carries the asset.
      if (post || a.counterAccountId) counter = await checkCounterAccount(tx, a.counterAccountId);
    } else {
      const inv = await invoiceLineFor(tx, a.supplierInvoiceLineId, cost, d);
      counter = inv.accountId;
      // The invoice never reached the books (skipped before go-live): neither does its reclass — the opening carries the asset.
      if (!inv.inBooks) { if (fate.openingPosted) throw opsRefuse("FA_INVOICE_NOT_IN_BOOKS"); post = false; }
    }
    let journalEntryId: string | null = null;
    if (post) {
      // The asset's preparer (who entered or last edited the draft) activating it: the segregation-of-duties setting.
      const sodBypass = await faSod(tx, ctx.actorId, [a.createdBy, a.updatedBy]);
      const r = await postEntry(tx, {
        source: SRC("FIXED_ASSET", id, "ACQUIRED"), date: dayText(d), createdBy: ctx.actorId, sodBypass, memo: `اقتناء أصل ثابت ${a.code} · ${a.nameAr}`,
        lines: lines([line(acc.cost, "debit", cost, `تكلفة الأصل ${a.code}`, a.branchId), line(counter, "credit", cost, a.acquisitionKind === "MANUAL" ? `سداد الأصل ${a.code}` : `رسملة مصروف إلى الأصل ${a.code}`, a.branchId)]),
      });
      if (r.status === "posted") journalEntryId = r.entryId;
    }
    await tx.fixedAssetEvent.create({ data: { assetId: id, kind: "ACQUISITION", eventDate: d, costDelta: cost, sourceType: "ASSET", sourceId: id, glState: journalEntryId ? "POSTED" : "SKIPPED", journalEntryId, createdBy: ctx.actorId } });
    await tx.fixedAsset.update({ where: { id }, data: {
      status: isFullyDepreciated(cost, residual, ZERO) ? "FULLY_DEPRECIATED" : "ACTIVE", basisDate: a.inServiceDate, basisAccumulated: ZERO, activatedAt: now, activatedBy: ctx.actorId, updatedBy: ctx.actorId } });
    return { asset: assetView(await tx.fixedAsset.findUniqueOrThrow({ where: { id }, include: ASSET_INCLUDE })), glState: journalEntryId ? "POSTED" : "SKIPPED", journalEntryId };
  }, TX_OPTS);
}

// ─── Additions ────────────────────────────────────────────────────────────────────────────────

export type AdditionInput = { additionDate?: string; amount?: string | number; kind?: string; supplierInvoiceLineId?: string | null; counterAccountId?: string | null; description?: string; newUsefulLifeMonths?: number | string | null; newResidualValue?: string | number | null };

type Before = { cost: string; residualValue: string; usefulLifeMonths: number; basisDate: string; basisAccumulated: string; status: string; accumulatedDepreciation: string; depreciatedThrough: string | null };
const beforeOf = (a: { cost: Prisma.Decimal; residualValue: Prisma.Decimal; usefulLifeMonths: number; basisDate: Date | null; basisAccumulated: Prisma.Decimal | null; status: string; accumulatedDepreciation: Prisma.Decimal; depreciatedThrough: Date | null }): Before => ({
  cost: dec(a.cost).toFixed(2), residualValue: dec(a.residualValue).toFixed(2), usefulLifeMonths: a.usefulLifeMonths, basisDate: dayText(a.basisDate as Date), basisAccumulated: dec(a.basisAccumulated ?? 0).toFixed(2),
  status: a.status, accumulatedDepreciation: dec(a.accumulatedDepreciation).toFixed(2), depreciatedThrough: a.depreciatedThrough ? dayText(a.depreciatedThrough) : null,
});

export function additionView(x: { id: string; number: string; additionDate: Date; amount: Prisma.Decimal; kind: string; description: string; newUsefulLifeMonths: number | null; newResidualValue: Prisma.Decimal | null; status: string; glState: string; journalEntryId: string | null; supplierInvoiceId: string | null; counterAccountId: string | null; cancelReason: string | null; createdAt: Date; createdBy: string }) {
  return { id: x.id, number: x.number, additionDate: dayText(x.additionDate), amount: f2(x.amount), kind: x.kind, description: x.description, newUsefulLifeMonths: x.newUsefulLifeMonths, newResidualValue: f2(x.newResidualValue), status: x.status, glState: x.glState, journalEntryId: x.journalEntryId, supplierInvoiceId: x.supplierInvoiceId, counterAccountId: x.counterAccountId, cancelReason: x.cancelReason, createdAt: x.createdAt.toISOString(), createdBy: x.createdBy };
}

/**
 * «إضافة رأسمالية»: the cost rises by the amount (Dr cost / Cr the paying account or the invoice line's account) and the
 * remaining depreciation is recomputed from the addition's date (a new basis: the accumulated depreciation then —
 * recorded or still to run — is carried; the remaining depreciable amount spreads over the remaining life, or a new
 * life / residual value the accountant gives). Dated after the depreciation already recorded.
 *
 * kind REVISION (council F6) — «تعديل تقدير»: no amount and no entry; only a new useful life and / or residual value,
 * applied prospectively from its date (IAS 8.36 / IAS 16.51: a change in estimate) — the same new basis, audited (the
 * row keeps the schedule before; the audit trail records who and why) and cancelled like an addition.
 */
export async function addAddition(assetId: string, input: AdditionInput, ctx: AuditContext) {
  const kind = String(input?.kind ?? "MANUAL");
  if (kind !== "MANUAL" && kind !== "PURCHASE_INVOICE" && kind !== "REVISION") throw opsRefuse("FA_INVALID", "kind.", "نوع الإضافة.");
  const revision = kind === "REVISION";
  if (revision && input?.amount !== undefined && input.amount !== null && input.amount !== "" && !dec(money(input.amount, "amount", { allowZero: true })).isZero()) {
    throw opsRefuse("FA_INVALID", "A change of estimate has no amount.", "تعديل التقدير بلا مبلغ.");
  }
  const amount = revision ? ZERO : money(input?.amount, "amount");
  const d = day(input?.additionDate, "additionDate");
  notFuture(d);
  const description = str(input?.description, 500);
  if (!description) throw opsRefuse("FA_INVALID", "description.", "وصف الإضافة مطلوب.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? description });
    const a = await lockAsset(tx, assetId);
    if (a.status !== "ACTIVE" && a.status !== "FULLY_DEPRECIATED") throw opsRefuse("FA_STATE");
    const through = recordedThrough(a) as Date;
    if (d < (a.inServiceDate as Date) || d <= through) throw opsRefuse("FA_DATE_ORDER");
    await assertPeriodOpen(tx, d);
    const fate = await glFate(tx, d);
    const old = scheduleOf(a);
    const newLife = input.newUsefulLifeMonths === null || input.newUsefulLifeMonths === undefined || input.newUsefulLifeMonths === "" ? a.usefulLifeMonths : intIn(input.newUsefulLifeMonths, 1, 1200, "newUsefulLifeMonths");
    const newCost = dec(a.cost).plus(amount);
    const newResidual = input.newResidualValue === null || input.newResidualValue === undefined || input.newResidualValue === "" ? dec(a.residualValue) : money(input.newResidualValue, "newResidualValue", { allowZero: true });
    if (revision && newLife === a.usefulLifeMonths && newResidual.equals(a.residualValue)) throw opsRefuse("FA_REVISION_EMPTY");
    const basisAccumulated = accumulatedTarget(old, addDaysUtc(d, -1));
    if (newResidual.gt(newCost) || basisAccumulated.gt(newCost.minus(newResidual)) || dec(a.accumulatedDepreciation).gt(newCost.minus(newResidual))) throw opsRefuse("FA_RESIDUAL");
    if (d > lifeEnd({ inServiceDate: a.inServiceDate as Date, usefulLifeMonths: newLife })) throw opsRefuse("FA_LIFE_ENDED");
    checkLeaseTerm(a.category, newLife, a.inServiceDate, a.leaseEndDate);
    let counter = "", post = fate.post && !revision, supplierInvoiceId: string | null = null, supplierInvoiceLineId: string | null = null;
    if (kind === "MANUAL") { if (post || input.counterAccountId) counter = await checkCounterAccount(tx, input.counterAccountId); }
    else if (kind === "PURCHASE_INVOICE") {
      const inv = await invoiceLineFor(tx, input.supplierInvoiceLineId, amount, d);
      counter = inv.accountId; supplierInvoiceId = inv.line.invoice.id; supplierInvoiceLineId = inv.line.id;
      if (!inv.inBooks) { if (fate.openingPosted) throw opsRefuse("FA_INVOICE_NOT_IN_BOOKS"); post = false; }
    }
    const acc = await categoryAccounts(tx, a.category, post ? ["cost"] : []);
    const id = `faa_${randomUUID().replace(/-/g, "")}`;
    const number = await nextFaNumber(tx, "FAA", d);
    let journalEntryId: string | null = null;
    if (post) {
      // Entered and posted in one act: the segregation-of-duties setting decides (and the entry records it).
      const sodBypass = await faSod(tx, ctx.actorId, [ctx.actorId]);
      const r = await postEntry(tx, { source: SRC("FA_ADDITION", id, "POSTED"), date: dayText(d), createdBy: ctx.actorId, sodBypass, memo: `إضافة رأسمالية ${number} للأصل ${a.code} · ${description}`.slice(0, 500),
        lines: lines([line(acc.cost, "debit", amount, `إضافة رأسمالية ${a.code}`, a.branchId), line(counter, "credit", amount, `إضافة رأسمالية ${a.code}`, a.branchId)]) });
      if (r.status === "posted") journalEntryId = r.entryId;
    }
    const glState = revision ? "NONE" : journalEntryId ? "POSTED" : "SKIPPED";
    await tx.fixedAssetAddition.create({ data: {
      id, number, assetId, additionDate: d, amount, kind, supplierInvoiceId, supplierInvoiceLineId, counterAccountId: kind === "MANUAL" && counter ? counter : null, description,
      newUsefulLifeMonths: newLife !== a.usefulLifeMonths ? newLife : null, newResidualValue: newResidual.equals(a.residualValue) ? null : newResidual,
      before: beforeOf(a), glState, journalEntryId, createdBy: ctx.actorId } });
    if (!revision) await tx.fixedAssetEvent.create({ data: { assetId, kind: "ADDITION", eventDate: d, costDelta: amount, sourceType: "ADDITION", sourceId: id, glState, journalEntryId, createdBy: ctx.actorId } });
    const accum = dec(a.accumulatedDepreciation);
    await tx.fixedAsset.update({ where: { id: assetId }, data: {
      cost: newCost, residualValue: newResidual, usefulLifeMonths: newLife, basisDate: d, basisAccumulated,
      status: isFullyDepreciated(newCost, newResidual, accum) ? "FULLY_DEPRECIATED" : "ACTIVE", updatedBy: ctx.actorId } });
    return { addition: additionView(await tx.fixedAssetAddition.findUniqueOrThrow({ where: { id } })), asset: assetView(await tx.fixedAsset.findUniqueOrThrow({ where: { id: assetId }, include: ASSET_INCLUDE })) };
  }, TX_OPTS);
}

/** Cancel the asset's latest change when it is an addition with nothing recorded after it: its entry reversed (dated the addition's day), the schedule restored. */
export async function cancelAddition(additionId: string, reason: string, ctx: AuditContext) {
  const r = str(reason, 500);
  if (!r || r.length < 3) throw opsRefuse("OPS_BAD_INPUT", "A reason is required.", "السبب مطلوب.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    const head = await tx.fixedAssetAddition.findUnique({ where: { id: additionId }, select: { assetId: true } });
    if (!head) throw opsRefuse("OPS_NOT_FOUND");
    const a = await lockAsset(tx, head.assetId);
    const x = await tx.fixedAssetAddition.findUniqueOrThrow({ where: { id: additionId } });
    if (x.status !== "POSTED" || a.status === "DISPOSED") throw opsRefuse("FA_STATE");
    const later = await tx.fixedAssetAddition.count({ where: { assetId: a.id, status: "POSTED", createdAt: { gt: x.createdAt } } });
    if (later || (a.depreciatedThrough && a.depreciatedThrough >= x.additionDate)) throw opsRefuse("FA_NOT_LATEST");
    await assertPeriodOpen(tx, x.additionDate);
    const fate = await glFate(tx, x.additionDate);
    if (x.glState === "SKIPPED" && fate.openingPosted) throw opsRefuse("FA_OPENING_FINAL");
    let cancelEntryId: string | null = null;
    if (x.journalEntryId) cancelEntryId = (await reverseEntry(tx, { entryId: x.journalEntryId, reason: r, actorId: ctx.actorId, date: dayText(x.additionDate) })).entryId;
    if (x.kind !== "REVISION") {
      const ev = await tx.fixedAssetEvent.findFirstOrThrow({ where: { sourceType: "ADDITION", sourceId: x.id, reversesEventId: null } });
      await tx.fixedAssetEvent.create({ data: { assetId: a.id, kind: "ADDITION", eventDate: x.additionDate, costDelta: dec(ev.costDelta).negated(), sourceType: "ADDITION", sourceId: x.id, reversesEventId: ev.id, glState: cancelEntryId ? "POSTED" : "SKIPPED", journalEntryId: cancelEntryId, createdBy: ctx.actorId } });
    }
    const b = x.before as unknown as Before;
    await tx.fixedAsset.update({ where: { id: a.id }, data: { cost: dec(b.cost), residualValue: dec(b.residualValue), usefulLifeMonths: b.usefulLifeMonths, basisDate: new Date(`${b.basisDate}T00:00:00Z`), basisAccumulated: dec(b.basisAccumulated),
      status: isFullyDepreciated(dec(b.cost), dec(b.residualValue), dec(a.accumulatedDepreciation)) ? "FULLY_DEPRECIATED" : "ACTIVE", updatedBy: ctx.actorId } });
    await tx.fixedAssetAddition.update({ where: { id: x.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: ctx.actorId, cancelReason: r, cancelEntryId } });
    return additionView(await tx.fixedAssetAddition.findUniqueOrThrow({ where: { id: x.id } }));
  }, TX_OPTS);
}

export async function listAdditions(q: { from?: Date | null; to?: Date | null } = {}) {
  const rows = await prisma.fixedAssetAddition.findMany({ where: { ...(q.from || q.to ? { additionDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}) }, orderBy: [{ additionDate: "desc" }, { createdAt: "desc" }], take: 500, include: { asset: { select: { id: true, code: true, nameAr: true, nameEn: true } } } });
  return rows.map((x) => ({ ...additionView(x), asset: x.asset }));
}

// ─── Disposals ────────────────────────────────────────────────────────────────────────────────

export type DisposalInput = { disposalDate?: string; kind?: string; proceedsNet?: string | number | null; vatRate?: string | number | null; proceedsAccountId?: string | null; buyerName?: string | null; taxInvoiceRef?: string | null; reason?: string | null };

export function disposalView(x: { id: string; number: string; disposalDate: Date; kind: string; proceedsNet: Prisma.Decimal; vatRate: Prisma.Decimal; vat: Prisma.Decimal; proceedsAccountId: string | null; buyerName: string | null; taxInvoiceRef: string | null; catchUpDepreciation: Prisma.Decimal; costRemoved: Prisma.Decimal; accumRemoved: Prisma.Decimal; gainLoss: Prisma.Decimal; reason: string | null; status: string; glState: string; journalEntryId: string | null; cancelReason: string | null; createdAt: Date; createdBy: string }) {
  return { id: x.id, number: x.number, disposalDate: dayText(x.disposalDate), kind: x.kind, proceedsNet: f2(x.proceedsNet), vatRate: dec(x.vatRate).toFixed(2), vat: f2(x.vat), proceedsAccountId: x.proceedsAccountId, buyerName: x.buyerName, taxInvoiceRef: x.taxInvoiceRef,
    catchUpDepreciation: f2(x.catchUpDepreciation), costRemoved: f2(x.costRemoved), accumRemoved: f2(x.accumRemoved), netBookValue: dec(x.costRemoved).minus(x.accumRemoved).toFixed(2), gainLoss: f2(x.gainLoss), reason: x.reason, status: x.status, glState: x.glState, journalEntryId: x.journalEntryId, cancelReason: x.cancelReason, createdAt: x.createdAt.toISOString(), createdBy: x.createdBy };
}

function cleanDisposal(input: DisposalInput) {
  const d = day(input?.disposalDate, "disposalDate");
  notFuture(d);
  const kind = String(input?.kind ?? "");
  if (kind !== "SALE" && kind !== "SCRAP") throw opsRefuse("FA_DISPOSAL_INVALID");
  let proceedsNet: Decimal;
  try { proceedsNet = input.proceedsNet === null || input.proceedsNet === undefined || input.proceedsNet === "" ? ZERO : money(input.proceedsNet, "proceedsNet", { allowZero: true }); } catch { throw opsRefuse("FA_DISPOSAL_INVALID"); }
  // Council F1: any disposal for value (a sale, or scrap sold to a dealer) is a taxable, e-invoiced supply — it waits
  // for the sales-invoice line «بيع أصل ثابت» (FOLLOWUPS.md); this register posts no output VAT and never feeds the VAT
  // return. Only disposals without proceeds (scrap / write-off, a sale for nothing) are recorded here.
  if (proceedsNet.gt(0)) throw opsRefuse("FA_SALE_NEEDS_INVOICE");
  let vatRate: Decimal;
  try { vatRate = dec(String(input.vatRate ?? "0")); } catch { throw opsRefuse("FA_DISPOSAL_INVALID"); }
  if (!(vatRate.equals(0) || vatRate.equals(15)) || (kind === "SCRAP" && vatRate.gt(0))) throw opsRefuse("FA_DISPOSAL_INVALID");
  vatRate = ZERO;
  const vat = ZERO;
  return { d, kind, proceedsNet, vatRate, vat, buyerName: str(input.buyerName, 200), taxInvoiceRef: str(input.taxInvoiceRef, 60), reason: str(input.reason, 500) };
}

async function disposalFigures(tx: Tx | typeof prisma, a: Awaited<ReturnType<typeof lockAsset>>, d: Date, proceedsNet: Decimal) {
  const through = recordedThrough(a) as Date;
  const catchUp = d > through ? chargeThrough(scheduleOf(a), dec(a.accumulatedDepreciation), d) : ZERO;
  const accum = dec(a.accumulatedDepreciation).plus(catchUp);
  const cost = dec(a.cost);
  return { catchUp, accum, cost, nbv: cost.minus(accum), gainLoss: proceedsNet.minus(cost.minus(accum)), through };
}

/** What a disposal on a day would record (no write): the depreciation to the day, the net book value, the gain / loss. */
export async function disposalPreview(assetId: string, input: DisposalInput) {
  const c = cleanDisposal(input);
  const a = await prisma.fixedAsset.findUnique({ where: { id: assetId }, include: { category: true } });
  if (!a) throw opsRefuse("FA_NOT_FOUND");
  if (a.status !== "ACTIVE" && a.status !== "FULLY_DEPRECIATED") throw opsRefuse("FA_STATE");
  const f = await disposalFigures(prisma, a, c.d, c.proceedsNet);
  return { disposalDate: dayText(c.d), recordedThrough: dayText(f.through), dateOk: c.d >= f.through, catchUpDepreciation: f.catchUp.toFixed(2), cost: f.cost.toFixed(2), accumulated: f.accum.toFixed(2), netBookValue: f.nbv.toFixed(2), proceedsNet: c.proceedsNet.toFixed(2), vat: c.vat.toFixed(2), gross: c.proceedsNet.plus(c.vat).toFixed(2), gainLoss: f.gainLoss.toFixed(2) };
}

/**
 * «استبعاد أصل» (scrap / write-off, or a sale with no proceeds): depreciation to the disposal day (inclusive), cost and
 * accumulated depreciation derecognised, the net book value to loss on disposal. One balanced entry, no VAT. Any
 * disposal for value is refused (FA_SALE_NEEDS_INVOICE, council F1): it will be an issued sales invoice with a
 * «بيع أصل ثابت» line posting to the disposal-clearing role, and this disposal will clear it.
 */
export async function disposeAsset(assetId: string, input: DisposalInput, ctx: AuditContext) {
  const c = cleanDisposal(input);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const a = await lockAsset(tx, assetId);
    if (a.status !== "ACTIVE" && a.status !== "FULLY_DEPRECIATED") throw opsRefuse("FA_STATE");
    const f = await disposalFigures(tx, a, c.d, c.proceedsNet);
    if (c.d < (a.inServiceDate as Date) || c.d < f.through) throw opsRefuse("FA_DATE_ORDER");
    await assertPeriodOpen(tx, c.d);
    const fate = await glFate(tx, c.d);
    await openingPendingGuard(tx, a.id, fate);
    const gross = c.proceedsNet.plus(c.vat);
    // The proceeds account (default: the BANK role) is needed when the entry posts; before go-live it may be blank.
    const proceedsAccountId = !gross.gt(0) ? null
      : input.proceedsAccountId ? await checkCounterAccount(tx, input.proceedsAccountId, { assetOnly: true })
      : fate.post ? await checkCounterAccount(tx, (await resolveRoles(tx, ["BANK"])).get("BANK"), { assetOnly: true }) : null;
    const id = `fad_${randomUUID().replace(/-/g, "")}`;
    const number = await nextFaNumber(tx, "FAD", c.d);
    let journalEntryId: string | null = null;
    if (fate.post) {
      const acc = await categoryAccounts(tx, a.category);
      // Entered and posted in one act: the segregation-of-duties setting decides (and the entry records it).
      const sodBypass = await faSod(tx, ctx.actorId, [ctx.actorId]);
      const r = await postEntry(tx, { source: SRC("FA_DISPOSAL", id, "POSTED"), date: dayText(c.d), createdBy: ctx.actorId, sodBypass, memo: `${c.kind === "SALE" ? "بيع" : "إتلاف"} أصل ثابت ${number} · ${a.code} · ${a.nameAr}`.slice(0, 500),
        lines: lines([
          line(acc.expense, "debit", f.catchUp, `إهلاك حتى تاريخ الاستبعاد ${a.code}`, a.branchId), line(acc.accum, "credit", f.catchUp, `إهلاك حتى تاريخ الاستبعاد ${a.code}`, a.branchId),
          line(acc.accum, "debit", f.accum, `إلغاء مجمع إهلاك ${a.code}`, a.branchId),
          proceedsAccountId ? line(proceedsAccountId, "debit", gross, `متحصلات استبعاد ${a.code}`, a.branchId) : null,
          line(acc.cost, "credit", f.cost, `إلغاء تكلفة ${a.code}`, a.branchId),
          f.gainLoss.gt(0) ? line(acc.gainLoss, "credit", f.gainLoss, `ربح استبعاد ${a.code}`, a.branchId) : line(acc.gainLoss, "debit", f.gainLoss.abs(), `خسارة استبعاد ${a.code}`, a.branchId),
        ]) });
      if (r.status === "posted") journalEntryId = r.entryId;
    }
    const glState = journalEntryId ? "POSTED" : "SKIPPED";
    await tx.fixedAssetDisposal.create({ data: {
      id, number, assetId, disposalDate: c.d, kind: c.kind, proceedsNet: c.proceedsNet, vatRate: c.vatRate, vat: c.vat, proceedsAccountId, buyerName: c.buyerName, taxInvoiceRef: c.taxInvoiceRef, reason: c.reason,
      catchUpDepreciation: f.catchUp, costRemoved: f.cost, accumRemoved: f.accum, gainLoss: f.gainLoss, before: beforeOf(a), glState, journalEntryId, createdBy: ctx.actorId } });
    if (f.catchUp.gt(0)) await tx.fixedAssetEvent.create({ data: { assetId, kind: "DEPRECIATION", eventDate: c.d, accumDelta: f.catchUp, sourceType: "DISPOSAL", sourceId: id, glState, journalEntryId, createdBy: ctx.actorId } });
    await tx.fixedAssetEvent.create({ data: { assetId, kind: "DISPOSAL", eventDate: c.d, costDelta: f.cost.negated(), accumDelta: f.accum.negated(), sourceType: "DISPOSAL", sourceId: id, glState, journalEntryId, createdBy: ctx.actorId } });
    await tx.fixedAsset.update({ where: { id: assetId }, data: { status: "DISPOSED", accumulatedDepreciation: f.accum, depreciatedThrough: c.d, updatedBy: ctx.actorId } });
    return { disposal: disposalView(await tx.fixedAssetDisposal.findUniqueOrThrow({ where: { id } })), asset: assetView(await tx.fixedAsset.findUniqueOrThrow({ where: { id: assetId }, include: ASSET_INCLUDE })) };
  }, TX_OPTS);
}

/** Cancel a disposal: its entry reversed (dated the disposal day — the period must be open), the asset back as it was. */
export async function cancelDisposal(disposalId: string, reason: string, ctx: AuditContext) {
  const r = str(reason, 500);
  if (!r || r.length < 3) throw opsRefuse("OPS_BAD_INPUT", "A reason is required.", "السبب مطلوب.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    const head = await tx.fixedAssetDisposal.findUnique({ where: { id: disposalId }, select: { assetId: true } });
    if (!head) throw opsRefuse("OPS_NOT_FOUND");
    const a = await lockAsset(tx, head.assetId);
    const x = await tx.fixedAssetDisposal.findUniqueOrThrow({ where: { id: disposalId } });
    if (x.status !== "POSTED" || a.status !== "DISPOSED") throw opsRefuse("FA_STATE");
    await assertPeriodOpen(tx, x.disposalDate);
    const fate = await glFate(tx, x.disposalDate);
    if (x.glState === "SKIPPED" && fate.openingPosted) throw opsRefuse("FA_OPENING_FINAL");
    let cancelEntryId: string | null = null;
    if (x.journalEntryId) cancelEntryId = (await reverseEntry(tx, { entryId: x.journalEntryId, reason: r, actorId: ctx.actorId, date: dayText(x.disposalDate) })).entryId;
    const evs = await tx.fixedAssetEvent.findMany({ where: { sourceType: "DISPOSAL", sourceId: x.id, reversesEventId: null } });
    for (const e of evs) await tx.fixedAssetEvent.create({ data: { assetId: a.id, kind: e.kind, eventDate: x.disposalDate, costDelta: dec(e.costDelta).negated(), accumDelta: dec(e.accumDelta).negated(), sourceType: "DISPOSAL", sourceId: x.id, reversesEventId: e.id, glState: cancelEntryId ? "POSTED" : "SKIPPED", journalEntryId: cancelEntryId, createdBy: ctx.actorId } });
    const b = x.before as unknown as Before;
    await tx.fixedAsset.update({ where: { id: a.id }, data: { status: b.status, accumulatedDepreciation: dec(b.accumulatedDepreciation), depreciatedThrough: b.depreciatedThrough ? new Date(`${b.depreciatedThrough}T00:00:00Z`) : null, updatedBy: ctx.actorId } });
    await tx.fixedAssetDisposal.update({ where: { id: x.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: ctx.actorId, cancelReason: r, cancelEntryId } });
    return disposalView(await tx.fixedAssetDisposal.findUniqueOrThrow({ where: { id: x.id } }));
  }, TX_OPTS);
}

export async function listDisposals(q: { from?: Date | null; to?: Date | null } = {}) {
  const rows = await prisma.fixedAssetDisposal.findMany({ where: { ...(q.from || q.to ? { disposalDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}) }, orderBy: [{ disposalDate: "desc" }, { createdAt: "desc" }], take: 500, include: { asset: { select: { id: true, code: true, nameAr: true, nameEn: true } }, proceedsAccount: { select: { code: true, nameAr: true, nameEn: true } } } });
  return rows.map((x) => ({ ...disposalView(x), asset: x.asset, proceedsAccount: x.proceedsAccount }));
}

export type { Schedule };
