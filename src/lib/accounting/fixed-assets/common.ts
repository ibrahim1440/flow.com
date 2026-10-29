// «الأصول الثابتة» — shared pieces of the fixed-asset sub-ledger (20261121090000_fixed_assets): input parsing, the
// category's accounts (its own, else the posting role), the GL fate of a date (posted / skipped before go-live / not
// active — the engine's switch) and the guards every writer applies (period open, the opening final), numbering.
import type { Prisma } from "@/generated/prisma/client";
import { Decimal, ZERO, toDecimal, MoneyError } from "../money";
import { addDaysUtc, dayText, parseBusinessDay, riyadhDay } from "../dates";
import { engineState, resolveRoles } from "../posting-engine";
import { opsRefuse } from "../ops/refusals";
import { sodDecision, sodPolicy } from "../sod";
import type { Schedule, DepreciationMethod } from "./schedule";

export type Tx = Prisma.TransactionClient;

export const FA_ROLES = { cost: "FA_COST", accum: "FA_ACCUMULATED_DEPRECIATION", expense: "FA_DEPRECIATION_EXPENSE", gainLoss: "FA_DISPOSAL_GAIN_LOSS" } as const;
export const ASSET_STATUSES = ["DRAFT", "ACTIVE", "FULLY_DEPRECIATED", "DISPOSED"] as const;
export const ACQUISITION_KINDS = ["PURCHASE_INVOICE", "MANUAL", "OPENING"] as const;
/** The control kinds an asset is never paid from / its proceeds never go to (they have their own sub-ledgers). */
const SUBLEDGER_CONTROLS = new Set(["AR", "AP", "INVENTORY", "VAT_INPUT", "VAT_OUTPUT", "FIXED_ASSET", "PAYROLL", "COMMISSION", "CLEARING"]);

export { CATEGORY_SEED_COST_CODE } from "../coa-template";

export const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
export const f2 = (d: Decimal | Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : new Decimal(d).toFixed(2));
export const dec = (d: Decimal | Prisma.Decimal | string | number) => new Decimal(d);

export function money(v: unknown, what: string, opts: { allowZero?: boolean } = {}): Decimal {
  let d: Decimal;
  try {
    d = toDecimal(typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v ?? "").trim());
    if (!d.equals(d.toDecimalPlaces(2))) throw new MoneyError("2 decimals at most");
  } catch { throw opsRefuse("FA_INVALID", `${what}: an amount with at most 2 decimals.`, `${what}: مبلغ بخانتين عشريتين كحد أقصى.`); }
  if (d.isNegative() || (!opts.allowZero && d.isZero())) throw opsRefuse("FA_INVALID", `${what} is above zero.`, `${what} أكبر من صفر.`);
  return d;
}

export function day(v: unknown, what: string): Date {
  try { return parseBusinessDay(String(v ?? "")); } catch { throw opsRefuse("FA_INVALID", `${what} is YYYY-MM-DD.`, `${what}: تاريخ بصيغة YYYY-MM-DD.`); }
}

export function notFuture(d: Date): void {
  if (d > riyadhDay()) throw opsRefuse("FA_FUTURE_DATE");
}

export function intIn(v: unknown, lo: number, hi: number, what: string): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isInteger(n) || n < lo || n > hi) throw opsRefuse("FA_INVALID", `${what} is a whole number ${lo}–${hi}.`, `${what}: عدد صحيح من ${lo} إلى ${hi}.`);
  return n;
}

export function rate(v: unknown): Decimal {
  let d: Decimal;
  try { d = toDecimal(String(v ?? "").trim()); } catch { throw opsRefuse("FA_CATEGORY_INVALID"); }
  if (!d.gt(0) || d.gt(100) || !d.equals(d.toDecimalPlaces(4))) throw opsRefuse("FA_CATEGORY_INVALID");
  return d;
}

