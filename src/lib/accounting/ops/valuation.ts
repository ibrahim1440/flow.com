// Accounting A3 — the inventory read models and the go-live tool (Figma ACC-100; «تقييم المخزون» since phase 4):
//   • valuation        — every costed holder: on-hand (cost ledger and operations), average cost, value, by role;
//   • reconciliation   — the cost / AP / GRNI sub-ledgers against their GL control accounts, with the reconciling
//                        items (movements the engine skipped, an opening not yet posted) and what is left unexplained;
//   • batch costs      — production cost per roast: green cost, loss (normal / abnormal), cost per roasted kg;
//   • opening valuation — at go-live: on-hand × (owner-entered or last-known cost) → the cost ledger (OPENING
//                        movements) and the inventory lines of A1's opening-balance grid. History is never posted.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { Decimal, ZERO, roundMoney } from "../money";
import { dayText, parseBusinessDay, riyadhDay } from "../dates";
import { setAuditContext, type AuditContext } from "../audit";
import { checkDimensions, checkLineAccount, loadAccounts, type NormalLine } from "../posting-engine";
import { openingDeferrals } from "../deferrals";
import { qty4, unitCost } from "./costing";
import { costSet, lockHolder, type CostKind, type InventoryRole } from "./cost-ledger";
import { opsRefuse } from "./refusals";
import { apAging, openReceipts } from "./ap";
import { apNotInBooks, claimsNotInBooks } from "./supplier-claims";
import { materialInventoryRole } from "@/lib/inventory/item-categories";

export const INVENTORY_ROLES: InventoryRole[] = ["INVENTORY_GREEN", "INVENTORY_PACKAGING", "INVENTORY_CAFE", "INVENTORY_ROASTED", "INVENTORY_PACKED"];
const f2 = (d: Decimal | Prisma.Decimal | number) => new Decimal(d).toFixed(2);

/** `labelCode` (a green lot's page), `categoryId` / `category` (a material's), `locationId` (a finished lot's site): phase 4. */
export type Entity = { label: string; sub: string | null; opsQty: Decimal | null; unit: string; exists: boolean; labelCode?: string | null; categoryId?: string | null; category?: string | null; locationId?: string | null; splitFromLotId?: string | null; lotStatus?: string | null };

/** Names and operational on-hand of the holders' entities (one query per kind). */
export async function entities(list: { kind: string; entityId: string }[]): Promise<Map<string, Entity>> {
  const ids = (k: string) => list.filter((x) => x.kind === k).map((x) => x.entityId);
  const out = new Map<string, Entity>();
  const [g, m, b, l] = await Promise.all([
    prisma.greenBean.findMany({ where: { id: { in: ids("GREEN_BEAN") } }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, countryAr: true, country: true, quantityKg: true, labelCode: true } }),
    prisma.materialItem.findMany({ where: { id: { in: ids("MATERIAL") } }, select: { id: true, code: true, name: true, nameAr: true, quantityOnHand: true, unitOfMeasure: true, categoryId: true, category: true } }),
    prisma.roastingBatch.findMany({ where: { id: { in: ids("ROASTED_BATCH") } }, select: { id: true, batchNumber: true, roastedAvailableKg: true, status: true, product: { select: { productNameEn: true, productNameAr: true } } } }),
    prisma.finishedGoodsLot.findMany({ where: { id: { in: ids("FG_LOT") } }, select: { id: true, batchNumber: true, status: true, isUnitTracked: true, unitsAvailable: true, locationId: true, splitFromLotId: true, availableQty: true, actualContentGrams: true, productSku: { select: { skuCode: true, weightGrams: true, nameAr: true, name: true } }, product: { select: { productNameEn: true, productNameAr: true } } } }),
  ]);
  for (const x of g) out.set(`GREEN_BEAN:${x.id}`, { label: `${x.beanTypeAr ?? x.beanType} · ${x.countryAr ?? x.country}`, sub: x.serialNumber, opsQty: qty4(x.quantityKg), unit: "kg", exists: true, labelCode: x.labelCode });
  for (const x of m) out.set(`MATERIAL:${x.id}`, { label: x.nameAr ?? x.name, sub: x.code, opsQty: qty4(x.quantityOnHand), unit: String(x.unitOfMeasure).toLowerCase(), exists: true, categoryId: x.categoryId, category: String(x.category) });
  for (const x of b) out.set(`ROASTED_BATCH:${x.id}`, { label: x.product ? (x.product.productNameAr ?? x.product.productNameEn) : "—", sub: x.batchNumber, opsQty: qty4(x.roastedAvailableKg), unit: "kg", exists: true });
  for (const x of l) out.set(`FG_LOT:${x.id}`, { label: x.productSku ? (x.productSku.nameAr ?? x.productSku.name ?? x.productSku.skuCode) : x.product.productNameAr ?? x.product.productNameEn, sub: `${x.productSku?.skuCode ?? ""} · ${x.batchNumber}`, opsQty: qty4(lotKg(x)), unit: "kg", exists: true, locationId: x.locationId, splitFromLotId: x.splitFromLotId, lotStatus: x.status });
  return out;
}

