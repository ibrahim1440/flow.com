// Unified inventory phase 4 — the read models of «تقييم المخزون» (accounting › inventory valuation):
//   • valuationReport — every costed holder with its category (phase 1) and its location shares (phase 3), grouped
//                       root → sub-category with a subtotal per inventory account, and per location (an ESTIMATE:
//                       site quantity × the company's moving average — valuation-groups.ts); filters by category and
//                       location. The per-account figures are the cost ledger's and are compared with the GL by
//                       reconciliation() — unchanged.
//   • holderMovements — one holder's cost-ledger movements (the drill-down), each with its source document's page and
//                       its journal entry; Σ movements = the holder's quantity and value.
// Read-only. Gate: requireCostRead (inventory › valuation, or the accounting module), as the A3 valuation.
import { prisma } from "@/lib/db";
import { Decimal, ZERO } from "../money";
import { dayText, riyadhDay } from "../dates";
import { opsRefuse } from "./refusals";
import { qty4 } from "./costing";
import { transferRef } from "@/lib/services/stock-transfers";
import { INVENTORY_ROLES, entities, reconciliation } from "./valuation";
import { groupByCategory, holderCategoryId, inCategory, siteQtyDifference, siteShares, totalsByLocation, totalsByRole, type SiteShare } from "./valuation-groups";
import { legacyMaterialRole } from "@/lib/inventory/item-categories";
import { holderHref, sourceDocHref } from "../source-links";

const f2 = (d: Decimal | string | number) => new Decimal(d).toFixed(2);
const MULTI_SITE = new Set(["GREEN_BEAN", "MATERIAL"]);

async function accountsByRole() {
  const maps = await prisma.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: [...INVENTORY_ROLES] } }, include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } } });
  return new Map(maps.map((m) => [m.role, { id: m.account.id, code: m.account.code, name: m.account.nameAr ?? m.account.nameEn, nameEn: m.account.nameEn ?? m.account.nameAr }]));
}

/** `withGl`: the general-ledger side (balances, differences) — the accounting module only, as reconciliation() itself. */
export type ValuationFilters = { category?: string | null; location?: string | null; withGl?: boolean };