export function method(v: unknown): DepreciationMethod {
  const m = String(v ?? "STRAIGHT_LINE");
  if (m !== "STRAIGHT_LINE" && m !== "DECLINING_BALANCE") throw opsRefuse("FA_INVALID", "method is STRAIGHT_LINE or DECLINING_BALANCE.", "الطريقة قسط ثابت أو قسط متناقص.");
  return m;
}

/** [{ name, url (https) }], at most 20 — the journals' attachment rule (journal-service.ts). */
export function attachments(a: unknown): Prisma.InputJsonValue | undefined {
  if (a === undefined || a === null) return undefined;
  if (!Array.isArray(a) || a.length > 20) throw opsRefuse("FA_INVALID", "attachments: at most 20 { name, url }.", "المرفقات: 20 على الأكثر.");
  return a.map((x) => {
    const name = str((x as { name?: unknown })?.name, 200), url = str((x as { url?: unknown })?.url, 1000);
    if (!name || !url || !/^https:\/\//.test(url)) throw opsRefuse("FA_INVALID", "attachments: { name, url (https) }.", "المرفق: اسم ورابط https.");
    return { name, url };
  });
}

type CategoryRow = { costAccountId: string | null; accumAccountId: string | null; expenseAccountId: string | null; gainLossAccountId: string | null };
export type Accounts = { cost: string; accum: string; expense: string; gainLoss: string };

/** A category's accounts: its own, else the role's (refuses — ROLE_NOT_MAPPED — listing every role it still needs). */
export async function categoryAccounts(tx: Tx, c: CategoryRow, need: (keyof Accounts)[] = ["cost", "accum", "expense", "gainLoss"]): Promise<Accounts> {
  const own: Record<keyof Accounts, string | null> = { cost: c.costAccountId, accum: c.accumAccountId, expense: c.expenseAccountId, gainLoss: c.gainLossAccountId };
  const missing = need.filter((k) => !own[k]).map((k) => FA_ROLES[k]);
  const roles = missing.length ? await resolveRoles(tx, missing) : new Map<string, string>();
  const pick = (k: keyof Accounts) => own[k] ?? roles.get(FA_ROLES[k]) ?? "";
  return { cost: pick("cost"), accum: pick("accum"), expense: pick("expense"), gainLoss: pick("gainLoss") };
}

/** The same without refusing: null where neither the category nor the role names an account (reports, previews). */
export async function categoryAccountsSoft(db: Pick<Tx, "accountRole">, c: CategoryRow): Promise<Record<keyof Accounts, string | null>> {
  const rows = await db.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: Object.values(FA_ROLES) } }, select: { role: true, accountId: true } });
  const r = new Map(rows.map((x) => [x.role, x.accountId]));
  return { cost: c.costAccountId ?? r.get(FA_ROLES.cost) ?? null, accum: c.accumAccountId ?? r.get(FA_ROLES.accum) ?? null, expense: c.expenseAccountId ?? r.get(FA_ROLES.expense) ?? null, gainLoss: c.gainLossAccountId ?? r.get(FA_ROLES.gainLoss) ?? null };
}

/** An account a category may name for a slot (cost / accum: asset; expense: expense; gain-loss: expense or revenue). */
export async function checkCategoryAccount(tx: Tx, id: string | null, slot: keyof Accounts): Promise<string | null> {
  if (!id) return null;
  const a = await tx.account.findUnique({ where: { id }, select: { type: true, isActive: true, allowPosting: true, _count: { select: { children: true } } } });
  const types = slot === "cost" || slot === "accum" ? ["ASSET"] : slot === "expense" ? ["EXPENSE"] : ["EXPENSE", "REVENUE"];
  if (!a || !a.isActive || !a.allowPosting || a._count.children > 0 || !types.includes(String(a.type))) throw opsRefuse("FA_ACCOUNT_INVALID");
  return id;
}

