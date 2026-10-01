// Stage 5 fixed assets against real PostgreSQL. Every class policy, rate and life here is a
// SYNTHETIC TEST ASSUMPTION, not company policy. Figures are worked by hand:
//   MACH-SYN (1210 / 1290 / 6600), v1: straight line, 36 months, residual 0 %, from the in-service
//   month, no charge in the disposal month, capitalisation threshold 1,000.00.
//   Bill B-1 (03-10): grinder 18,500.00 on 1210 · spare parts 3,600.00 on 1210 (never registered).
//   FA grinder: bill line, in service 05-01 → 513.89 a month (round2(18,500 × k / 36) − posted).
//   FA roaster: 120,000.00 via 2195, in service 01-01, 60 months, residual 12,000 (departs from the
//     class: reason given) → 1,800.00 a month.
// Run: npm run test:accounting:db
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, reset, makeUser, rejects } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear, lockFiscalPeriod, unlockFiscalPeriod } from "../../../src/lib/accounting/fiscal-period-service";
import { draftPolicy, approvePolicy } from "../../../src/lib/accounting/policy-service";
import { processEvent, processPendingEvents } from "../../../src/lib/accounting/event-processor";
import { createBill, submitBill, approveBill, postBill } from "../../../src/lib/accounting/payables-service";
import * as FA from "../../../src/lib/accounting/fixed-assets-service";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

const YEAR = Number(todayAccountingDate().toISOString().slice(0, 4));
const D = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dec = (s: string) => new Prisma.Decimal(s);
beforeEach(reset);
after(async () => { await prisma.$disconnect(); });

async function world(opts: { approveFaPolicy?: boolean } = {}) {
  const prep = await makeUser("Asset accountant");
  const appr = await makeUser("Controller");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: accountingDate(D(1, 1)), setupComplete: true }, prep);
  for (const key of ["payables.recognition", ...(opts.approveFaPolicy === false ? [] : ["fixed_assets.depreciation"])]) { const p = await draftPolicy(key, {}, prep); await approvePolicy(p.id, appr); }
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const vat = (await prisma.taxCategory.create({ data: { code: "VAT15", nameEn: "Standard 15%", nameAr: "قياسية 15%", rate: dec("15.00"), isDefault: true } })).id;
  const supplier = (await prisma.supplier.create({ data: { name: "مؤسسة المعدات (تجريبي)", vatNumber: "310245678900003", paymentTermsDays: 30 } })).id;
  const cls = await FA.createClass({ code: "mach-syn", name: "Machinery (synthetic)", costAccountId: acc["1210"], accumAccountId: acc["1290"], expenseAccountId: acc["6600"] }, prep);
  const pol = await FA.draftClassPolicy(cls.id, { method: "STRAIGHT_LINE", usefulLifeMonths: 36, residualPercent: "0", startConvention: "IN_SERVICE_MONTH", disposalConvention: "NONE", capitalisationThreshold: "1000", note: "SYNTHETIC TEST ASSUMPTION" }, prep);
  const b = await createBill({ supplierId: supplier, supplierInvoiceNo: "EQ-1", billDate: D(3, 10), lines: [
    { kind: "EXPENSE", accountId: acc["1210"], description: "مطحنة تجارية", quantity: "1", unitPrice: "18500", taxCategoryId: vat },
    { kind: "EXPENSE", accountId: acc["1210"], description: "قطع غيار", quantity: "1", unitPrice: "3600", taxCategoryId: vat },
  ] }, prep);
  await submitBill(b.id, prep); await approveBill(b.id, appr); await postBill(b.id, appr);
  const lines = await prisma.supplierBillLine.findMany({ where: { billId: b.id }, orderBy: { lineNo: "asc" } });
  const period = async (m: number) => (await prisma.fiscalPeriod.findFirstOrThrow({ where: { year: YEAR, periodNo: m } })).id;
  return { prep, appr, acc, cls: cls.id, pol: pol.id, grinderLine: lines[0].id, partsLine: lines[1].id, period };
}
type W = Awaited<ReturnType<typeof world>>;