export async function valuationReport(filters: ValuationFilters = {}) {
  const category = typeof filters.category === "string" && filters.category.trim() ? filters.category.trim().slice(0, 64) : null;
  const location = typeof filters.location === "string" && filters.location.trim() ? filters.location.trim().slice(0, 64) : null;
  const [items, cats, locs, accounts] = await Promise.all([
    prisma.costItem.findMany({ where: { OR: [{ qty: { gt: 0 } }, { value: { gt: 0 } }] }, orderBy: [{ role: "asc" }, { kind: "asc" }, { createdAt: "asc" }] }),
    prisma.itemCategory.findMany({ select: { id: true, nameAr: true, nameEn: true, parentId: true, sortOrder: true, inventoryRole: true, isActive: true } }),
    prisma.stockLocation.findMany({ orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { code: "asc" }], select: { id: true, code: true, nameAr: true, nameEn: true, type: true, isActive: true, isProduction: true } }),
    accountsByRole(),
  ]);
  if (category && !cats.some((c) => c.id === category)) throw opsRefuse("OPS_BAD_INPUT", "Unknown category.", "التصنيف غير موجود.");
  if (location && !locs.some((l) => l.id === location)) throw opsRefuse("OPS_BAD_INPUT", "Unknown location.", "الموقع غير موجود.");
  const ents = await entities(items);
  const multi = items.filter((i) => MULTI_SITE.has(i.kind));
  const balances = multi.length ? await prisma.stockBalance.findMany({ where: { qty: { gt: 0 }, OR: [{ itemKind: "GREEN_BEAN", entityId: { in: multi.filter((i) => i.kind === "GREEN_BEAN").map((i) => i.entityId) } }, { itemKind: "MATERIAL", entityId: { in: multi.filter((i) => i.kind === "MATERIAL").map((i) => i.entityId) } }] }, select: { itemKind: true, entityId: true, locationId: true, qty: true } }) : [];
  const balOf = new Map<string, { locationId: string; qty: number }[]>();
  for (const b of balances) { const k = `${b.itemKind}:${b.entityId}`; const l = balOf.get(k) ?? []; l.push({ locationId: b.locationId, qty: b.qty }); balOf.set(k, l); }
  const production = locs.find((l) => l.isProduction)?.id ?? null;
  // Council M1 (merge with 20261117090000): unpacked roasted coffee sits where its roast drew the green — a roaster may
  // have its own site now. drawSiteOf (stock-locations.ts) in one query: the roast's first OUT movement at an active
  // site, else the production site.
  const roastIds = items.filter((i) => i.kind === "ROASTED_BATCH").map((i) => i.entityId);
  const draws = roastIds.length ? await prisma.inventoryMovement.findMany({ where: { sourceDocType: "ROASTING_BATCH", sourceDocId: { in: roastIds }, quantityChanged: { lt: 0 }, location: { isActive: true } }, orderBy: { timestamp: "asc" }, select: { sourceDocId: true, locationId: true } }) : [];
  const roastSite = new Map<string, string>();
  for (const d of draws) if (d.sourceDocId && !roastSite.has(d.sourceDocId)) roastSite.set(d.sourceDocId, d.locationId);
  // Split lots (a transfer split part of a lot into its own lot, with its own cost holder): the source lot, for the link.
  const splitIds = [...new Set([...ents.values()].map((e) => e.splitFromLotId).filter((x): x is string => !!x))];
  const splitSrc = new Map(splitIds.length ? (await prisma.finishedGoodsLot.findMany({ where: { id: { in: splitIds } }, select: { id: true, batchNumber: true } })).map((l) => [l.id, l.batchNumber]) : []);
  const parentOf = new Map(cats.map((c) => [c.id, c.parentId]));
  const catName = new Map(cats.map((c) => [c.id, c]));

  const all = items.map((i) => {
    const e = ents.get(`${i.kind}:${i.entityId}`);
    const categoryId = holderCategoryId(i.kind, e ? { categoryId: e.categoryId, category: e.category } : null);
    // A finished lot at its site («في الطريق» while IN_TRANSIT); unpacked roasted coffee at its roast's site.
    const single = i.kind === "FG_LOT" ? (e?.locationId ?? null) : i.kind === "ROASTED_BATCH" ? roastSite.get(i.entityId) ?? production : null;
    // A single-site holder whose site is unknown (no production site, a lot without one) is unallocated, not guessed.
    const sites: SiteShare[] = MULTI_SITE.has(i.kind) ? siteShares(i, balOf.get(`${i.kind}:${i.entityId}`) ?? [], null) : single ? siteShares(i, [], single) : [];
    const drift = e?.opsQty ? new Decimal(i.qty).minus(e.opsQty) : null;
    const here = location ? sites.find((s) => s.locationId === location) ?? null : null;
    const acc = accounts.get(i.role) ?? null;
    return {
      id: i.id, kind: i.kind, entityId: i.entityId, role: i.role, account: acc ? { code: acc.code, name: acc.name, nameEn: acc.nameEn } : null,
      categoryId, rootId: parentOf.get(categoryId) ?? categoryId, categoryName: catName.get(categoryId)?.nameAr ?? null, categoryNameEn: catName.get(categoryId)?.nameEn ?? null,
      label: e?.label ?? "(محذوف)", sub: e?.sub ?? null, unit: e?.unit ?? "", exists: !!e,
      qty: new Decimal(i.qty).toFixed(), opsQty: e?.opsQty ? e.opsQty.toFixed() : null, avgCost: new Decimal(i.avgCost).toFixed(4), value: f2(i.value),
      uncosted: new Decimal(i.qty).gt(0) && new Decimal(i.value).isZero(), drift: drift && !drift.abs().lt("0.001") ? drift.toFixed() : null,
      sites,
      // Council F1: ledger qty − Σ site qty of a multi-site item (a quantity to count, never money).
      siteQtyDiff: MULTI_SITE.has(i.kind) ? siteQtyDifference(i, balOf.get(`${i.kind}:${i.entityId}`) ?? []) : null,
      noLedger: false,
      splitFrom: e?.splitFromLotId ? { id: e.splitFromLotId, label: splitSrc.get(e.splitFromLotId) ?? e.splitFromLotId, href: holderHref("FG_LOT", { entityId: e.splitFromLotId }) } : null as { id: string; label: string; href: string } | null,
      // What the table shows: the company value, or (location filter) this site's quantity and estimated value.
      shown: location ? { qty: here?.qty ?? "0.0000", value: here?.value ?? "0.00", estimate: true } : { qty: new Decimal(i.qty).toFixed(), value: f2(i.value), estimate: false },
      itemHref: holderHref(i.kind, { labelCode: e?.labelCode ?? null, entityId: i.entityId, categoryId }),
      movementsHref: `/dashboard/accounting/inventory?item=${encodeURIComponent(i.id)}` as string | null,
    };
  });

  // Council F5: stock a site holds that the cost ledger does not value (no holder, or an empty one) — listed «بلا تكلفة»
  // at value 0, so the location view names everything on the shelves.
  const costed = new Set(items.map((i) => `${i.kind}:${i.entityId}`));
  const bare = (await prisma.stockBalance.findMany({ where: { qty: { gt: 0.0005 }, itemKind: { in: ["GREEN_BEAN", "MATERIAL"] } }, select: { itemKind: true, entityId: true, locationId: true, qty: true } }))
    .filter((b) => !costed.has(`${b.itemKind}:${b.entityId}`));
  if (bare.length) {
    const byKey = new Map<string, { kind: string; entityId: string; sites: { locationId: string; qty: number }[] }>();
    for (const b of bare) { const k = `${b.itemKind}:${b.entityId}`; const e = byKey.get(k) ?? { kind: b.itemKind, entityId: b.entityId, sites: [] }; e.sites.push({ locationId: b.locationId, qty: b.qty }); byKey.set(k, e); }
    const list = [...byKey.values()];
    const [bEnts, empty] = await Promise.all([entities(list), prisma.costItem.findMany({ where: { OR: list.map((x) => ({ kind: x.kind, entityId: x.entityId })) }, select: { id: true, kind: true, entityId: true } })]);
    const emptyOf = new Map(empty.map((c) => [`${c.kind}:${c.entityId}`, c.id]));
    for (const x of list) {
      const e = bEnts.get(`${x.kind}:${x.entityId}`);
      const categoryId = holderCategoryId(x.kind, e ? { categoryId: e.categoryId, category: e.category } : null);
      const role = x.kind === "GREEN_BEAN" ? "INVENTORY_GREEN" : catName.get(categoryId)?.inventoryRole ?? legacyMaterialRole(e?.category ?? null);
      const sites = x.sites.map((t) => ({ locationId: t.locationId, qty: new Decimal(t.qty).toFixed(4), value: "0.00" }));
      const here = location ? sites.find((t) => t.locationId === location) ?? null : null;
      const acc = accounts.get(role) ?? null;
      const holderId = emptyOf.get(`${x.kind}:${x.entityId}`) ?? null;
      all.push({
        id: holderId ?? `nc:${x.kind}:${x.entityId}`, kind: x.kind, entityId: x.entityId, role, account: acc ? { code: acc.code, name: acc.name, nameEn: acc.nameEn } : null,
        categoryId, rootId: parentOf.get(categoryId) ?? categoryId, categoryName: catName.get(categoryId)?.nameAr ?? null, categoryNameEn: catName.get(categoryId)?.nameEn ?? null,
        label: e?.label ?? "(محذوف)", sub: e?.sub ?? null, unit: e?.unit ?? "", exists: !!e,
        qty: "0", opsQty: e?.opsQty ? e.opsQty.toFixed() : null, avgCost: "0.0000", value: "0.00", uncosted: true, drift: null, sites, siteQtyDiff: null, noLedger: true, splitFrom: null,
        shown: location ? { qty: here?.qty ?? "0.0000", value: "0.00", estimate: true } : { qty: x.sites.reduce((a, t) => a.plus(qty4(t.qty)), ZERO).toFixed(), value: "0.00", estimate: false },
        itemHref: holderHref(x.kind, { labelCode: e?.labelCode ?? null, entityId: x.entityId, categoryId }),
        movementsHref: holderId ? `/dashboard/accounting/inventory?item=${encodeURIComponent(holderId)}` : null,
      });
    }
  }

  const byCategory = all.filter((r) => inCategory(r.categoryId, category, parentOf));
  const rows = location ? byCategory.filter((r) => r.sites.some((s) => s.locationId === location)) : byCategory;
  const shownRows = rows.map((r) => ({ role: r.role, categoryId: r.categoryId, value: r.shown.value }));
  const rec = filters.withGl ? await reconciliation(null) : null;
  const roleTotals = totalsByRole(shownRows, INVENTORY_ROLES);
  const loc = totalsByLocation(byCategory, locs.map((l) => l.id));
  return {
    asOf: dayText(riyadhDay()),
    filters: { category, location },
    estimate: !!location,
    total: f2(rows.reduce((s, r) => s.plus(r.value), ZERO)),
    shownTotal: f2(shownRows.reduce((s, r) => s.plus(r.value), ZERO)),
    count: rows.length,
    rows,
    categories: groupByCategory(shownRows, cats),
    accounts: roleTotals.map((t) => {
      const g = rec?.inventory.find((x) => x.role === t.role);
      return { ...t, account: accounts.get(t.role) ?? null, ledger: g?.subLedger ?? null, gl: g?.gl ?? null, difference: g?.difference ?? null, unexplained: g?.unexplained ?? null, status: g?.status ?? null };
    }),
    reconciliation: rec ? { ledger: rec.totals.subLedger, gl: rec.totals.gl, difference: rec.totals.difference, unexplained: f2(rec.inventory.reduce((s, x) => s.plus(x.unexplained), ZERO)) } : null,
    // By location (the category filter applies; the location filter does not — every site is listed).
    // Council M2: «في الطريق» (the system TRANSIT location: sent, not yet received) after the real sites, in the Σ.
    locations: [...locs.filter((l) => l.type !== "TRANSIT"), ...locs.filter((l) => l.type === "TRANSIT")]
      .map((l) => ({ ...l, isTransit: l.type === "TRANSIT", value: f2(loc.byLocation.get(l.id)?.value ?? ZERO), count: loc.byLocation.get(l.id)?.count ?? 0 })).filter((l) => l.isActive || l.count > 0),
    unallocated: f2(loc.unallocated),
    unallocatedCount: loc.unallocatedCount,
    // Council F1: the quantity differences (ledger vs the sites) — counted, never balanced with money.
    qtyDifferences: byCategory.filter((r) => r.siteQtyDiff !== null).map((r) => ({ id: r.id, label: r.label, sub: r.sub, unit: r.unit, ledgerQty: r.qty, siteQty: r.sites.reduce((a, t) => a.plus(t.qty), ZERO).toFixed(4), difference: r.siteQtyDiff })),
    uncostedAtSites: byCategory.filter((r) => r.noLedger).length,
    locationsTotal: f2(loc.total),
    categoryOptions: cats.filter((c) => c.isActive || all.some((r) => r.categoryId === c.id)).map((c) => ({ id: c.id, nameAr: c.nameAr, nameEn: c.nameEn, parentId: c.parentId, sortOrder: c.sortOrder })),
  };
}