/** An account the asset is paid from / proceeds go to: active postable leaf, not a sub-ledger control account. */
export async function checkCounterAccount(tx: Tx, id: unknown, opts: { assetOnly?: boolean } = {}): Promise<string> {
  const accountId = str(id, 64);
  if (!accountId) throw opsRefuse("FA_COUNTER_ACCOUNT");
  const a = await tx.account.findUnique({ where: { id: accountId }, select: { id: true, type: true, isActive: true, allowPosting: true, controlType: true, _count: { select: { children: true } }, roles: { select: { role: true } } } });
  if (!a || !a.isActive || !a.allowPosting || a._count.children > 0 || (a.controlType && SUBLEDGER_CONTROLS.has(a.controlType))) throw opsRefuse("FA_COUNTER_ACCOUNT");
  if (a.roles.some((r) => (Object.values(FA_ROLES) as string[]).includes(r.role))) throw opsRefuse("FA_COUNTER_ACCOUNT");
  if (opts.assetOnly ? String(a.type) !== "ASSET" : !["ASSET", "LIABILITY", "EQUITY"].includes(String(a.type))) throw opsRefuse("FA_COUNTER_ACCOUNT");
  return a.id;
}

export type GlFate = { post: boolean; reason: "POST" | "NOT_ACTIVE" | "BEFORE_GO_LIVE"; openingPosted: boolean; goLiveDate: Date | null; active: boolean };

/**
 * What the books do with a fixed-asset event on `d`: posted (accounting active, on / after go-live) or skipped (the
 * engine's switch — the existing pattern: the register is kept, the entry is not). Skipped before go-live after the
 * opening is posted is refused (FA_OPENING_FINAL): the opening would never carry it.
 */
export async function glFate(tx: Tx, d: Date): Promise<GlFate> {
  const s = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true, goLiveDate: true, openingEntryId: true } });
  assertGoLiveFirstOfMonth(s?.goLiveDate ?? null);
  const st = await engineState(tx, d);
  const fate: GlFate = { post: st.on, reason: st.on ? "POST" : st.reason, openingPosted: !!s?.openingEntryId, goLiveDate: s?.goLiveDate ?? null, active: !!s?.accountingActive };
  if (!fate.post && fate.reason === "BEFORE_GO_LIVE" && fate.openingPosted) throw opsRefuse("FA_OPENING_FINAL");
  return fate;
}

/**
 * Council F3 (option chosen: refuse, not prorate): the fixed-asset register needs the go-live date on the 1st of a month.
 * The opening carries what the register recorded through the month before go-live and the monthly run posts whole
 * months from then on, so no month is split between the old books and the new ones. A go-live on another day refuses
 * every fixed-asset write that records or posts (activation, runs, additions, disposals, their reversals, the opening).
 */
export function assertGoLiveFirstOfMonth(goLive: Date | null): void {
  if (goLive && goLive.getUTCDate() !== 1) throw opsRefuse("FA_GO_LIVE_DAY", `(${dayText(goLive)})`, `(${dayText(goLive)})`);
}

/**
 * The segregation-of-duties setting (A5, ../sod.ts) on a fixed-asset posting: when the poster also prepared the document
 * (`preparers`), the act is refused unless the setting allows self-approval (SIMPLE MODE always does); when it is
 * allowed the entry is flagged (JournalEntry.sodBypass) and «استثناءات فصل المهام» lists it (FA_SELF_POSTED).
 * Returns the flag for postEntry.
 */
export async function faSod(tx: Tx, actorId: string, preparers: (string | null | undefined)[]): Promise<boolean> {
  if (!preparers.includes(actorId)) return false;
  if (!sodDecision(await sodPolicy(tx), "SELF_APPROVAL")) throw opsRefuse("FA_SOD_SELF_POST");
  return true;
}

