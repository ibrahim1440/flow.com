// Fixed assets (stage 5, STAGE_5_DESIGN.md): classes and their approved depreciation policy
// versions, the register (draft → submitted → capitalised by someone else), monthly depreciation
// runs, disposals, reversals, and the register ↔ ledger reconciliation.
//
// Every approval is by someone other than the preparer (here and in database triggers). Journals
// post through the accounting event pipeline, exactly once, and are gated by the policy
// "fixed_assets.depreciation" (BLOCKED until approved; provisional only in an isolated test DB).
import { Prisma, type FaMethod, type FaStartConvention, type FaDisposalConvention, type FaSourceKind } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ledgerTx } from "./journal-service";
import { auditAccounting } from "./audit";
import { emitAccountingEvent } from "./accounting-event-service";
import { processEvent, type ProcessOutcome } from "./event-processor";
import { ZERO, dec, parseAmount, round2 } from "./money";
import { accountingDate, accountingDateOf as accountingDateOfSafe, dateStr, todayAccountingDate } from "./dates";
import { chargeThrough, startMonth, ym, ymLabel, type DepAsset } from "./fa-depreciation";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;
const LIVE_RUN = ["DRAFT", "POSTED", "REVERSAL_REQUESTED"] as const;
const POSTED_RUN = ["POSTED", "REVERSAL_REQUESTED"] as const;
const PARTY_CONTROLS = new Set(["RECEIVABLE", "PAYABLE", "COMMISSION_PAYABLE", "CUSTOMER_ADVANCES"]);
const METHODS = new Set(["STRAIGHT_LINE", "DECLINING_BALANCE"]);
const STARTS = new Set(["IN_SERVICE_MONTH", "NEXT_MONTH"]);
const DISPOSALS = new Set(["NONE", "FULL_MONTH"]);
const DISPOSAL_KINDS = new Set(["SALE", "SCRAP", "WRITE_OFF"]);

const reasonOf = (r: unknown, what: string) => {
  const s = typeof r === "string" ? r.trim() : "";
  if (s.length < 5) throw new AccountingError(`${what} needs a reason (at least 5 characters).`, 400);
  return s.slice(0, 300);
};
const notOwn = (preparedBy: string, userId: string, what: string) => {
  if (preparedBy === userId) throw new AccountingError(`You prepared this ${what}; someone else must approve it.`, 403);
};

async function postingAccount(tx: Client, id: unknown, what: string, types?: string[]) {
  const a = await tx.account.findUnique({ where: { id: String(id ?? "") }, include: { _count: { select: { children: true } } } });
  if (!a) throw new AccountingError(`${what}: choose an account.`, 400);
  if (!a.isActive || !a.allowPosting || a._count.children > 0) throw new AccountingError(`${what}: account ${a.code} cannot receive postings.`, 400);
  if (types && !types.includes(a.type)) throw new AccountingError(`${what}: account ${a.code} is ${a.type}; expected ${types.join(" or ")}.`, 400);
  if (PARTY_CONTROLS.has(a.controlKind)) throw new AccountingError(`${what}: ${a.code} is a customer/supplier control account and needs a party; choose another account.`, 400);
  return a;
}

// ── Classes and policy versions ─────────────────────────────────────────────────────────────

export async function createClass(b: Record<string, unknown>, userId: string) {
  const code = String(b.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,20}$/.test(code)) throw new AccountingError("The class code is 2–20 letters, digits or dashes.", 400);
  const name = String(b.name ?? "").trim();
  if (name.length < 2) throw new AccountingError("The class needs a name.", 400);
  const cost = await postingAccount(prisma, b.costAccountId, "Asset cost account", ["ASSET"]);
  const accum = await postingAccount(prisma, b.accumAccountId, "Accumulated depreciation account", ["ASSET"]);
  const exp = await postingAccount(prisma, b.expenseAccountId, "Depreciation expense account", ["EXPENSE"]);
  if (cost.id === accum.id) throw new AccountingError("The cost and accumulated depreciation accounts must differ.", 400);
  return ledgerTx(async (tx) => {
    const c = await tx.faClass.create({ data: { code, name, nameAr: typeof b.nameAr === "string" ? b.nameAr.trim() || null : null, costAccountId: cost.id, accumAccountId: accum.id, expenseAccountId: exp.id, createdBy: userId } });
    await auditAccounting(tx, { action: "fa.class.create", entityType: "fa_class", entityId: c.id, userId, after: { code, cost: cost.code, accum: accum.code, expense: exp.code } });
    return c;
  });
}

function policyFields(b: Record<string, unknown>) {
  const method = String(b.method ?? "");
  if (!METHODS.has(method)) throw new AccountingError("The method is STRAIGHT_LINE or DECLINING_BALANCE.", 400);
  const life = Number(b.usefulLifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 600) throw new AccountingError("The useful life is 1–600 months.", 400);
  let residual: Prisma.Decimal;
  try { residual = new Prisma.Decimal(String(b.residualPercent ?? "")); } catch { throw new AccountingError("The residual value is a percentage.", 400); }
  if (!residual.isFinite() || residual.lt(0) || residual.gte(100) || residual.decimalPlaces() > 2) throw new AccountingError("The residual value is 0–99.99 %.", 400);
  let factor: Prisma.Decimal | null = null;
  if (method === "DECLINING_BALANCE") {
    try { factor = new Prisma.Decimal(String(b.decliningFactor ?? "")); } catch { throw new AccountingError("A declining-balance policy needs its factor (e.g. 2).", 400); }
    if (!factor.isFinite() || factor.lte(0) || factor.gt(5)) throw new AccountingError("The declining-balance factor is above 0 and at most 5.", 400);
  }
  const start = String(b.startConvention ?? "");
  if (!STARTS.has(start)) throw new AccountingError("The start convention is IN_SERVICE_MONTH or NEXT_MONTH.", 400);
  const disp = String(b.disposalConvention ?? "");
  if (!DISPOSALS.has(disp)) throw new AccountingError("The disposal-month convention is NONE or FULL_MONTH.", 400);
  const threshold = b.capitalisationThreshold === undefined || b.capitalisationThreshold === "" ? ZERO : parseAmount(b.capitalisationThreshold, "The capitalisation threshold");
  return {
    method: method as FaMethod, usefulLifeMonths: life, residualPercent: residual, decliningFactor: factor,
    startConvention: start as FaStartConvention, disposalConvention: disp as FaDisposalConvention, capitalisationThreshold: threshold,
    note: typeof b.note === "string" ? b.note.trim().slice(0, 500) || null : null,
  };
}