/** A finished lot's physical kilograms now (units × pack weight, a partial package's content, or the legacy kg). */
export function lotKg(x: { status: string; isUnitTracked: boolean; unitsAvailable: number; availableQty: number; actualContentGrams: number | null; productSku: { weightGrams: number } | null }): number {
  if (x.status === "SHIPPED") return 0;
  if (!x.isUnitTracked) return x.availableQty;
  if (x.status === "PARTIAL") return (x.actualContentGrams ?? 0) / 1000;
  return (x.unitsAvailable * (x.actualContentGrams ?? x.productSku?.weightGrams ?? 0)) / 1000;
}

export async function valuation(opts: { includeZero?: boolean } = {}) {
  const items = await prisma.costItem.findMany({ where: opts.includeZero ? {} : { OR: [{ qty: { gt: 0 } }, { value: { gt: 0 } }] }, orderBy: [{ role: "asc" }, { kind: "asc" }] });
  const ents = await entities(items);
  const byRole = new Map<string, { value: Decimal; count: number }>();
  const rows = items.map((i) => {
    const e = ents.get(`${i.kind}:${i.entityId}`);
    const r = byRole.get(i.role) ?? { value: ZERO, count: 0 };
    r.value = r.value.plus(i.value); r.count += 1; byRole.set(i.role, r);
    const drift = e?.opsQty ? new Decimal(i.qty).minus(e.opsQty) : null;
    return {
      id: i.id, kind: i.kind, entityId: i.entityId, role: i.role, label: e?.label ?? "(محذوف)", sub: e?.sub ?? null, unit: e?.unit ?? "", exists: !!e,
      qty: new Decimal(i.qty).toFixed(), opsQty: e?.opsQty ? e.opsQty.toFixed() : null, avgCost: new Decimal(i.avgCost).toFixed(4), value: f2(i.value),
      lastInCost: i.lastInCost ? new Decimal(i.lastInCost).toFixed(4) : null, drift: drift && !drift.abs().lt("0.001") ? drift.toFixed() : null,
      uncosted: new Decimal(i.qty).gt(0) && new Decimal(i.value).isZero(),
    };
  });
  const total = rows.reduce((s, r) => s.plus(r.value), ZERO);
  return { asOf: dayText(riyadhDay()), total: total.toFixed(2), roles: INVENTORY_ROLES.map((role) => ({ role, value: f2(byRole.get(role)?.value ?? ZERO), count: byRole.get(role)?.count ?? 0 })), rows };
}

/** GL balance (debit − credit) of each role's account, all posted entries to `asOf`. */
async function glByRole(roles: string[], asOf: Date): Promise<Map<string, { accountId: string; code: string; name: string; balance: Decimal } | null>> {
  const maps = await prisma.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: roles } }, include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } } });
  const out = new Map<string, { accountId: string; code: string; name: string; balance: Decimal } | null>(roles.map((r) => [r, null]));
  const accIds = [...new Set(maps.map((m) => m.accountId))];
  const bal = accIds.length ? await prisma.$queryRaw<{ accountId: string; bal: Decimal }[]>`
    SELECT l."accountId", coalesce(sum(l."debit") - sum(l."credit"), 0) AS bal FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE l."accountId" = ANY(${accIds}) AND e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" <= ${asOf} GROUP BY l."accountId"` : [];
  const b = new Map(bal.map((x) => [x.accountId, new Decimal(x.bal)]));
  for (const m of maps) out.set(m.role, { accountId: m.accountId, code: m.account.code, name: m.account.nameAr ?? m.account.nameEn, balance: b.get(m.accountId) ?? ZERO });
  return out;
}