/** The fiscal period of the day, when there is one, is OPEN (a soft-closed / closed month records nothing). */
export async function assertPeriodOpen(tx: Tx, d: Date): Promise<void> {
  const p = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: d }, endDate: { gte: d } }, select: { id: true } });
  if (!p) return;
  const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS status FROM "FiscalPeriod" WHERE "id" = ${p.id} FOR SHARE`;
  if (rows[0] && rows[0].status !== "OPEN") throw opsRefuse("FA_PERIOD_CLOSED", `(${dayText(d)})`, `(${dayText(d)})`);
}

/** «FA-2026-000001» … per prefix and year, serialised (an advisory lock) — gap-free among committed rows. */
export async function nextFaNumber(tx: Tx, prefix: "FA" | "DEP" | "FAA" | "FAD", on: Date): Promise<string> {
  const y = on.getUTCFullYear();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fa:number:${prefix}:${y}`}, 0))`;
  const like = `${prefix}-${y}-%`;
  const rows = prefix === "FA"
    ? await tx.$queryRaw<{ n: string | null }[]>`SELECT max("code") AS n FROM "FixedAsset" WHERE "code" LIKE ${like} AND "code" ~ '^FA-[0-9]{4}-[0-9]{6}$'`
    : prefix === "DEP"
      ? await tx.$queryRaw<{ n: string | null }[]>`SELECT max("number") AS n FROM "FixedAssetDepreciationRun" WHERE "number" LIKE ${like}`
      : prefix === "FAA"
        ? await tx.$queryRaw<{ n: string | null }[]>`SELECT max("number") AS n FROM "FixedAssetAddition" WHERE "number" LIKE ${like}`
        : await tx.$queryRaw<{ n: string | null }[]>`SELECT max("number") AS n FROM "FixedAssetDisposal" WHERE "number" LIKE ${like}`;
  const last = rows[0]?.n ? Number(rows[0].n.slice(-6)) : 0;
  return `${prefix}-${y}-${String(last + 1).padStart(6, "0")}`;
}

type AssetSchedRow = {
  method: string; decliningRatePercent: Prisma.Decimal | null; inServiceDate: Date | null; usefulLifeMonths: number;
  cost: Prisma.Decimal; residualValue: Prisma.Decimal; basisDate: Date | null; basisAccumulated: Prisma.Decimal | null;
};

/** The schedule of an asset out of DRAFT (the in-service date and the basis are set at activation). */
export function scheduleOf(a: AssetSchedRow): Schedule {
  if (!a.inServiceDate || !a.basisDate) throw opsRefuse("FA_STATE");
  return {
    method: a.method as DepreciationMethod, decliningRatePercent: a.decliningRatePercent ? dec(a.decliningRatePercent) : null,
    inServiceDate: a.inServiceDate, usefulLifeMonths: a.usefulLifeMonths, cost: dec(a.cost), residualValue: dec(a.residualValue),
    basisDate: a.basisDate, basisAccumulated: a.basisAccumulated ? dec(a.basisAccumulated) : ZERO,
  };
}

/** The last day depreciation is recorded for (the day before the in-service date when nothing is yet). */
export const recordedThrough = (a: { depreciatedThrough: Date | null; inServiceDate: Date | null }) =>
  a.depreciatedThrough ?? (a.inServiceDate ? addDaysUtc(a.inServiceDate, -1) : null);

/** Lock the asset row (FOR UPDATE) and read it. */
export async function lockAsset(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "FixedAsset" WHERE "id" = ${id} FOR UPDATE`;
  const a = await tx.fixedAsset.findUnique({ where: { id }, include: { category: true } });
  if (!a) throw opsRefuse("FA_NOT_FOUND");
  return a;
}

/** The asset's history before go-live is only in the books through the opening (events SKIPPED / OPENING) and the
 *  opening is not posted yet: a posting that derecognises it is refused (the supplier-claims pattern, council F1). */
export async function openingPendingGuard(tx: Tx, assetId: string, fate: GlFate): Promise<void> {
  if (!fate.post || fate.openingPosted) return;
  const n = await tx.fixedAssetEvent.count({ where: { assetId, glState: { in: ["SKIPPED", "OPENING"] } } });
  if (n > 0) throw opsRefuse("FA_OPENING_PENDING");
}