export async function draftClassPolicy(classId: string, b: Record<string, unknown>, userId: string) {
  const f = policyFields(b);
  return ledgerTx(async (tx) => {
    const c = await tx.faClass.findUnique({ where: { id: classId } });
    if (!c) throw new AccountingError("Asset class not found.", 404);
    const draft = await tx.faClassPolicy.findFirst({ where: { classId, status: "DRAFT" } });
    if (draft) throw new AccountingError(`Version ${draft.version} of this class's policy is already a draft; approve it first.`, 409);
    const last = await tx.faClassPolicy.findFirst({ where: { classId }, orderBy: { version: "desc" } });
    const p = await tx.faClassPolicy.create({ data: { classId, version: (last?.version ?? 0) + 1, ...f, preparedBy: userId } });
    await auditAccounting(tx, { action: "fa.class_policy.draft", entityType: "fa_class_policy", entityId: p.id, userId, after: { class: c.code, version: p.version, ...f } });
    return p;
  });
}

export async function approveClassPolicy(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const p = await tx.faClassPolicy.findUnique({ where: { id }, include: { class: true } });
    if (!p) throw new AccountingError("Policy version not found.", 404);
    if (p.status !== "DRAFT") throw new AccountingError(`This version is ${p.status}.`, 409);
    notOwn(p.preparedBy, userId, "policy version");
    await tx.faClassPolicy.updateMany({ where: { classId: p.classId, status: "APPROVED" }, data: { status: "RETIRED" } });
    const res = await tx.faClassPolicy.updateMany({ where: { id, status: "DRAFT" }, data: { status: "APPROVED", approvedBy: userId, approvedAt: new Date() } });
    if (res.count === 0) throw new AccountingError("The version changed while approving; reload.", 409);
    await auditAccounting(tx, { action: "fa.class_policy.approve", entityType: "fa_class_policy", entityId: id, userId, after: { class: p.class.code, version: p.version } });
    return tx.faClassPolicy.findUniqueOrThrow({ where: { id } });
  });
}

async function approvedPolicy(tx: Client, classId: string) {
  return tx.faClassPolicy.findFirst({ where: { classId, status: "APPROVED" } });
}

// ── Register and capitalisation ─────────────────────────────────────────────────────────────

type SourceIn = { kind?: unknown; billLineId?: unknown; counterAccountId?: unknown; amount?: unknown; description?: unknown };

async function checkedSources(raw: unknown, costAccountId: string, exceptAssetId?: string) {
  if (!Array.isArray(raw) || raw.length === 0) throw new AccountingError("An asset needs at least one cost source.", 400);
  const out: { lineNo: number; kind: FaSourceKind; billLineId: string | null; counterAccountId: string | null; amount: Prisma.Decimal; description: string | null }[] = [];
  const seen = new Set<string>();
  for (const [i, s] of (raw as SourceIn[]).entries()) {
    const n = i + 1;
    const kind = String(s.kind ?? "");
    const description = typeof s.description === "string" ? s.description.trim().slice(0, 200) || null : null;
    if (kind === "BILL_LINE") {
      const bl = await prisma.supplierBillLine.findUnique({ where: { id: String(s.billLineId ?? "") }, include: { bill: true } });
      if (!bl || bl.bill.kind !== "BILL" || bl.bill.status !== "POSTED") throw new AccountingError(`Source ${n}: choose a line of a posted supplier bill.`, 400);
      if (seen.has(bl.id)) throw new AccountingError(`Source ${n}: the same bill line is listed twice.`, 400);
      seen.add(bl.id);
      const used = await prisma.faAssetSource.findFirst({ where: { billLineId: bl.id, asset: { status: { not: "CANCELLED" }, ...(exceptAssetId ? { id: { not: exceptAssetId } } : {}) } }, include: { asset: true } });
      if (used) throw new AccountingError(`Source ${n}: bill ${bl.bill.billNo} line ${bl.lineNo} already funds asset FA-${String(used.asset.assetNo).padStart(4, "0")}.`, 409);
      const amount = s.amount === undefined || s.amount === "" ? dec(bl.net) : parseAmount(s.amount, `Source ${n} amount`);
      if (amount.lte(0) || amount.gt(dec(bl.net))) throw new AccountingError(`Source ${n}: the amount must be above 0 and at most the line's net ${dec(bl.net).toFixed(2)}.`, 400);
      out.push({ lineNo: n, kind: "BILL_LINE", billLineId: bl.id, counterAccountId: bl.accountId, amount, description: description ?? `Bill ${bl.bill.billNo} · line ${bl.lineNo}` });
    } else if (kind === "ACCOUNT") {
      const a = await postingAccount(prisma, s.counterAccountId, `Source ${n} counter account`);
      if (a.id === costAccountId) throw new AccountingError(`Source ${n}: the counter account is the asset account itself; use "already in the ledger" instead.`, 400);
      if (a.controlKind === "CASH") throw new AccountingError(`Source ${n}: ${a.code} is a bank or cash account; its postings come from bank lines. Use a clearing or payables account.`, 400);
      const amount = parseAmount(s.amount, `Source ${n} amount`);
      if (amount.lte(0)) throw new AccountingError(`Source ${n}: the amount must be above 0.`, 400);
      out.push({ lineNo: n, kind: "ACCOUNT", billLineId: null, counterAccountId: a.id, amount, description });
    } else if (kind === "IN_LEDGER") {
      const amount = parseAmount(s.amount, `Source ${n} amount`);
      if (amount.lte(0)) throw new AccountingError(`Source ${n}: the amount must be above 0.`, 400);
      out.push({ lineNo: n, kind: "IN_LEDGER", billLineId: null, counterAccountId: null, amount, description });
    } else {
      throw new AccountingError(`Source ${n}: the kind is BILL_LINE, ACCOUNT or IN_LEDGER.`, 400);
    }
  }
  return out;
}