/** The sub-ledgers ↔ the GL control accounts. Sub-ledger = what the operations hold; GL = what the books hold. */
export async function reconciliation(asOfText: string | null) {
  const asOf = asOfText ? parseBusinessDay(asOfText) : riyadhDay();
  const roles = [...INVENTORY_ROLES, "WIP_ROASTING", "GRNI", "AP", "SUPPLIER_CLAIMS"];
  const gl = await glByRole(roles, asOf);
  const applied = (await prisma.costingSettings.findUnique({ where: { id: "singleton" }, select: { openingAppliedAt: true } }))?.openingAppliedAt ?? null;
  // Movements up to the opening valuation are summed into the opening grid (the valuation sets absolute values);
  // after it, each movement is either in the GL (POSTED) or a reconciling item (SKIPPED / NONE).
  const sub = await prisma.$queryRaw<{ role: string; glState: string; after: boolean; v: Decimal }[]>`
    SELECT i."role", m."glState", (${applied}::timestamp IS NULL OR m."createdAt" > ${applied}::timestamp) AS "after", coalesce(sum(m."value"), 0) AS v
      FROM "CostMove" m JOIN "CostItem" i ON i."id" = m."costItemId"
     WHERE m."businessDay" <= ${asOf} GROUP BY 1, 2, 3`;
  const settings = await prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { openingEntryId: true, goLiveDate: true, accountingActive: true } });
  const openingPosted = !!settings?.openingEntryId;
  const sum = (role: string, pred: (s: { glState: string; after: boolean }) => boolean) => sub.filter((s) => s.role === role && pred(s)).reduce((a, s) => a.plus(s.v), ZERO);
  const inventory = INVENTORY_ROLES.map((role) => {
    const subLedger = sum(role, () => true);
    const g = gl.get(role);
    const glBal = g?.balance ?? ZERO;
    const skipped = sum(role, (s) => s.after && s.glState === "SKIPPED");
    const none = sum(role, (s) => s.after && s.glState === "NONE");
    const openingPending = applied && !openingPosted ? sum(role, (s) => !s.after && s.glState !== "POSTED") : ZERO;
    const difference = subLedger.minus(glBal);
    const unexplained = difference.minus(skipped).minus(openingPending).minus(none);
    return { role, account: g ? { id: g.accountId, code: g.code, name: g.name } : null, subLedger: f2(subLedger), gl: f2(glBal), difference: f2(difference), skipped: f2(skipped), openingPending: f2(openingPending), unexplained: f2(unexplained), status: difference.isZero() ? "MATCHED" : unexplained.isZero() ? "EXPLAINED" : "UNEXPLAINED" };
  });
  const wip = gl.get("WIP_ROASTING");
  // GRNI: costed receipts not yet invoiced (posted ones) against the GRNI account (credit-normal).
  const receipts = (await openReceipts(null)).filter((r) => r.date <= dayText(asOf));
  const grniDocs = receipts.filter((r) => r.glState === "POSTED").reduce((s, r) => s.plus(r.value), ZERO);
  const grniGl = (gl.get("GRNI")?.balance ?? ZERO).negated();
  const ap = await apAging(dayText(asOf), null);
  const apGl = ap.gl ? new Decimal(ap.gl.balance) : ZERO;
  // «نقص من المورد» (council F1): the open claims (net) against SUPPLIER_CLAIMS; claims the books do not hold yet
  // (approved before go-live) are a reconciling item until the opening carrying them is posted.
  const openClaims = await prisma.supplierClaim.findMany({ where: { status: "OPEN", createdAt: { lte: new Date(asOf.getTime() + 86_399_999 - 3 * 3600_000) } }, select: { net: true, settledNet: true } });
  const claimsSub = openClaims.reduce((t, c) => t.plus(c.net).minus(c.settledNet), ZERO);
  const claimsGl = gl.get("SUPPLIER_CLAIMS")?.balance ?? ZERO;
  const claimsPending = openingPosted ? ZERO : [...(await claimsNotInBooks()).values()].reduce((t, v) => t.plus(v), ZERO);
  const claimsDiff = claimsSub.minus(claimsGl);
  return {
    asOf: dayText(asOf), active: !!settings?.accountingActive, goLiveDate: settings?.goLiveDate ? dayText(settings.goLiveDate) : null, openingPosted, openingAppliedAt: applied?.toISOString() ?? null,
    inventory,
    totals: { subLedger: f2(inventory.reduce((s, r) => s.plus(r.subLedger), ZERO)), gl: f2(inventory.reduce((s, r) => s.plus(r.gl), ZERO)), difference: f2(inventory.reduce((s, r) => s.plus(r.difference), ZERO)) },
    wip: { account: wip ? { id: wip.accountId, code: wip.code, name: wip.name } : null, gl: f2(wip?.balance ?? ZERO), expected: "0.00" },
    // «بضاعة مستلمة لم تُرحَّل فاتورتها» (phase 4, council F2): split into receipts with no invoice yet and receipts whose
    // invoice exists but is not posted (a draft, or awaiting approval).
    grni: {
      account: gl.get("GRNI") ? { code: gl.get("GRNI")!.code, name: gl.get("GRNI")!.name } : null, openReceipts: f2(grniDocs), gl: f2(grniGl), difference: f2(grniDocs.minus(grniGl)), count: receipts.length,
      noInvoice: { count: receipts.filter((r) => !r.invoice).length, value: f2(receipts.filter((r) => !r.invoice).reduce((a, r) => a.plus(r.value), ZERO)) },
      awaitingApproval: { count: receipts.filter((r) => !!r.invoice).length, value: f2(receipts.filter((r) => !!r.invoice).reduce((a, r) => a.plus(r.value), ZERO)) },
    },
    ap: { account: gl.get("AP") ? { code: gl.get("AP")!.code, name: gl.get("AP")!.name } : null, openItems: ap.total, gl: f2(apGl), difference: f2(new Decimal(ap.total).minus(apGl)) },
    supplierClaims: {
      account: gl.get("SUPPLIER_CLAIMS") ? { code: gl.get("SUPPLIER_CLAIMS")!.code, name: gl.get("SUPPLIER_CLAIMS")!.name } : null, count: openClaims.length,
      openClaims: f2(claimsSub), gl: f2(claimsGl), difference: f2(claimsDiff), openingPending: f2(claimsPending), unexplained: f2(claimsDiff.minus(claimsPending)),
      status: claimsDiff.isZero() ? "MATCHED" : claimsDiff.minus(claimsPending).isZero() ? "EXPLAINED" : "UNEXPLAINED",
    },
  };
}