async function journal(sourceId: string, eventType: string) {
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `fixed_assets:${sourceId}:${eventType}:1` } });
  assert.equal(ev?.status, "TRANSLATED", `${eventType}: ${ev?.status} ${ev?.errorMessage ?? ""}`);
  const ls = await prisma.journalEntryLine.findMany({ where: { journalEntryId: ev!.journalEntryId! }, include: { account: true } });
  return ls.map((l) => `${l.account.code}:${l.debit.toFixed(2)}:${l.credit.toFixed(2)}`).sort();
}
async function gl(w: W, code: string) {
  const r = await prisma.journalEntryLine.aggregate({ where: { accountId: w.acc[code], journalEntry: { status: { in: ["POSTED", "REVERSED"] } } }, _sum: { debit: true, credit: true } });
  return dec(String(r._sum.debit ?? 0)).sub(dec(String(r._sum.credit ?? 0))).toFixed(2);
}
async function grinder(w: W) {
  const a = await FA.saveAsset({ name: "مطحنة تجارية (تجريبي)", classId: w.cls, inServiceDate: D(5, 1), sources: [{ kind: "BILL_LINE", billLineId: w.grinderLine }] }, w.prep);
  await FA.submitAsset(a.id, w.prep);
  await FA.capitaliseAsset(a.id, w.appr);
  return a.id;
}
async function roaster(w: W) {
  const a = await FA.saveAsset({ name: "محمصة 12 كغ (تجريبي)", classId: w.cls, inServiceDate: D(1, 1), usefulLifeMonths: 60, residualValue: "12000", deviationReason: "SYNTHETIC: heavier machine, longer life",
    sources: [{ kind: "ACCOUNT", counterAccountId: w.acc["2195"], amount: "120000", description: "Roaster invoice (synthetic)" }] }, w.prep);
  await FA.submitAsset(a.id, w.prep);
  const r = await FA.capitaliseAsset(a.id, w.appr);
  return { id: a.id, ledger: r.ledger };
}
async function run(w: W, m: number) {
  const r = await FA.createRun(await w.period(m), w.prep);
  const out = await FA.approveRun(r.id, w.appr);
  assert.equal(out.ledger.status, "TRANSLATED", out.ledger.message);
  return r;
}