/** Create (no id) or edit (id, DRAFT only) an asset. Unset depreciation fields come from the class's approved policy. */
export async function saveAsset(b: Record<string, unknown>, userId: string, id?: string) {
  const name = String(b.name ?? "").trim();
  if (name.length < 2) throw new AccountingError("The asset needs a name.", 400);
  const cls = await prisma.faClass.findUnique({ where: { id: String(b.classId ?? "") } });
  if (!cls || !cls.isActive) throw new AccountingError("Choose an active asset class.", 400);
  const pol = await approvedPolicy(prisma, cls.id);
  if (!pol) throw new AccountingError(`Class ${cls.code} has no approved depreciation policy yet; an asset of this class cannot be registered.`, 409);
  const inService = accountingDate(b.inServiceDate);
  const sources = await checkedSources(b.sources, cls.costAccountId, id);
  const cost = sources.reduce((s, x) => s.add(x.amount), ZERO);
  const f = { ...policyFields({ method: pol.method, usefulLifeMonths: pol.usefulLifeMonths, residualPercent: pol.residualPercent.toString(), decliningFactor: pol.decliningFactor?.toString(), startConvention: pol.startConvention, disposalConvention: pol.disposalConvention }) };
  const method = (b.method ?? f.method) as FaMethod;
  if (!METHODS.has(method)) throw new AccountingError("The method is STRAIGHT_LINE or DECLINING_BALANCE.", 400);
  const life = b.usefulLifeMonths === undefined || b.usefulLifeMonths === "" ? f.usefulLifeMonths : Number(b.usefulLifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 600) throw new AccountingError("The useful life is 1–600 months.", 400);
  const residualValue = b.residualValue === undefined || b.residualValue === "" ? round2(cost.mul(pol.residualPercent).div(100)) : parseAmount(b.residualValue, "The residual value");
  const factor = method === "DECLINING_BALANCE" ? (b.decliningFactor ? new Prisma.Decimal(String(b.decliningFactor)) : pol.decliningFactor ?? null) : null;
  if (method === "DECLINING_BALANCE" && (!factor || factor.lte(0) || factor.gt(5))) throw new AccountingError("A declining-balance asset needs a factor above 0 and at most 5.", 400);
  const openingAccumulated = b.openingAccumulated ? parseAmount(b.openingAccumulated, "Opening accumulated depreciation") : ZERO;
  const openingMonths = b.openingMonths === undefined || b.openingMonths === "" ? 0 : Number(b.openingMonths);
  if (!Number.isInteger(openingMonths) || openingMonths < 0 || openingMonths >= life) throw new AccountingError("Months already depreciated must be a whole number below the useful life.", 400);
  if (openingAccumulated.gt(0) !== openingMonths > 0) throw new AccountingError("Opening accumulated depreciation and the months it covers go together.", 400);
  let openingCounter: string | null = null;
  if (openingAccumulated.gt(0) && b.openingAccumCounterAccountId) {
    const a = await postingAccount(prisma, b.openingAccumCounterAccountId, "Opening depreciation counter account");
    if (a.id === cls.accumAccountId) throw new AccountingError("The opening depreciation counter is the accumulated depreciation account itself; leave it empty for \"already in the ledger\".", 400);
    openingCounter = a.id;
  }
  if (residualValue.add(openingAccumulated).gt(cost)) throw new AccountingError("The residual value plus opening depreciation exceed the cost.", 400);
  if (cost.lt(pol.capitalisationThreshold)) throw new AccountingError(`The cost ${cost.toFixed(2)} is below class ${cls.code}'s capitalisation threshold (${pol.capitalisationThreshold.toFixed(2)}); expense it instead.`, 400);
  const deviates = method !== pol.method || life !== pol.usefulLifeMonths || !residualValue.equals(round2(cost.mul(pol.residualPercent).div(100))) || (method === "DECLINING_BALANCE" && !dec(factor).equals(dec(pol.decliningFactor)));
  const deviationReason = typeof b.deviationReason === "string" ? b.deviationReason.trim().slice(0, 300) : "";
  if (deviates && deviationReason.length < 5) throw new AccountingError(`The asset departs from class ${cls.code}'s approved policy (v${pol.version}); give the reason (at least 5 characters).`, 400);
  const data = {
    name, classId: cls.id, branchId: typeof b.branchId === "string" && b.branchId ? b.branchId : null, costCenterId: typeof b.costCenterId === "string" && b.costCenterId ? b.costCenterId : null,
    inServiceDate: inService, cost, residualValue, method, usefulLifeMonths: life, decliningFactor: factor,
    startConvention: pol.startConvention, disposalConvention: pol.disposalConvention, deviationReason: deviates ? deviationReason : null,
    openingAccumulated, openingMonths, openingAccumCounterAccountId: openingCounter,
  };
  return ledgerTx(async (tx) => {
    let asset;
    if (id) {
      const cur = await tx.faAsset.findUnique({ where: { id } });
      if (!cur) throw new AccountingError("Asset not found.", 404);
      if (cur.status !== "DRAFT") throw new AccountingError(`A ${cur.status.toLowerCase()} asset cannot be edited.`, 409);
      await tx.faAssetSource.deleteMany({ where: { assetId: id } });
      asset = await tx.faAsset.update({ where: { id }, data: { ...data, sources: { create: sources } } });
    } else {
      asset = await tx.faAsset.create({ data: { ...data, preparedBy: userId, sources: { create: sources } } });
    }
    await auditAccounting(tx, { action: id ? "fa.asset.edit" : "fa.asset.create", entityType: "fa_asset", entityId: asset.id, userId, after: { ...data, sources } });
    return asset;
  });
}

export async function submitAsset(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const res = await tx.faAsset.updateMany({ where: { id, status: "DRAFT" }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    if (res.count === 0) throw new AccountingError("Only a draft asset can be submitted.", 409);
    await auditAccounting(tx, { action: "fa.asset.submit", entityType: "fa_asset", entityId: id, userId });
    return tx.faAsset.findUniqueOrThrow({ where: { id } });
  });
}

