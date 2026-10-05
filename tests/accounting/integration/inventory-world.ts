// Shared stage 4 test world: chart, fiscal year, approved policies, D-1 settings (SYNTHETIC TEST
// ASSUMPTIONS unless a test changes them), locations, items, approved synthetic loss bands,
// suppliers and a customer. Used by inventory.test.ts and the stage 4 gap tests.
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { prisma, makeUser } from "./support";
import { applyChartTemplate, updateSettings } from "../../../src/lib/accounting/setup-service";
import { createFiscalYear } from "../../../src/lib/accounting/fiscal-period-service";
import { draftPolicy, approvePolicy } from "../../../src/lib/accounting/policy-service";
import { createItem, createLocation, createLossBand, approveLossBand, updateInventorySettings, createInvDoc, submitInvDoc, approveInvDoc, postInvDoc, type InvDocInput } from "../../../src/lib/accounting/inventory-service";
import { accountingDate, todayAccountingDate } from "../../../src/lib/accounting/dates";

export const YEAR = todayAccountingDate().getUTCFullYear();
export const D = (md: string) => `${YEAR}-${md}`;
export const dec = (s: string) => new Prisma.Decimal(s);

export async function world(opts: { method?: "WEIGHTED_AVERAGE" | "FIFO" | null; approvePolicy?: boolean; timing?: "WITH_REVENUE" | null } = {}) {
  const prep = await makeUser("Store accountant");
  const appr = await makeUser("Controller");
  await applyChartTemplate(prep);
  await createFiscalYear(YEAR, 1, prep);
  await updateSettings({ ledgerCutoverDate: accountingDate(D("01-01")), setupComplete: true }, prep);
  for (const key of ["payables.recognition", "receivables.recognition", ...(opts.approvePolicy === false ? [] : ["inventory.costing"])]) { const p = await draftPolicy(key, {}, prep); await approvePolicy(p.id, appr); }
  const method = opts.method === undefined ? "WEIGHTED_AVERAGE" : opts.method;
  // SYNTHETIC TEST ASSUMPTIONS (not decisions): weighted average, capitalise price differences,
  // cost of sales with the revenue (DECISION_PACK §3 and §4 recommendations).
  if (method) await updateInventorySettings({ inventoryCostMethod: method, inventoryPriceDifference: "CAPITALISE", salesCostTiming: opts.timing === undefined ? "WITH_REVENUE" : opts.timing }, prep);
  const acc = Object.fromEntries((await prisma.account.findMany()).map((a) => [a.code, a.id]));
  const vat = (await prisma.taxCategory.create({ data: { code: "VAT15", nameEn: "Standard 15%", nameAr: "قياسية 15%", rate: dec("15.00"), isDefault: true } })).id;
  const rst = await createLocation({ code: "RST", name: "Roastery (synthetic)", isSalesDefault: true }, prep);
  const cafe = await createLocation({ code: "CAFE", name: "Café (synthetic)" }, prep);
  const item = (code: string, kind: string, baseUnit: string, extra: Record<string, unknown> = {}) => createItem({ code, name: code, kind, baseUnit, ...extra }, prep);
  const I = {
    green: await item("GRN-ETH", "GREEN_COFFEE", "kg"),
    roasted: await item("RST-ETH", "ROASTED_COFFEE", "kg"),
    bag: await item("BAG-250", "PACKAGING", "piece", { units: [{ unit: "pack100", factor: "100" }] }),
    label: await item("LBL-ETH", "PACKAGING", "piece"),
    sku: await item("SKU-ETH-250", "FINISHED_GOOD", "unit", { yieldPerUnit: "0.25", productSkuId: "sku-eth-250" }),
    milk: await item("MILK", "MILK", "l", { units: [{ unit: "carton12", factor: "12" }] }),
    flour: await item("FLOUR", "BAKERY_INGREDIENT", "kg"),
    butter: await item("BUTTER", "BAKERY_INGREDIENT", "kg"),
    croissant: await item("CROISSANT", "FINISHED_GOOD", "piece", { yieldPerUnit: "0.08" }),
  };
  const band = async (code: string, process: string, pct: string) => { const b = await createLossBand({ code, name: `${code} (synthetic test band)`, process, maxLossPercent: pct }, prep); return (await approveLossBand(b.id, appr)).id; };
  const bands = { roast: await band("ROAST-SYN", "ROASTING", "18"), pack: await band("PACK-SYN", "PACKING", "1"), bake: await band("BAKE-SYN", "BAKING", "5") };
  const supplier = async (name: string) => (await prisma.supplier.create({ data: { name, vatNumber: "310245678900003", paymentTermsDays: 30 } })).id;
  const S = { green: await supplier("محمصة الوادي للتوريد"), freight: await supplier("شركة الشحن"), dairy: await supplier("مؤسسة الألبان والمخبوزات") };
  const customer = (await prisma.customer.create({ data: { name: "Al-Rawda Hotel", nameAr: "فندق الروضة", vatNumber: "300445566700003", paymentTermsDays: 30 } })).id;
  /** create → submit → approve (someone else) → post */
  const doc = async (input: InvDocInput) => {
    const d = await createInvDoc(input, prep);
    await submitInvDoc(d.id, prep); await approveInvDoc(d.id, appr);
    const r = await postInvDoc(d.id, appr);
    return { ...r, lineIds: r.document.lines.map((l) => l.id) };
  };
  return { prep, appr, acc, vat, rst: rst.id, cafe: cafe.id, I, bands, S, customer, doc };
}
export type W = Awaited<ReturnType<typeof world>>;

/** Journal of a posted document as "code:debit:credit", sorted. */
export async function journal(docId: string) {
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `inventory:${docId}:inv.document.posted` } });
  if (ev?.status === "SKIPPED") return [];
  assert.equal(ev?.status, "TRANSLATED", `${ev?.status} ${ev?.errorMessage ?? ""}`);
  const ls = await prisma.journalEntryLine.findMany({ where: { journalEntryId: ev!.journalEntryId! }, include: { account: true } });
  return ls.map((l) => `${l.account.code}:${l.debit.toFixed(2)}:${l.credit.toFixed(2)}`).sort();
}
export async function gl(w: W, code: string, asOf: string) {
  const r = await prisma.journalEntryLine.aggregate({ where: { accountId: w.acc[code], journalEntry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { lte: accountingDate(asOf) } } }, _sum: { debit: true, credit: true } });
  return dec(String(r._sum.debit ?? 0)).sub(dec(String(r._sum.credit ?? 0))).toFixed(2);
}