describe("classes, policies and capitalisation", () => {
  test("a class policy is approved by someone else and never changes; an asset needs an approved policy and a reason to depart from it", async () => {
    const w = await world();
    await rejects(FA.saveAsset({ name: "Test asset", classId: w.cls, inServiceDate: D(5, 1), sources: [{ kind: "BILL_LINE", billLineId: w.grinderLine }] }, w.prep), /no approved depreciation policy/);
    await rejects(FA.approveClassPolicy(w.pol, w.prep), /someone else must approve/);
    await FA.approveClassPolicy(w.pol, w.appr);
    await rejects(prisma.faClassPolicy.update({ where: { id: w.pol }, data: { usefulLifeMonths: 48 } }), /cannot change; prepare a new version/);
    await rejects(FA.saveAsset({ name: "Roaster", classId: w.cls, inServiceDate: D(1, 1), usefulLifeMonths: 60, sources: [{ kind: "ACCOUNT", counterAccountId: w.acc["2195"], amount: "120000" }] }, w.prep), /departs from class MACH-SYN's approved policy/);
    await rejects(FA.saveAsset({ name: "Kettle", classId: w.cls, inServiceDate: D(5, 1), sources: [{ kind: "ACCOUNT", counterAccountId: w.acc["2195"], amount: "400" }] }, w.prep), /below class MACH-SYN's capitalisation threshold/);
    await rejects(FA.saveAsset({ name: "Test asset", classId: w.cls, inServiceDate: D(5, 1), sources: [{ kind: "ACCOUNT", counterAccountId: w.acc["1120"], amount: "5000" }] }, w.prep), /bank or cash account/);
    await rejects(FA.saveAsset({ name: "Test asset", classId: w.cls, inServiceDate: D(5, 1), sources: [{ kind: "ACCOUNT", counterAccountId: w.acc["2110"], amount: "5000" }] }, w.prep), /control account and needs a party/);
  });

  test("capitalisation: four-eyes; a bill line already on the asset account posts nothing; a counter account posts Dr cost / Cr counter; a bill line funds one asset", async () => {
    const w = await world();
    await FA.approveClassPolicy(w.pol, w.appr);
    const a = await FA.saveAsset({ name: "مطحنة", classId: w.cls, inServiceDate: D(5, 1), sources: [{ kind: "BILL_LINE", billLineId: w.grinderLine }] }, w.prep);
    assert.equal(a.cost.toFixed(2), "18500.00");
    await rejects(FA.capitaliseAsset(a.id, w.appr), /Only a submitted asset/);
    await FA.submitAsset(a.id, w.prep);
    await rejects(FA.capitaliseAsset(a.id, w.prep), /someone else must approve/);
    await rejects(prisma.faAsset.update({ where: { id: a.id }, data: { status: "CAPITALISED", approvedBy: w.prep } }), /capitalised by someone other than its preparer/);
    const g = await FA.capitaliseAsset(a.id, w.appr);
    assert.equal(g.ledger.status, "SKIPPED", "cost already on 1210 from the bill");
    await rejects(prisma.faAssetSource.create({ data: { assetId: a.id, lineNo: 9, kind: "IN_LEDGER", amount: dec("1") } }), /cannot change/);
    await rejects(FA.saveAsset({ name: "again", classId: w.cls, inServiceDate: D(5, 1), sources: [{ kind: "BILL_LINE", billLineId: w.grinderLine }] }, w.prep), /already funds asset FA-0001/);
    const r = await roaster(w);
    assert.equal(r.ledger.status, "TRANSLATED");
    assert.deepEqual(await journal(r.id, "fa.asset.capitalised"), ["1210:120000.00:0.00", "2195:0.00:120000.00"]);
    await rejects(prisma.faAsset.update({ where: { id: r.id }, data: { usefulLifeMonths: 72 } }), /capitalised asset cannot be edited/);
  });

  test("capitalisation waits (BLOCKED) until the fixed-asset policy is approved, then posts once on retry", async () => {
    const w = await world({ approveFaPolicy: false });
    await FA.approveClassPolicy(w.pol, w.appr);
    const r = await roaster(w);
    assert.equal(r.ledger.status, "BLOCKED");
    assert.match(r.ledger.message ?? "", /fixed_assets.depreciation/);
    const p = await draftPolicy("fixed_assets.depreciation", {}, w.prep); await approvePolicy(p.id, w.appr);
    await processPendingEvents();
    assert.deepEqual(await journal(r.id, "fa.asset.capitalised"), ["1210:120000.00:0.00", "2195:0.00:120000.00"]);
    const ev = await prisma.accountingEvent.findUniqueOrThrow({ where: { idempotencyKey: `fixed_assets:${r.id}:fa.asset.capitalised:1` } });
    assert.equal((await processEvent(ev.id)).status, "TRANSLATED");
    assert.equal(await prisma.journalEntry.count({ where: { originEventId: ev.id } }), 1, "a retry never posts twice");
  });
});

describe("depreciation runs", () => {
  test("monthly runs, catch-up, duplicates, concurrency, locked periods, later periods, reversal and re-run", async () => {
    const w = await world();
    await FA.approveClassPolicy(w.pol, w.appr);
    await grinder(w);
    await roaster(w);
    const jan = await run(w, 1);
    assert.deepEqual(await journal(jan.id, "fa.depreciation.posted"), ["1290:0.00:1800.00", "6600:1800.00:0.00"]);
    await rejects(FA.createRun(await w.period(1), w.prep), /already exists/);
    const feb = await FA.createRun(await w.period(2), w.prep);
    await rejects(FA.approveRun(feb.id, w.prep), /someone else must approve/);
    await FA.approveRun(feb.id, w.appr);
    await rejects(prisma.faDepRun.update({ where: { id: feb.id }, data: { total: dec("1") } }), /cannot be changed; reverse it/);
    await rejects(prisma.faDepLine.updateMany({ where: { runId: feb.id }, data: { amount: dec("1") } }), /cannot change/);
    await run(w, 3); await run(w, 4);
    const may = await run(w, 5);
    assert.deepEqual(await journal(may.id, "fa.depreciation.posted"), ["1290:0.00:2313.89", "6600:2313.89:0.00"]);
    // Two people start June's run at once: one run.
    const both = await Promise.allSettled([FA.createRun(await w.period(6), w.prep), FA.createRun(await w.period(6), w.appr)]);
    assert.equal(both.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(both.map((x) => x.status === "rejected" ? String(x.reason) : "ok")));
    const jun = (both.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<{ id: string; preparedBy: string }>).value;
    await FA.approveRun(jun.id, jun.preparedBy === w.prep ? w.appr : w.prep);
    // July locked: refused, then unlocked with a reason.
    await lockFiscalPeriod(await w.period(7), w.appr);
    await rejects(FA.createRun(await w.period(7), w.prep), /LOCKED; depreciation cannot be run/);
    await unlockFiscalPeriod(await w.period(7), w.appr, "SYNTHETIC: depreciation still to run");
    // August run first: catches July up; July can then no longer be run.
    const aug = await run(w, 8);
    const augLines = await prisma.faDepLine.findMany({ where: { runId: aug.id }, orderBy: { amount: "asc" } });
    assert.deepEqual(augLines.map((l) => [l.amount.toFixed(2), l.months]), [["1027.78", 2], ["3600.00", 2]]);
    await rejects(FA.createRun(await w.period(7), w.prep), /later period .* already has posted depreciation/);
    // Only the latest run reverses; four-eyes on the reversal; then July and August run again.
    await rejects(FA.requestRunReversal(jun.id, w.prep, "SYNTHETIC: wrong"), /reverse the latest run first/);
    await FA.requestRunReversal(aug.id, w.prep, "SYNTHETIC: July should be its own run");
    await rejects(FA.decideRunReversal(aug.id, w.prep, true), /someone else must decide/);
    const rev = await FA.decideRunReversal(aug.id, w.appr, true);
    assert.equal(rev.ledger?.status, "TRANSLATED");
    assert.deepEqual(await journal(aug.id, "fa.depreciation.reversed"), ["1290:4627.78:0.00", "6600:0.00:4627.78"]);
    await run(w, 7); await run(w, 8);
    // Jan–Aug: roaster 8 × 1,800 = 14,400; grinder May–Aug round2(18,500 × 4 / 36) = 2,055.56.
    assert.equal(await gl(w, "6600"), "16455.56");
    assert.equal(await gl(w, "1290"), "-16455.56");
    const reg = await FA.assetRegister();
    assert.deepEqual(reg.map((a) => [a.accumulated, a.nbv]), [["2055.56", "16444.44"], ["14400.00", "105600.00"]]);
  });

  test("a run computed before a change is refused at approval (recomputed first)", async () => {
    const w = await world();
    await FA.approveClassPolicy(w.pol, w.appr);
    await roaster(w);
    const r = await FA.createRun(await w.period(5), w.prep);   // catch-up Jan–May 9,000.00
    assert.equal(r.total.toFixed(2), "9000.00");
    await grinder(w);                                           // capitalised after the run was computed
    await rejects(FA.approveRun(r.id, w.appr), /no longer matches the register/);
    await FA.discardRun(r.id, w.prep);
    const r2 = await FA.createRun(await w.period(5), w.prep);
    assert.equal(r2.total.toFixed(2), "9513.89");
  });
});

describe("disposal, reversal, reconciliation, cancellation", () => {
  test("sale at a loss, reversal, sale at a gain; the register reconciles to the ledger with the unregistered bill line explained", async () => {
    const w = await world();
    await FA.approveClassPolicy(w.pol, w.appr);
    const gid = await grinder(w);
    await roaster(w);
    for (let m = 1; m <= 7; m++) await run(w, m);
    const sale = { assetId: gid, disposalDate: D(9, 15), kind: "SALE", proceeds: "16000", proceedsAccountId: w.acc["2190"], reason: "SYNTHETIC: replaced" };
    await rejects(FA.createDisposal(sale, w.prep), /Depreciation up to .*-08 has not posted/);
    await run(w, 8);
    await rejects(FA.createDisposal({ ...sale, proceedsAccountId: w.acc["1120"] }, w.prep), /bank or cash account/);
    const d = await FA.createDisposal(sale, w.prep);
    await rejects(FA.approveDisposal(d.id, w.prep), /someone else must approve/);
    await FA.approveDisposal(d.id, w.appr);
    // Accumulated May–Aug 2,055.56; NBV 16,444.44; proceeds 16,000 → loss 444.44.
    assert.deepEqual(await journal(d.id, "fa.disposal.posted"), ["1210:0.00:18500.00", "1290:2055.56:0.00", "2190:16000.00:0.00", "6960:444.44:0.00"]);
    assert.equal((await prisma.faAsset.findUniqueOrThrow({ where: { id: gid } })).status, "DISPOSED");
    await FA.requestDisposalReversal(d.id, w.prep, "SYNTHETIC: sale fell through");
    await rejects(FA.decideDisposalReversal(d.id, w.prep, true), /someone else must decide/);
    await FA.decideDisposalReversal(d.id, w.appr, true);
    assert.deepEqual(await journal(d.id, "fa.disposal.reversed"), ["1210:18500.00:0.00", "1290:0.00:2055.56", "2190:0.00:16000.00", "6960:0.00:444.44"]);
    const d2 = await FA.createDisposal({ ...sale, proceeds: "17000" }, w.prep);
    await FA.approveDisposal(d2.id, w.appr);
    assert.deepEqual(await journal(d2.id, "fa.disposal.posted"), ["1210:0.00:18500.00", "1290:2055.56:0.00", "2190:17000.00:0.00", "4800:0.00:555.56"]);
    const sep = await run(w, 9);                                   // the grinder is out
    assert.deepEqual(await journal(sep.id, "fa.depreciation.posted"), ["1290:0.00:1800.00", "6600:1800.00:0.00"]);

    // As of the later of 09-30 (the September run's date) and today: capitalisation is dated on its
    // approval day, so a fixed 09-30 broke the test once the run date passed September.
    const asOf = [D(9, 30), todayAccountingDate().toISOString().slice(0, 10)].sort()[1];
    const rec = await FA.reconcileRegister(accountingDate(asOf));
    const byCode = Object.fromEntries(rec.accounts.map((a) => [a.code, a]));
    // 1210: bill 18,500 + 3,600, roaster 120,000, disposal −18,500 = 123,600; register 120,000.
    assert.deepEqual([byCode["1210"].register, byCode["1210"].ledger, byCode["1210"].difference, byCode["1210"].unexplained], ["120000.00", "123600.00", "3600.00", "0.00"]);
    assert.equal(byCode["1210"].items[0].kind, "UNREGISTERED_BILL_LINE");
    assert.deepEqual([byCode["1290"].register, byCode["1290"].ledger, byCode["1290"].difference], ["-16200.00", "-16200.00", "0.00"]);
  });

  test("a capitalisation is cancelled only before any depreciation; the journal is reversed", async () => {
    const w = await world();
    await FA.approveClassPolicy(w.pol, w.appr);
    const r = await roaster(w);
    const g = await grinder(w);
    await run(w, 1);
    await rejects(FA.cancelAsset(r.id, w.appr, "SYNTHETIC: wrong asset"), /Depreciation has been charged/);
    await rejects(FA.cancelAsset(g, w.prep, "SYNTHETIC: wrong asset"), /someone else must approve/);
    const c = await FA.cancelAsset(g, w.appr, "SYNTHETIC: entered twice");
    assert.equal(c.ledger.status, "SKIPPED", "nothing was posted at capitalisation, so nothing to reverse");
    const again = await FA.saveAsset({ name: "مطحنة", classId: w.cls, inServiceDate: D(5, 1), sources: [{ kind: "BILL_LINE", billLineId: w.grinderLine }] }, w.prep);
    assert.ok(again.id, "a cancelled asset's bill line can fund a new one");
  });
});