export async function returnAsset(id: string, userId: string, reason: unknown) {
  const why = reasonOf(reason, "Returning an asset for changes");
  return ledgerTx(async (tx) => {
    const res = await tx.faAsset.updateMany({ where: { id, status: "SUBMITTED" }, data: { status: "DRAFT", submittedAt: null } });
    if (res.count === 0) throw new AccountingError("Only a submitted asset can be returned.", 409);
    await auditAccounting(tx, { action: "fa.asset.return", entityType: "fa_asset", entityId: id, userId, reason: why });
    return tx.faAsset.findUniqueOrThrow({ where: { id } });
  });
}

async function emitAndProcess(ev: { eventType: string; id: string; seq: string; date: Date; payload: Prisma.InputJsonValue }, tx: Tx) {
  return emitAccountingEvent({ eventType: ev.eventType, sourceModule: "fixed_assets", sourceDocumentId: ev.id, sourceEventId: ev.seq, occurredAt: ev.date, payload: ev.payload }, tx);
}

/** Approve and capitalise (someone other than the preparer). The journal is dated the approval day. */
export async function capitaliseAsset(id: string, userId: string): Promise<{ asset: unknown; ledger: ProcessOutcome }> {
  const today = todayAccountingDate();
  const { asset, eventId } = await ledgerTx(async (tx) => {
    const a = await tx.faAsset.findUnique({ where: { id }, include: { class: true, sources: true } });
    if (!a) throw new AccountingError("Asset not found.", 404);
    if (a.status !== "SUBMITTED") throw new AccountingError("Only a submitted asset can be capitalised.", 409);
    notOwn(a.preparedBy, userId, "asset");
    const pol = await approvedPolicy(tx, a.classId);
    if (!pol) throw new AccountingError(`Class ${a.class.code} has no approved depreciation policy.`, 409);
    for (const s of a.sources.filter((x) => x.billLineId)) {
      const bl = await tx.supplierBillLine.findUnique({ where: { id: s.billLineId! }, include: { bill: true } });
      if (!bl || bl.bill.status !== "POSTED") throw new AccountingError(`Source ${s.lineNo}: its supplier bill is no longer posted.`, 409);
    }
    if (a.inServiceDate > today) throw new AccountingError("The in-service date is in the future.", 400);
    const res = await tx.faAsset.updateMany({ where: { id, status: "SUBMITTED" }, data: { status: "CAPITALISED", approvedBy: userId, capitalisedAt: today, classPolicyId: pol.id } });
    if (res.count === 0) throw new AccountingError("The asset changed while approving; reload.", 409);
    const ev = await emitAndProcess({ eventType: "fa.asset.capitalised", id, seq: "1", date: today, payload: { assetId: id } }, tx);
    await auditAccounting(tx, { action: "fa.asset.capitalise", entityType: "fa_asset", entityId: id, userId, after: { cost: a.cost.toFixed(2), policyVersion: pol.version } });
    return { asset: await tx.faAsset.findUniqueOrThrow({ where: { id } }), eventId: ev.id };
  });
  return { asset, ledger: await processEvent(eventId) };
}

/** Undo a capitalisation while nothing has depreciated or been disposed of (someone other than the preparer). */
export async function cancelAsset(id: string, userId: string, reason: unknown) {
  const why = reasonOf(reason, "Cancelling a capitalised asset");
  const today = todayAccountingDate();
  const { asset, eventId } = await ledgerTx(async (tx) => {
    const a = await tx.faAsset.findUnique({ where: { id } });
    if (!a) throw new AccountingError("Asset not found.", 404);
    if (a.status !== "CAPITALISED") throw new AccountingError("Only a capitalised asset can be cancelled.", 409);
    notOwn(a.preparedBy, userId, "asset");
    const dep = await tx.faDepLine.count({ where: { assetId: id, run: { status: { in: [...LIVE_RUN] } } } });
    if (dep) throw new AccountingError("Depreciation has been charged on this asset; it cannot be cancelled (dispose of it instead).", 409);
    await tx.faAsset.update({ where: { id }, data: { status: "CANCELLED", cancelledBy: userId, cancelledAt: new Date(), cancelReason: why } });
    const ev = await emitAndProcess({ eventType: "fa.asset.cancelled", id, seq: "1", date: today, payload: { assetId: id } }, tx);
    await auditAccounting(tx, { action: "fa.asset.cancel", entityType: "fa_asset", entityId: id, userId, reason: why });
    return { asset: await tx.faAsset.findUniqueOrThrow({ where: { id } }), eventId: ev.id };
  });
  return { asset, ledger: await processEvent(eventId) };
}

// ── Depreciation runs ───────────────────────────────────────────────────────────────────────

async function postedSoFar(tx: Client, assetId: string, exceptRunId?: string) {
  const r = await tx.faDepLine.aggregate({ where: { assetId, run: { status: { in: [...POSTED_RUN] }, ...(exceptRunId ? { id: { not: exceptRunId } } : {}) } }, _sum: { amount: true, months: true } });
  return { accumulated: dec(r._sum.amount), months: r._sum.months ?? 0 };
}

const asDep = (a: { cost: Prisma.Decimal; residualValue: Prisma.Decimal; openingAccumulated: Prisma.Decimal; openingMonths: number; usefulLifeMonths: number; method: FaMethod; decliningFactor: Prisma.Decimal | null; startConvention: FaStartConvention; inServiceDate: Date }): DepAsset => a;

/** What a run for the period would contain now (assets capitalised, not disposed, with something to charge). */
export async function computeRun(tx: Client, periodEnd: Date) {
  const month = ym(periodEnd);
  const assets = await tx.faAsset.findMany({ where: { status: "CAPITALISED" }, include: { class: true }, orderBy: { assetNo: "asc" } });
  const lines = [];
  for (const a of assets) {
    if (startMonth(a) > month) continue;
    const c = chargeThrough(asDep(a), month, await postedSoFar(tx, a.id));
    if (c.amount.lte(0)) continue;
    lines.push({ assetId: a.id, assetNo: a.assetNo, name: a.name, classCode: a.class.code, amount: c.amount, months: c.months, accumulatedAfter: c.accumulatedAfter, nbvAfter: c.nbvAfter, note: c.note });
  }
  return lines;
}

async function runPeriod(tx: Client, periodId: string) {
  const p = await tx.fiscalPeriod.findUnique({ where: { id: periodId } });
  if (!p) throw new AccountingError("Fiscal period not found.", 404);
  return p;
}