/** Production cost per roast: green cost, loss (normal / abnormal), roasted cost per kg. */
export async function batchCosts(fromText: string | null, toText: string | null) {
  const to = toText ? parseBusinessDay(toText) : riyadhDay();
  const from = fromText ? parseBusinessDay(fromText) : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  const end = new Date(to.getTime() + 86_400_000 + 3 * 3600_000);
  const start = new Date(from.getTime() - 3 * 3600_000);
  const batches = await prisma.roastingBatch.findMany({ where: { isBlend: false, date: { gte: start, lt: end } }, orderBy: { date: "desc" }, take: 500, select: { id: true, batchNumber: true, date: true, greenBeanQuantity: true, roastedBeanQuantity: true, status: true, product: { select: { productNameEn: true, productNameAr: true } }, greenBean: { select: { serialNumber: true } } } });
  const moves = await prisma.costMove.findMany({ where: { sourceType: "ROAST_BATCH", sourceId: { in: batches.map((b) => b.id) }, sourceEvent: { in: ["GREEN_ISSUED", "COMPLETED"] } }, select: { sourceId: true, sourceEvent: true, value: true, glState: true, journalEntryId: true } });
  const holders = await prisma.costItem.findMany({ where: { kind: "ROASTED_BATCH", entityId: { in: batches.map((b) => b.id) } }, select: { entityId: true, qty: true, value: true } });
  const hOf = new Map(holders.map((h) => [h.entityId, h]));
  let tg = ZERO, tr = ZERO, tAb = ZERO, gkg = ZERO, rkg = ZERO;
  const rows = batches.map((b) => {
    const g = moves.find((m) => m.sourceId === b.id && m.sourceEvent === "GREEN_ISSUED");
    const c = moves.find((m) => m.sourceId === b.id && m.sourceEvent === "COMPLETED");
    const greenCost = g ? new Decimal(g.value).abs() : null;
    const roastedCost = c ? new Decimal(c.value) : null;
    const abnormal = greenCost && roastedCost ? greenCost.minus(roastedCost) : null;
    const gk = qty4(b.greenBeanQuantity), rk = qty4(b.roastedBeanQuantity);
    const lossKg = gk.minus(rk);
    if (greenCost) { tg = tg.plus(greenCost); gkg = gkg.plus(gk); }
    if (roastedCost) { tr = tr.plus(roastedCost); rkg = rkg.plus(rk); }
    if (abnormal) tAb = tAb.plus(abnormal);
    const h = hOf.get(b.id);
    return {
      id: b.id, batchNumber: b.batchNumber, date: dayText(riyadhDay(b.date)), status: b.status, product: b.product ? (b.product.productNameAr ?? b.product.productNameEn) : null, greenLot: b.greenBean?.serialNumber ?? null,
      greenKg: gk.toFixed(), roastedKg: rk.toFixed(), lossKg: lossKg.toFixed(), lossPct: gk.gt(0) ? lossKg.times(100).dividedBy(gk).toFixed(2) : null,
      greenCost: greenCost ? f2(greenCost) : null, greenUnitCost: greenCost && gk.gt(0) ? unitCost(greenCost, gk).toFixed(4) : null,
      roastedCost: roastedCost ? f2(roastedCost) : null, abnormalCost: abnormal ? f2(abnormal) : null, normalLossCost: greenCost && roastedCost && gk.gt(0) ? f2(roundMoney(greenCost.times(Decimal.max(lossKg, ZERO)).dividedBy(gk)).minus(abnormal ?? ZERO)) : null,
      roastedUnitCost: roastedCost && rk.gt(0) ? unitCost(roastedCost, rk).toFixed(4) : null,
      remainingKg: h ? new Decimal(h.qty).toFixed() : null, remainingValue: h ? f2(h.value) : null,
      posted: g?.glState === "POSTED", journalEntryId: c?.journalEntryId ?? null,
    };
  });
  return {
    from: dayText(from), to: dayText(to), rows,
    totals: { greenKg: gkg.toFixed(), roastedKg: rkg.toFixed(), greenCost: f2(tg), roastedCost: f2(tr), abnormalCost: f2(tAb), lossPct: gkg.gt(0) ? gkg.minus(rkg).times(100).dividedBy(gkg).toFixed(2) : null, roastedUnitCost: rkg.gt(0) ? unitCost(tr, rkg).toFixed(4) : null },
  };
}

// ─── Costing settings ────────────────────────────────────────────────────────────────────────────