/** Page size of the drill-down (council F3: newest first; the totals and the tie check are over ALL movements). */
export const MOVES_PAGE = 500;

/** One holder's cost-ledger movements, newest first and paged, each linked to its source document and journal entry. */
export async function holderMovements(costItemId: string, pageIn: number | string | null = 1, pageSize: number = MOVES_PAGE) {
  const h = await prisma.costItem.findUnique({ where: { id: costItemId } });
  if (!h) throw opsRefuse("OPS_NOT_FOUND", "Cost holder not found.", "الصنف غير موجود في سجل التكلفة.");
  const count = await prisma.costMove.count({ where: { costItemId } });
  const pages = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.min(pages, Math.max(1, Math.trunc(Number(pageIn) || 1)));
  const [ents, accounts, moves, agg] = await Promise.all([
    entities([h]),
    accountsByRole(),
    prisma.costMove.findMany({ where: { costItemId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.costMove.aggregate({ where: { costItemId }, _sum: { qty: true, value: true } }),
  ]);
  const e = ents.get(`${h.kind}:${h.entityId}`);
  const categoryId = holderCategoryId(h.kind, e ? { categoryId: e.categoryId, category: e.category } : null);
  const cat = await prisma.itemCategory.findUnique({ where: { id: categoryId }, select: { id: true, nameAr: true, nameEn: true, parent: { select: { id: true, nameAr: true, nameEn: true } } } });

  // What only the database knows about a source: a receipt's purchase invoice, an adjustment's count sheet, the lots a
  // packing run made (one → its page; several → each listed, council F4), a quality decision's outcome (F6).
  const ids = (t: string) => [...new Set(moves.filter((m) => m.sourceType === t).map((m) => m.sourceId))];
  const [grnLines, adjMoves, packLots, dispositions] = await Promise.all([
    ids("GRN").length ? prisma.supplierInvoiceLine.findMany({ where: { purchaseRecordId: { in: ids("GRN") }, invoice: { status: { not: "CANCELLED" } } }, select: { purchaseRecordId: true, invoiceId: true } }) : [],
    ids("STOCK_ADJUSTMENT").length ? prisma.inventoryMovement.findMany({ where: { id: { in: ids("STOCK_ADJUSTMENT") } }, select: { id: true, sourceDocType: true, sourceDocId: true } }) : [],
    ids("PACKAGING_RUN").length ? prisma.costMove.findMany({ where: { sourceType: "PACKAGING_RUN", sourceId: { in: ids("PACKAGING_RUN") }, costItem: { kind: "FG_LOT" } }, select: { sourceId: true, costItem: { select: { entityId: true } } } }) : [],
    ids("QC_DISPOSITION").length ? prisma.qcDisposition.findMany({ where: { id: { in: ids("QC_DISPOSITION") } }, select: { id: true, kind: true, number: true } }) : [],
  ]);
  const sessionIds = adjMoves.filter((m) => m.sourceDocType === "MANUAL_ADJUSTMENT" && m.sourceDocId).map((m) => m.sourceDocId as string);
  const [sessionRows, shortTransfers] = sessionIds.length ? await Promise.all([
    prisma.inventoryCountSession.findMany({ where: { id: { in: sessionIds } }, select: { id: true } }),
    // Council F7 (merge): a transfer's receipt shortfall is written off as an adjustment whose source is the transfer.
    prisma.stockTransfer.findMany({ where: { id: { in: sessionIds } }, select: { id: true, number: true } }),
  ]) : [[], []];
  const sessions = new Set(sessionRows.map((s) => s.id));
  const shortOf = new Map(adjMoves.flatMap((m) => { const t = shortTransfers.find((x) => x.id === m.sourceDocId); return t ? [[m.id, t] as const] : []; }));
  const invoiceOf = new Map(grnLines.map((l) => [l.purchaseRecordId as string, l.invoiceId]));
  const sessionOf = new Map(adjMoves.filter((m) => m.sourceDocId && sessions.has(m.sourceDocId)).map((m) => [m.id, m.sourceDocId as string]));
  const lotsOf = new Map<string, string[]>();
  for (const p of packLots) { const l = lotsOf.get(p.sourceId) ?? []; if (!l.includes(p.costItem.entityId)) l.push(p.costItem.entityId); lotsOf.set(p.sourceId, l); }
  const lotIds = [...new Set([...lotsOf.values()].flat())];
  const lotInfo = new Map(lotIds.length ? (await prisma.finishedGoodsLot.findMany({ where: { id: { in: lotIds } }, select: { id: true, batchNumber: true, productSku: { select: { skuCode: true } } } })).map((l) => [l.id, `${l.productSku?.skuCode ? `${l.productSku.skuCode} · ` : ""}${l.batchNumber}`]) : []);
  const dispOf = new Map(dispositions.map((d) => [d.id, d]));

  const rows = moves.map((m) => {
    const day = dayText(m.businessDay);
    const lots = m.sourceType === "PACKAGING_RUN" ? lotsOf.get(m.sourceId) ?? [] : [];
    const d = m.sourceType === "QC_DISPOSITION" ? dispOf.get(m.sourceId) : undefined;
    const short = m.sourceType === "STOCK_ADJUSTMENT" ? shortOf.get(m.sourceId) : undefined;
    return {
      id: m.id, day, kind: m.kind, qty: new Decimal(m.qty).toFixed(), value: f2(m.value), unitCost: new Decimal(m.unitCost).toFixed(4),
      qtyAfter: new Decimal(m.qtyAfter).toFixed(), valueAfter: f2(m.valueAfter),
      sourceModule: m.sourceModule, sourceType: m.sourceType, sourceId: m.sourceId, sourceEvent: m.sourceEvent,
      // The event as the accountant reads it: a quality decision by its outcome (QC_CONVERT / QC_BLEND / QC_DESTROY).
      eventCode: d ? `QC_${d.kind}` : short ? "TRANSFER_SHORTFALL" : m.sourceEvent, sourceNumber: d?.number ?? (short ? transferRef(short.number) : null),
      docCode: short ? "STOCK_TRANSFER_SHORTFALL" : m.sourceType,
      sourceHref: short ? sourceDocHref("STOCK_TRANSFER", short.id) : lots.length > 1 ? null : sourceDocHref(m.sourceType, m.sourceId, { invoiceId: invoiceOf.get(m.sourceId) ?? null, countSessionId: sessionOf.get(m.sourceId) ?? null, lotId: m.sourceType === "PACKAGING_RUN" ? lots[0] ?? (h.kind === "FG_LOT" ? h.entityId : null) : null, day }, m.sourceModule),
      lots: lots.length > 1 ? lots.map((id) => ({ id, label: lotInfo.get(id) ?? id, href: sourceDocHref("PACKAGING_RUN", m.sourceId, { lotId: id }) as string })) : [],
      journalEntryId: m.journalEntryId, journalHref: m.journalEntryId ? `/dashboard/accounting/journals/${m.journalEntryId}` : null, glState: m.glState, reason: m.reason,
    };
  });
  const acc = accounts.get(h.role) ?? null;
  const q = new Decimal(agg._sum.qty ?? 0), v = new Decimal(agg._sum.value ?? 0);
  return {
    holder: {
      id: h.id, kind: h.kind, entityId: h.entityId, role: h.role, account: acc ? { code: acc.code, name: acc.name, nameEn: acc.nameEn } : null,
      label: e?.label ?? "(محذوف)", sub: e?.sub ?? null, unit: e?.unit ?? "", qty: new Decimal(h.qty).toFixed(), avgCost: new Decimal(h.avgCost).toFixed(4), value: f2(h.value),
      opsQty: e?.opsQty ? e.opsQty.toFixed() : null,
      category: cat ? { id: cat.id, nameAr: cat.nameAr, nameEn: cat.nameEn, parent: cat.parent } : null,
      itemHref: holderHref(h.kind, { labelCode: e?.labelCode ?? null, entityId: h.entityId, categoryId }),
      // A lot split off another by a transfer: its own holder; the source lot for traceability.
      splitFrom: e?.splitFromLotId ? { id: e.splitFromLotId, label: (await prisma.finishedGoodsLot.findUnique({ where: { id: e.splitFromLotId }, select: { batchNumber: true } }))?.batchNumber ?? e.splitFromLotId, href: holderHref("FG_LOT", { entityId: e.splitFromLotId }) } : null,
    },
    moves: rows,
    paging: { page, pages, pageSize, count },
    // Over ALL movements (an aggregate), whatever page is shown.
    totals: { qty: q.toFixed(), value: f2(v), ties: q.eq(h.qty) && v.eq(h.value) },
  };
}