export async function createRun(periodId: string, userId: string) {
  return ledgerTx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"fa-run"}))`;
    const p = await runPeriod(tx, periodId);
    const label = `${p.year}-${String(p.periodNo).padStart(2, "0")}`;
    if (p.status !== "OPEN") throw new AccountingError(`Fiscal period ${label} is ${p.status}; depreciation cannot be run for it.`, 409);
    const live = await tx.faDepRun.findFirst({ where: { fiscalPeriodId: periodId, status: { in: [...LIVE_RUN] } } });
    if (live) throw new AccountingError(`Run #${live.runNo} already exists for ${label} (${live.status}).`, 409);
    const draft = await tx.faDepRun.findFirst({ where: { status: "DRAFT" } });
    if (draft) throw new AccountingError(`Run #${draft.runNo} is still a draft; approve or discard it first.`, 409);
    const later = await tx.faDepRun.findFirst({ where: { status: { in: [...POSTED_RUN] }, periodEnd: { gt: p.endDate } }, orderBy: { periodEnd: "desc" } });
    if (later) throw new AccountingError(`A later period (${dateStr(later.periodEnd).slice(0, 7)}) already has posted depreciation (run #${later.runNo}); reverse it first.`, 409);
    const lines = await computeRun(tx, p.endDate);
    if (!lines.length) throw new AccountingError(`Nothing to depreciate for ${label}.`, 409);
    const total = lines.reduce((s, l) => s.add(l.amount), ZERO);
    const run = await tx.faDepRun.create({
      data: {
        fiscalPeriodId: p.id, periodEnd: p.endDate, total, preparedBy: userId,
        lines: { create: lines.map((l) => ({ assetId: l.assetId, amount: l.amount, months: l.months, accumulatedAfter: l.accumulatedAfter, nbvAfter: l.nbvAfter, note: l.note })) },
      },
      include: { lines: true },
    });
    await auditAccounting(tx, { action: "fa.run.create", entityType: "fa_run", entityId: run.id, userId, after: { period: label, total: total.toFixed(2), lines: lines.length } });
    return run;
  });
}

/** Someone other than the preparer approves: recomputed first; any difference refuses. Posts once. */
export async function approveRun(id: string, userId: string) {
  const { run, eventId } = await ledgerTx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"fa-run"}))`;
    const r = await tx.faDepRun.findUnique({ where: { id }, include: { lines: true } });
    if (!r) throw new AccountingError("Run not found.", 404);
    if (r.status !== "DRAFT") throw new AccountingError(`Run #${r.runNo} is ${r.status}.`, 409);
    notOwn(r.preparedBy, userId, "depreciation run");
    const p = await runPeriod(tx, r.fiscalPeriodId);
    if (p.status !== "OPEN") throw new AccountingError(`The run's period is ${p.status}; it cannot post.`, 409);
    const now = await computeRun(tx, r.periodEnd);
    const key = (xs: { assetId: string; amount: Prisma.Decimal }[]) => xs.map((l) => `${l.assetId}:${l.amount.toFixed(2)}`).sort().join("|");
    if (key(now) !== key(r.lines)) throw new AccountingError(`Run #${r.runNo} no longer matches the register (an asset was capitalised, disposed of or charged since it was computed); discard it and run again.`, 409);
    const res = await tx.faDepRun.updateMany({ where: { id, status: "DRAFT" }, data: { status: "POSTED", approvedBy: userId, postedAt: new Date() } });
    if (res.count === 0) throw new AccountingError("The run changed while approving; reload.", 409);
    const ev = await emitAndProcess({ eventType: "fa.depreciation.posted", id, seq: "1", date: r.periodEnd, payload: { runId: id } }, tx);
    await auditAccounting(tx, { action: "fa.run.post", entityType: "fa_run", entityId: id, userId, after: { total: r.total.toFixed(2) } });
    return { run: await tx.faDepRun.findUniqueOrThrow({ where: { id } }), eventId: ev.id };
  });
  return { run, ledger: await processEvent(eventId) };
}

export async function discardRun(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const res = await tx.faDepRun.updateMany({ where: { id, status: "DRAFT" }, data: { status: "CANCELLED" } });
    if (res.count === 0) throw new AccountingError("Only a draft run can be discarded.", 409);
    await auditAccounting(tx, { action: "fa.run.discard", entityType: "fa_run", entityId: id, userId });
    return tx.faDepRun.findUniqueOrThrow({ where: { id } });
  });
}

export async function requestRunReversal(id: string, userId: string, reason: unknown) {
  const why = reasonOf(reason, "Reversing a depreciation run");
  return ledgerTx(async (tx) => {
    const r = await tx.faDepRun.findUnique({ where: { id }, include: { lines: true } });
    if (!r) throw new AccountingError("Run not found.", 404);
    if (r.status !== "POSTED") throw new AccountingError(`Run #${r.runNo} is ${r.status}; only a posted run can be reversed.`, 409);
    const later = await tx.faDepRun.findFirst({ where: { status: { in: [...LIVE_RUN] }, periodEnd: { gt: r.periodEnd } } });
    if (later) throw new AccountingError(`Run #${later.runNo} for a later period exists; reverse the latest run first.`, 409);
    const disposed = await tx.faDisposal.findFirst({ where: { assetId: { in: r.lines.map((l) => l.assetId) }, status: { in: ["POSTED", "REVERSAL_REQUESTED"] } } });
    if (disposed) throw new AccountingError("An asset in this run has since been disposed of; reverse the disposal first.", 409);
    await tx.faDepRun.update({ where: { id }, data: { status: "REVERSAL_REQUESTED", reversalRequestedBy: userId, reversalReason: why } });
    await auditAccounting(tx, { action: "fa.run.reversal_request", entityType: "fa_run", entityId: id, userId, reason: why });
    return tx.faDepRun.findUniqueOrThrow({ where: { id } });
  });
}