export async function getCostingSettings() {
  const s = await prisma.costingSettings.findUnique({ where: { id: "singleton" } });
  return { abnormalRoastLossPct: s?.abnormalRoastLossPct ? new Decimal(s.abnormalRoastLossPct).toFixed(2) : null, abnormalUseProductLimit: !!s?.abnormalUseProductLimit, openingAppliedAt: s?.openingAppliedAt?.toISOString() ?? null, openingAppliedBy: s?.openingAppliedBy ?? null, updatedAt: s?.updatedAt?.toISOString() ?? null, updatedBy: s?.updatedBy ?? null };
}

export async function setAbnormalThreshold(v: unknown, ctx: AuditContext, useProductLimit?: unknown) {
  let pct: Decimal | null = null;
  if (v !== null && v !== undefined && v !== "") {
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(String(v).trim())) throw opsRefuse("THRESHOLD_INVALID");
    pct = new Decimal(String(v).trim());
  }
  await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const product = typeof useProductLimit === "boolean" ? { abnormalUseProductLimit: useProductLimit } : {};
    await tx.costingSettings.upsert({ where: { id: "singleton" }, create: { id: "singleton", abnormalRoastLossPct: pct, ...product, updatedBy: ctx.actorId }, update: { abnormalRoastLossPct: pct, ...product, updatedBy: ctx.actorId } });
  }, TX_OPTS);
  return getCostingSettings();
}

// ─── The opening inventory valuation ─────────────────────────────────────────────────────────────

export type OpeningRow = { kind: CostKind; entityId: string; label: string; sub: string | null; role: InventoryRole; unit: string; qty: string; unitCost: string | null; source: "OWNER" | "MOVING_AVG" | "LAST_RECEIPT" | "LAST_PURCHASE" | "NONE"; value: string };