export async function decideRunReversal(id: string, userId: string, approve: boolean) {
  const out = await ledgerTx(async (tx) => {
    const r = await tx.faDepRun.findUnique({ where: { id } });
    if (!r) throw new AccountingError("Run not found.", 404);
    if (r.status !== "REVERSAL_REQUESTED") throw new AccountingError("No reversal is waiting for this run.", 409);
    if (r.reversalRequestedBy === userId) throw new AccountingError("You requested this reversal; someone else must decide it.", 403);
    if (!approve) {
      await tx.faDepRun.update({ where: { id }, data: { status: "POSTED", reversalRequestedBy: null, reversalReason: null } });
      await auditAccounting(tx, { action: "fa.run.reversal_reject", entityType: "fa_run", entityId: id, userId });
      return { run: await tx.faDepRun.findUniqueOrThrow({ where: { id } }), eventId: null };
    }
    const p = await runPeriod(tx, r.fiscalPeriodId);
    if (p.status !== "OPEN") throw new AccountingError(`The run's period is ${p.status}; the reversal cannot post there.`, 409);
    await tx.faDepRun.update({ where: { id }, data: { status: "REVERSED", reversedBy: userId, reversedAt: new Date() } });
    const ev = await emitAndProcess({ eventType: "fa.depreciation.reversed", id, seq: "1", date: r.periodEnd, payload: { runId: id } }, tx);
    await auditAccounting(tx, { action: "fa.run.reverse", entityType: "fa_run", entityId: id, userId, reason: r.reversalReason });
    return { run: await tx.faDepRun.findUniqueOrThrow({ where: { id } }), eventId: ev.id };
  });
  return { run: out.run, ledger: out.eventId ? await processEvent(out.eventId) : null };
}

// ── Disposals ───────────────────────────────────────────────────────────────────────────────

async function disposalFigures(tx: Client, assetId: string, date: Date) {
  const a = await tx.faAsset.findUnique({ where: { id: assetId }, include: { class: true } });
  if (!a) throw new AccountingError("Asset not found.", 404);
  const dm = ym(date);
  const through = a.disposalConvention === "FULL_MONTH" ? dm : dm - 1;
  const posted = await postedSoFar(tx, assetId);
  if (through >= startMonth(a)) {
    const due = chargeThrough(asDep(a), through, posted);
    if (due.amount.gt(0)) throw new AccountingError(`Depreciation up to ${ymLabel(through)} has not posted for this asset (${due.amount.toFixed(2)} due); run it first.`, 409);
  }
  const later = await tx.faDepLine.findFirst({ where: { assetId, run: { status: { in: [...LIVE_RUN] }, periodEnd: { gt: new Date(Date.UTC(Math.floor(through / 12), (through % 12) + 1, 0)) } } }, include: { run: true } });
  if (later) throw new AccountingError(`Run #${later.run.runNo} charged this asset for a month after the disposal; reverse it first.`, 409);
  const accumulated = dec(a.openingAccumulated).add(posted.accumulated);
  const nbv = dec(a.cost).sub(accumulated);
  return { asset: a, accumulated, nbv };
}

export async function createDisposal(b: Record<string, unknown>, userId: string) {
  const date = accountingDate(b.disposalDate);
  const kind = String(b.kind ?? "");
  if (!DISPOSAL_KINDS.has(kind)) throw new AccountingError("The disposal kind is SALE, SCRAP or WRITE_OFF.", 400);
  const proceeds = b.proceeds === undefined || b.proceeds === "" ? ZERO : parseAmount(b.proceeds, "The proceeds");
  const reason = reasonOf(b.reason, "A disposal");
  let proceedsAccountId: string | null = null;
  if (proceeds.gt(0)) {
    const acc = await postingAccount(prisma, b.proceedsAccountId, "Proceeds account");
    if (acc.controlKind === "CASH") throw new AccountingError(`${acc.code} is a bank or cash account; its postings come from bank lines. Record the proceeds on a clearing account.`, 400);
    proceedsAccountId = acc.id;
  }
  if (kind !== "SALE" && proceeds.gt(0)) throw new AccountingError("Only a sale has proceeds.", 400);
  return ledgerTx(async (tx) => {
    const a = await tx.faAsset.findUnique({ where: { id: String(b.assetId ?? "") } });
    if (!a || a.status !== "CAPITALISED") throw new AccountingError("Only a capitalised asset can be disposed of.", 409);
    if (date < a.inServiceDate) throw new AccountingError("The disposal date is before the asset was placed in service.", 400);
    if (date > todayAccountingDate()) throw new AccountingError("The disposal date is in the future.", 400);
    await disposalFigures(tx, a.id, date);
    const d = await tx.faDisposal.create({ data: { assetId: a.id, disposalDate: date, kind, proceeds, proceedsAccountId, reason, preparedBy: userId } });
    await auditAccounting(tx, { action: "fa.disposal.create", entityType: "fa_disposal", entityId: d.id, userId, after: { asset: a.assetNo, date: dateStr(date), kind, proceeds: proceeds.toFixed(2) } });
    return d;
  });
}

export async function approveDisposal(id: string, userId: string) {
  const out = await ledgerTx(async (tx) => {
    const d = await tx.faDisposal.findUnique({ where: { id } });
    if (!d) throw new AccountingError("Disposal not found.", 404);
    if (d.status !== "DRAFT") throw new AccountingError(`This disposal is ${d.status}.`, 409);
    notOwn(d.preparedBy, userId, "disposal");
    const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: d.disposalDate }, endDate: { gte: d.disposalDate } } });
    if (!period || period.status !== "OPEN") throw new AccountingError(`The disposal date's period is ${period?.status ?? "missing"}; it cannot post.`, 409);
    const f = await disposalFigures(tx, d.assetId, d.disposalDate);
    if (f.asset.status !== "CAPITALISED") throw new AccountingError("The asset is no longer capitalised.", 409);
    const gainLoss = dec(d.proceeds).sub(f.nbv);
    const res = await tx.faDisposal.updateMany({ where: { id, status: "DRAFT" }, data: { status: "POSTED", approvedBy: userId, postedAt: new Date(), cost: f.asset.cost, accumulated: f.accumulated, nbv: f.nbv, gainLoss } });
    if (res.count === 0) throw new AccountingError("The disposal changed while approving; reload.", 409);
    await tx.faAsset.update({ where: { id: d.assetId }, data: { status: "DISPOSED" } });
    const ev = await emitAndProcess({ eventType: "fa.disposal.posted", id, seq: "1", date: d.disposalDate, payload: { disposalId: id } }, tx);
    await auditAccounting(tx, { action: "fa.disposal.post", entityType: "fa_disposal", entityId: id, userId, after: { nbv: f.nbv.toFixed(2), gainLoss: gainLoss.toFixed(2) } });
    return { disposal: await tx.faDisposal.findUniqueOrThrow({ where: { id } }), eventId: ev.id };
  });
  return { disposal: out.disposal, ledger: await processEvent(out.eventId) };
}

export async function discardDisposal(id: string, userId: string) {
  return ledgerTx(async (tx) => {
    const res = await tx.faDisposal.updateMany({ where: { id, status: "DRAFT" }, data: { status: "CANCELLED" } });
    if (res.count === 0) throw new AccountingError("Only a draft disposal can be discarded.", 409);
    await auditAccounting(tx, { action: "fa.disposal.discard", entityType: "fa_disposal", entityId: id, userId });
    return tx.faDisposal.findUniqueOrThrow({ where: { id } });
  });
}

export async function requestDisposalReversal(id: string, userId: string, reason: unknown) {
  const why = reasonOf(reason, "Reversing a disposal");
  return ledgerTx(async (tx) => {
    const res = await tx.faDisposal.updateMany({ where: { id, status: "POSTED" }, data: { status: "REVERSAL_REQUESTED", reversalRequestedBy: userId, reversalReason: why } });
    if (res.count === 0) throw new AccountingError("Only a posted disposal can be reversed.", 409);
    await auditAccounting(tx, { action: "fa.disposal.reversal_request", entityType: "fa_disposal", entityId: id, userId, reason: why });
    return tx.faDisposal.findUniqueOrThrow({ where: { id } });
  });
}

export async function decideDisposalReversal(id: string, userId: string, approve: boolean) {
  const out = await ledgerTx(async (tx) => {
    const d = await tx.faDisposal.findUnique({ where: { id } });
    if (!d) throw new AccountingError("Disposal not found.", 404);
    if (d.status !== "REVERSAL_REQUESTED") throw new AccountingError("No reversal is waiting for this disposal.", 409);
    if (d.reversalRequestedBy === userId) throw new AccountingError("You requested this reversal; someone else must decide it.", 403);
    if (!approve) {
      await tx.faDisposal.update({ where: { id }, data: { status: "POSTED", reversalRequestedBy: null, reversalReason: null } });
      await auditAccounting(tx, { action: "fa.disposal.reversal_reject", entityType: "fa_disposal", entityId: id, userId });
      return { disposal: await tx.faDisposal.findUniqueOrThrow({ where: { id } }), eventId: null };
    }
    const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: d.disposalDate }, endDate: { gte: d.disposalDate } } });
    if (!period || period.status !== "OPEN") throw new AccountingError(`The disposal's period is ${period?.status ?? "missing"}; the reversal cannot post there.`, 409);
    await tx.faDisposal.update({ where: { id }, data: { status: "REVERSED", reversedBy: userId, reversedAt: new Date() } });
    await tx.faAsset.update({ where: { id: d.assetId }, data: { status: "CAPITALISED" } });
    const ev = await emitAndProcess({ eventType: "fa.disposal.reversed", id, seq: "1", date: d.disposalDate, payload: { disposalId: id } }, tx);
    await auditAccounting(tx, { action: "fa.disposal.reverse", entityType: "fa_disposal", entityId: id, userId, reason: d.reversalReason });
    return { disposal: await tx.faDisposal.findUniqueOrThrow({ where: { id } }), eventId: ev.id };
  });
  return { disposal: out.disposal, ledger: out.eventId ? await processEvent(out.eventId) : null };
}

// ── Queries: register, schedule, reconciliation ─────────────────────────────────────────────

export async function assetRegister(asOf?: Date) {
  const assets = await prisma.faAsset.findMany({ include: { class: true, depLines: { where: { run: { status: { in: [...POSTED_RUN] } } } }, disposals: { where: { status: { in: ["POSTED", "REVERSAL_REQUESTED"] } } } }, orderBy: { assetNo: "asc" } });
  const at = asOf ?? todayAccountingDate();
  return assets.map((a) => {
    const accumulated = dec(a.openingAccumulated).add(a.depLines.reduce((s, l) => s.add(l.amount), ZERO));
    return {
      id: a.id, assetNo: a.assetNo, name: a.name, classCode: a.class.code, className: a.class.name, status: a.status, inServiceDate: dateStr(a.inServiceDate),
      cost: a.cost.toFixed(2), accumulated: accumulated.toFixed(2), nbv: a.status === "DISPOSED" || a.status === "CANCELLED" ? null : dec(a.cost).sub(accumulated).toFixed(2),
      disposedOn: a.disposals[0] ? dateStr(a.disposals[0].disposalDate) : null, asOf: dateStr(at),
    };
  });
}

/** Future months of an asset's schedule from what has posted (straight line and declining balance alike). */
export async function assetSchedule(id: string, months = 12) {
  const a = await prisma.faAsset.findUnique({ where: { id } });
  if (!a) throw new AccountingError("Asset not found.", 404);
  let posted = await postedSoFar(prisma, id);
  const out = [];
  let m = Math.max(startMonth(a), ym(todayAccountingDate()) - 1);
  if (posted.months > 0) m = startMonth(a) + posted.months;
  const end = startMonth(a) + Math.max(0, a.usefulLifeMonths - a.openingMonths) - 1;
  for (; m <= end && out.length < months; m++) {
    const c = chargeThrough(asDep(a), m, posted);
    out.push({ month: ymLabel(m), amount: c.amount.toFixed(2), accumulated: c.accumulatedAfter.toFixed(2), nbv: c.nbvAfter.toFixed(2), note: c.note });
    posted = { accumulated: posted.accumulated.add(c.amount), months: posted.months + c.months };
  }
  return out;
}

async function glBalance(accountId: string, asOf: Date) {
  const r = await prisma.journalEntryLine.aggregate({ where: { accountId, journalEntry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { lte: asOf } } }, _sum: { debit: true, credit: true } });
  return dec(r._sum.debit).sub(dec(r._sum.credit));
}

/**
 * Register ↔ ledger per cost and accumulated-depreciation account, as of a date, with every
 * difference itemised: fixed-asset journals not (yet) posted, bill lines on an asset account that
 * no asset uses, other journals on those accounts, and costs registered as already in the ledger.
 */