/** What is on hand NOW (operations), with the cost the valuation would use. */
export async function openingPreview() {
  const [greens, mats, batches, lots, owner, items] = await Promise.all([
    prisma.greenBean.findMany({ where: { quantityKg: { gt: 0 } }, select: { id: true } }),
    prisma.materialItem.findMany({ where: { quantityOnHand: { gt: 0 } }, select: { id: true, category: true, itemCategory: { select: { inventoryRole: true } } } }),
    prisma.roastingBatch.findMany({ where: { roastedAvailableKg: { gt: 0.0005 } }, select: { id: true } }),
    prisma.finishedGoodsLot.findMany({ where: { status: { not: "SHIPPED" } }, select: { id: true } }),
    prisma.inventoryOpeningCost.findMany(),
    prisma.costItem.findMany(),
  ]);
  const list: { kind: CostKind; entityId: string; role: InventoryRole }[] = [
    ...greens.map((g) => ({ kind: "GREEN_BEAN" as CostKind, entityId: g.id, role: "INVENTORY_GREEN" as InventoryRole })),
    // A material by its item category's role (legacy enum rule as the fallback) — the same rule as roleFor.
    ...mats.map((m) => ({ kind: "MATERIAL" as CostKind, entityId: m.id, role: materialInventoryRole(m) as InventoryRole })),
    ...batches.map((b) => ({ kind: "ROASTED_BATCH" as CostKind, entityId: b.id, role: "INVENTORY_ROASTED" as InventoryRole })),
    ...lots.map((l) => ({ kind: "FG_LOT" as CostKind, entityId: l.id, role: "INVENTORY_PACKED" as InventoryRole })),
  ];
  const ents = await entities(list);
  const ownerOf = new Map(owner.map((o) => [`${o.kind}:${o.entityId}`, new Decimal(o.unitCost)]));
  const itemOf = new Map(items.map((i) => [`${i.kind}:${i.entityId}`, i]));
  const lastPurchase = new Map<string, Decimal>();
  const purchases = await prisma.purchaseRecord.findMany({ where: { OR: [{ type: "GREEN_BEAN", itemId: { in: greens.map((g) => g.id) } }, { materialItemId: { in: mats.map((m) => m.id) } }] }, orderBy: { purchaseDate: "asc" }, select: { type: true, itemId: true, materialItemId: true, costPerUnit: true } });
  for (const p of purchases) {
    if (p.type === "GREEN_BEAN" && p.itemId) lastPurchase.set(`GREEN_BEAN:${p.itemId}`, new Decimal(p.costPerUnit.toFixed(6)));
    else if (p.materialItemId) lastPurchase.set(`MATERIAL:${p.materialItemId}`, new Decimal(p.costPerUnit.toFixed(6)));
  }
  const rows: OpeningRow[] = [];
  for (const x of list) {
    const k = `${x.kind}:${x.entityId}`;
    const e = ents.get(k);
    const qty = e?.opsQty ?? ZERO;
    if (!qty.gt(0)) continue;
    const it = itemOf.get(k);
    let unit: Decimal | null = null, source: OpeningRow["source"] = "NONE";
    if (ownerOf.has(k)) { unit = ownerOf.get(k)!; source = "OWNER"; }
    else if (it && new Decimal(it.qty).gt(0) && new Decimal(it.value).gt(0)) { unit = new Decimal(it.avgCost); source = "MOVING_AVG"; }
    else if (it?.lastInCost && new Decimal(it.lastInCost).gt(0)) { unit = new Decimal(it.lastInCost); source = "LAST_RECEIPT"; }
    else if (lastPurchase.has(k)) { unit = lastPurchase.get(k)!; source = "LAST_PURCHASE"; }
    rows.push({ kind: x.kind, entityId: x.entityId, label: e?.label ?? "—", sub: e?.sub ?? null, role: (it?.role as InventoryRole) ?? x.role, unit: e?.unit ?? "", qty: qty.toFixed(), unitCost: unit ? unit.toFixed(6) : null, source, value: unit ? roundMoney(qty.times(unit)).toFixed(2) : "0.00" });
  }
  const st = await prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { goLiveDate: true, openingEntryId: true } });
  const cs = await getCostingSettings();
  const byRole = INVENTORY_ROLES.map((role) => ({ role, value: f2(rows.filter((r) => r.role === role).reduce((s, r) => s.plus(r.value), ZERO)), count: rows.filter((r) => r.role === role).length }));
  const grni = (await openReceipts(null)).filter((r) => r.glState !== "POSTED");
  // «نقص من المورد» (council F1): the open claims the books do not hold yet (Dr SUPPLIER_CLAIMS per supplier), and the AP
  // opening the pre-go-live invoices imply per supplier (gross − paid − credited) against the AP lines of the grid.
  const claimsMap = await claimsNotInBooks();
  const apMap = await apNotInBooks();
  const apRole = await prisma.accountRole.findUnique({ where: { tenantId_role: { tenantId: "hiqbah", role: "AP" } }, select: { accountId: true } });
  const apGrid = apRole ? await prisma.openingBalanceLine.groupBy({ by: ["partyId"], where: { accountId: apRole.accountId, partyType: "SUPPLIER" }, _sum: { credit: true, debit: true } }) : [];
  const gridOf = new Map(apGrid.map((g) => [g.partyId ?? "", new Decimal(g._sum.credit ?? 0).minus(g._sum.debit ?? 0)]));
  const supIds = [...new Set([...claimsMap.keys(), ...apMap.keys()])];
  const names = new Map((supIds.length ? await prisma.supplier.findMany({ where: { id: { in: supIds } }, select: { id: true, name: true } }) : []).map((x) => [x.id, x.name]));
  return {
    goLiveDate: st?.goLiveDate ? dayText(st.goLiveDate) : null, openingPosted: !!st?.openingEntryId, appliedAt: cs.openingAppliedAt,
    rows, byRole, total: f2(rows.reduce((s, r) => s.plus(r.value), ZERO)), missing: rows.filter((r) => r.source === "NONE").length,
    grni: { count: grni.length, value: f2(grni.reduce((s, r) => s.plus(r.value), ZERO)) },
    supplierClaims: { count: claimsMap.size, value: f2([...claimsMap.values()].reduce((t, v) => t.plus(v), ZERO)), suppliers: [...claimsMap].map(([id, v]) => ({ supplierId: id, name: names.get(id) ?? id, value: f2(v) })) },
    // «قوالب التأجيل» (council F2): the deferrals the books do not hold at go-live, per balance-sheet account — with the
    // amount the owner already typed on that account in the opening grid (any line not the tool's own): both would count.
    deferrals: await deferralsWithGrid(),
    apOpening: [...apMap].map(([id, v]) => ({ supplierId: id, name: names.get(id) ?? id, expected: f2(v), grid: f2(gridOf.get(id) ?? ZERO), difference: f2(v.minus(gridOf.get(id) ?? ZERO)) })),
  };
}

/** Council follow-up: each opening deferral line beside the manual opening-grid amount on the same account (natural side). */
async function deferralsWithGrid(db: Prisma.TransactionClient | typeof prisma = prisma) {
  const defs = await openingDeferrals(db);
  if (!defs.length) return [];
  const grid = await db.openingBalanceLine.groupBy({ by: ["accountId"], where: { accountId: { in: defs.map((d) => d.accountId) }, NOT: { description: DEFERRALS_MARK } }, _sum: { debit: true, credit: true } });
  const net = new Map(grid.map((g) => [g.accountId, new Decimal(g._sum.debit ?? 0).minus(g._sum.credit ?? 0)]));
  return defs.map((d) => {
    const n = net.get(d.accountId) ?? ZERO;
    const manual = d.kind === "PREPAID_EXPENSE" ? n : n.negated();
    return { ...d, manualInGrid: f2(manual), doubleRisk: !manual.isZero() };
  });
}

/** Save the owner's unit costs (null = forget, use the last known). Before the opening is posted only. */
export async function saveOpeningCosts(list: unknown, ctx: AuditContext) {
  if (!Array.isArray(list) || list.length > 5000) throw opsRefuse("OPS_BAD_INPUT", "costs is an array.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    if ((await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { openingEntryId: true } }))?.openingEntryId) throw opsRefuse("OPENING_ALREADY_POSTED");
    let n = 0;
    for (const raw of list as { kind?: string; entityId?: string; unitCost?: string | number | null; note?: string | null }[]) {
      const kind = String(raw?.kind ?? "");
      const entityId = String(raw?.entityId ?? "");
      if (!["GREEN_BEAN", "MATERIAL", "ROASTED_BATCH", "FG_LOT"].includes(kind) || !entityId) throw opsRefuse("OPS_BAD_INPUT", "kind / entityId.");
      if (raw.unitCost === null || raw.unitCost === undefined || raw.unitCost === "") { await tx.inventoryOpeningCost.deleteMany({ where: { kind, entityId } }); n++; continue; }
      const t = String(raw.unitCost).trim();
      if (!/^\d{1,12}(\.\d{1,6})?$/.test(t)) throw opsRefuse("COST_UNIT_INVALID");
      const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, 300) : null;
      await tx.inventoryOpeningCost.upsert({ where: { kind_entityId: { kind, entityId } }, create: { kind, entityId, unitCost: new Decimal(t), note, updatedBy: ctx.actorId }, update: { unitCost: new Decimal(t), note, updatedBy: ctx.actorId } });
      n++;
    }
    return { saved: n };
  }, TX_OPTS);
}

const TOOL_MARK = "مخزون افتتاحي";
const GRNI_MARK = "بضاعة مستلمة لم تصل فاتورتها (افتتاحي)";
const CLAIMS_MARK = "مطالبات الموردين المفتوحة (افتتاحي)";
const DEFERRALS_MARK = "المؤجلات غير المعترف بها (افتتاحي)";

/**
 * Apply the valuation: every holder is set to its on-hand × unit cost (OPENING movements; holders no longer on hand
 * go to zero), and A1's opening-balance grid gets one debit line per inventory account (replacing the tool's previous
 * lines; every other line of the grid is kept) plus a GRNI credit per supplier for costed receipts received before
 * go-live and not yet invoiced. Repeatable until the opening is posted.
 */