export async function reconcileRegister(asOf: Date) {
  const classes = await prisma.faClass.findMany();
  const accounts = new Map<string, { role: "COST" | "ACCUM"; classIds: string[] }>();
  for (const c of classes) {
    for (const [id, role] of [[c.costAccountId, "COST"], [c.accumAccountId, "ACCUM"]] as const) {
      const cur = accounts.get(id) ?? { role, classIds: [] };
      cur.classIds.push(c.id); accounts.set(id, cur);
    }
  }
  const assets = await prisma.faAsset.findMany({ where: { status: { in: ["CAPITALISED", "DISPOSED", "CANCELLED"] }, capitalisedAt: { lte: asOf } }, include: { class: true, sources: true, disposals: true, depLines: { include: { run: true } } } });
  const events = await prisma.accountingEvent.findMany({ where: { sourceModule: "fixed_assets", status: { in: ["PENDING", "BLOCKED", "FAILED"] } } });
  const acctRows = await prisma.account.findMany({ where: { id: { in: [...accounts.keys()] } } });
  const out = [];
  for (const acct of acctRows) {
    const { role } = accounts.get(acct.id)!;
    let register = ZERO;
    let inLedger = ZERO;
    for (const a of assets) {
      const cancelled = a.status === "CANCELLED" && a.cancelledAt !== null && accountingDateOfSafe(a.cancelledAt) <= asOf;
      const disp = a.disposals.find((d) => ["POSTED", "REVERSAL_REQUESTED"].includes(d.status) && d.disposalDate <= asOf);
      if (cancelled) continue;
      // A balance registered as already in the ledger stays in the other journals after a disposal
      // (the disposal journal removes it), so it explains them whether or not the asset is disposed of.
      if (role === "COST" && a.class.costAccountId === acct.id) {
        inLedger = inLedger.add(a.sources.filter((s) => s.kind === "IN_LEDGER").reduce((s, x) => s.add(x.amount), ZERO));
        if (!disp) register = register.add(a.cost);
      }
      if (role === "ACCUM" && a.class.accumAccountId === acct.id) {
        if (!a.openingAccumCounterAccountId) inLedger = inLedger.sub(dec(a.openingAccumulated));
        if (!disp) {
          const dep = a.depLines.filter((l) => ["POSTED", "REVERSAL_REQUESTED"].includes(l.run.status) && l.run.periodEnd <= asOf).reduce((s, l) => s.add(l.amount), ZERO);
          register = register.sub(dec(a.openingAccumulated)).sub(dep);
        }
      }
    }
    const gl = await glBalance(acct.id, asOf);
    const items: { kind: string; ref: string; amount: string; note: string; billNo?: number; lineNo?: number; count?: number; assetNo?: number }[] = [];
    // Journals on the account that do not come from the fixed-asset module.
    const others = await prisma.journalEntryLine.findMany({ where: { accountId: acct.id, journalEntry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { lte: asOf }, sourceModule: { not: "fixed_assets" } } }, include: { journalEntry: true } });
    let explained = ZERO;
    if (role === "COST") {
      const pending = new Map((await prisma.faAssetSource.findMany({ where: { billLineId: { not: null }, asset: { status: { in: ["DRAFT", "SUBMITTED"] } } }, include: { asset: true } })).map((x) => [x.billLineId!, x.asset.assetNo]));
      const funded = new Map(assets.filter((a) => a.status !== "CANCELLED").flatMap((a) => a.sources.filter((x) => x.billLineId).map((x) => [x.billLineId!, dec(x.amount)] as const)));
      const billLines = await prisma.supplierBillLine.findMany({ where: { accountId: acct.id, bill: { kind: "BILL", status: "POSTED", billDate: { lte: asOf } } }, include: { bill: true } });
      for (const bl of billLines) {
        const used = funded.get(bl.id);
        const rest = used ? dec(bl.net).sub(used) : dec(bl.net);
        if (rest.isZero()) continue;
        const waiting = pending.get(bl.id);
        items.push({ kind: used ? "BILL_LINE_PART" : waiting ? "BILL_LINE_PENDING_ASSET" : "UNREGISTERED_BILL_LINE", ref: `bill ${bl.bill.billNo} · line ${bl.lineNo}`, billNo: bl.bill.billNo, lineNo: bl.lineNo, assetNo: waiting, amount: rest.toFixed(2),
          note: used ? "part of the line is not in any asset's cost" : waiting ? `on draft asset FA-${String(waiting).padStart(4, "0")}, not yet capitalised` : "posted to the asset account but not registered as an asset" });
        explained = explained.add(rest);
      }
    }
    const otherNet = others.filter((l) => l.journalEntry.sourceModule !== "payables").reduce((s, l) => s.add(dec(l.debit)).sub(dec(l.credit)), ZERO);
    if (!otherNet.isZero()) { items.push({ kind: "OTHER_JOURNALS", ref: `${others.filter((l) => l.journalEntry.sourceModule !== "payables").length} line(s)`, count: others.filter((l) => l.journalEntry.sourceModule !== "payables").length, amount: otherNet.toFixed(2), note: "manual, opening or other journals on this account" }); explained = explained.add(otherNet); }
    if (!inLedger.isZero()) { items.push({ kind: "ALREADY_IN_LEDGER", ref: "register", amount: inLedger.neg().toFixed(2), note: "registered as already in the ledger (bill lines on this account, opening balances)" }); explained = explained.sub(inLedger); }
    for (const e of events) items.push({ kind: "JOURNAL_NOT_POSTED", ref: `${e.eventType} · ${e.status}`, amount: "", note: e.errorMessage ?? "" });
    const diff = gl.sub(register);
    out.push({
      accountId: acct.id, code: acct.code, name: acct.nameEn, nameAr: acct.nameAr, role, register: register.toFixed(2), ledger: gl.toFixed(2), difference: diff.toFixed(2),
      unexplained: diff.sub(explained).toFixed(2), items: diff.isZero() && !events.length ? [] : items,
    });
  }
  return { asOf: dateStr(asOf), accounts: out.sort((a, b) => a.code.localeCompare(b.code)) };
}

export { ym, ymLabel };