export async function applyOpening(ctx: AuditContext) {
  const preview = await openingPreview();
  if (preview.openingPosted) throw opsRefuse("OPENING_ALREADY_POSTED");
  const stamp = `opening-${Date.now().toString(36)}`;
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? "opening inventory valuation" });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('accounting:opening', 0))`;
    if ((await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { openingEntryId: true } }))?.openingEntryId) throw opsRefuse("OPENING_ALREADY_POSTED");
    const day = riyadhDay();
    const src = (kind: string, id: string) => ({ module: "inventory" as const, type: "OPENING_VALUATION", id: stamp, event: `${kind}.${id}`.slice(0, 120) });
    const seen = new Set<string>();
    for (const r of preview.rows) {
      const h = await lockHolder(tx, r.kind, r.entityId, r.role);
      await costSet(tx, { holder: h, src: src(r.kind, r.entityId), kind: "OPENING", qty: new Decimal(r.qty), value: new Decimal(r.value), actor: ctx.actorId, day, reason: `تقييم افتتاحي (${r.source})` });
      seen.add(`${r.kind}:${r.entityId}`);
    }
    const stale = await tx.costItem.findMany({ where: { OR: [{ qty: { gt: 0 } }, { value: { gt: 0 } }] }, select: { kind: true, entityId: true } });
    for (const s of stale) {
      if (seen.has(`${s.kind}:${s.entityId}`)) continue;
      const h = await lockHolder(tx, s.kind as CostKind, s.entityId);
      await costSet(tx, { holder: h, src: src(s.kind, s.entityId), kind: "OPENING", qty: ZERO, value: ZERO, actor: ctx.actorId, day, reason: "تقييم افتتاحي: لا رصيد" });
    }
    // The opening grid: replace the tool's own lines, keep everything the owner entered.
    const roleRows = await tx.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: [...INVENTORY_ROLES, "GRNI", "SUPPLIER_CLAIMS"] } }, select: { role: true, accountId: true } });
    const acc = new Map(roleRows.map((r) => [r.role, r.accountId]));
    const missing = [...INVENTORY_ROLES, "GRNI", "SUPPLIER_CLAIMS"].filter((r) => !acc.has(r) && (r === "GRNI" ? Number(preview.grni.value) > 0 : r === "SUPPLIER_CLAIMS" ? Number(preview.supplierClaims.value) > 0 : Number(preview.byRole.find((b) => b.role === r)?.value ?? 0) > 0));
    if (missing.length) throw opsRefuse("OPS_BAD_INPUT", `Map these roles first: ${missing.join(", ")}.`, `اربط هذه الأدوار أولًا: ${missing.join("، ")}.`);
    const grid = await tx.openingBalanceLine.findMany({ orderBy: { lineNo: "asc" } });
    const kept = grid.filter((l) => !(l.description ?? "").startsWith(TOOL_MARK) && l.description !== GRNI_MARK && l.description !== CLAIMS_MARK && l.description !== DEFERRALS_MARK);
    const add: { accountId: string; debit: Decimal; credit: Decimal; partyType: string | null; partyId: string | null; description: string }[] = [];
    // The grid carries what the GL does not hold yet: the valuation, less what the engine already posted (a tool
    // applied after go-live day would otherwise count those movements twice).
    const posted = await tx.$queryRaw<{ role: string; v: Decimal }[]>`
      SELECT i."role", coalesce(sum(m."value"), 0) AS v FROM "CostMove" m JOIN "CostItem" i ON i."id" = m."costItemId" WHERE m."glState" = 'POSTED' GROUP BY 1`;
    const postedOf = new Map(posted.map((p) => [p.role, new Decimal(p.v)]));
    for (const b of preview.byRole) {
      const v = new Decimal(b.value).minus(postedOf.get(b.role) ?? ZERO);
      if (!v.isZero()) add.push({ accountId: acc.get(b.role) as string, debit: v.gt(0) ? v : ZERO, credit: v.lt(0) ? v.abs() : ZERO, partyType: null, partyId: null, description: `${TOOL_MARK} · ${b.count} صنفًا` });
    }
    const grni = (await openReceipts(null)).filter((r) => r.glState !== "POSTED");
    const bySupplier = new Map<string, Decimal>();
    for (const g of grni) bySupplier.set(g.supplierId, (bySupplier.get(g.supplierId) ?? ZERO).plus(g.value));
    for (const [sid, v] of bySupplier) if (v.gt(0)) add.push({ accountId: acc.get("GRNI") as string, debit: ZERO, credit: v, partyType: "SUPPLIER", partyId: sid, description: GRNI_MARK });
    // «نقص من المورد» (council F1): the open claims the books do not hold yet — Dr SUPPLIER_CLAIMS per supplier at the net.
    for (const [sid, v] of await claimsNotInBooks(tx)) if (v.gt(0)) add.push({ accountId: acc.get("SUPPLIER_CLAIMS") as string, debit: v, credit: ZERO, partyType: "SUPPLIER", partyId: sid, description: CLAIMS_MARK });
    // «المؤجلات غير المعترف بها» (council F2): per balance-sheet account — a prepaid expense a debit, a deferred revenue a credit.
    for (const d of await openingDeferrals(tx)) {
      const v = new Decimal(d.amount);
      if (v.gt(0)) add.push({ accountId: d.accountId, debit: d.kind === "PREPAID_EXPENSE" ? v : ZERO, credit: d.kind === "PREPAID_EXPENSE" ? ZERO : v, partyType: null, partyId: null, description: DEFERRALS_MARK });
    }
    const all = [...kept.map((l) => ({ accountId: l.accountId, debit: new Decimal(l.debit), credit: new Decimal(l.credit), partyType: l.partyType, partyId: l.partyId, branchId: l.branchId, costCenterId: l.costCenterId, description: l.description })), ...add.map((a) => ({ ...a, branchId: null, costCenterId: null }))];
    const accounts = await loadAccounts(tx, all.map((l) => l.accountId));
    const dims = (l: (typeof all)[number]): NormalLine["dims"] => ({ branchId: l.branchId, costCenterId: l.costCenterId, partyType: (l.partyType as NormalLine["dims"]["partyType"]) ?? null, partyId: l.partyId, itemType: null, itemId: null });
    for (const l of all) checkLineAccount(accounts.get(l.accountId), { dims: dims(l) });
    await checkDimensions(tx, all.map((l) => ({ dims: dims(l) })));
    await tx.openingBalanceLine.deleteMany({});
    if (all.length) await tx.openingBalanceLine.createMany({ data: all.map((l, i) => ({ lineNo: i + 1, accountId: l.accountId, debit: l.debit, credit: l.credit, partyType: l.partyType, partyId: l.partyId, branchId: l.branchId, costCenterId: l.costCenterId, description: l.description, updatedBy: ctx.actorId })) });
    await tx.costingSettings.upsert({ where: { id: "singleton" }, create: { id: "singleton", openingAppliedAt: new Date(), openingAppliedBy: ctx.actorId, updatedBy: ctx.actorId }, update: { openingAppliedAt: new Date(), openingAppliedBy: ctx.actorId, updatedBy: ctx.actorId } });
    const doubleRisk = (await deferralsWithGrid(tx)).filter((d) => d.doubleRisk).map((d) => ({ code: d.code, tool: d.amount, manual: d.manualInGrid }));
    return { doubleRisk, applied: preview.rows.length, cleared: stale.length - [...seen].filter((k) => stale.some((s) => `${s.kind}:${s.entityId}` === k)).length, gridLines: add.length, total: preview.total, grni: preview.grni };
  }, { ...TX_OPTS, timeout: 120_000 });
}
