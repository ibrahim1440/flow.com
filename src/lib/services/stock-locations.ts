/**
 * Stock locations — the database side (20261115090000_stock_locations). The rules are in src/lib/inventory/locations.ts
 * (pure); the invariant total = Σ location balances is the database's (trigger stock_balance_sync routes every change of
 * a company-wide total to the transaction's location; stock_balance_total_check refuses a commit where they differ).
 *
 * The "where" of a transaction is the setting hiqbah.stock_location (transaction-local). A location-aware operation
 * sets it (setStockLocation) before it moves a total; every other writer books at the default location — so every
 * writer that existed before locations keeps working unchanged.
 *
 * Master data is owner-managed (inventory › adjust, decided by the routes): add, rename, reorder, make the default,
 * deactivate (refused while it holds stock — «انقل الرصيد أولًا» — and for the default), reactivate, and delete a
 * location that was never used. Every write is one row of the person audit (AuthAuditLog, append-only).
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ipHashOf } from "@/lib/accounting/ops/purchase-activity";
import type { AuditContext } from "@/lib/accounting/audit";
import {
  LOCATION_TYPES, QTY_EPSILON, covers, defaultLocationRefusal, holdsStockRefusal, inactiveRefusal, isLocationType, locationDbRefusal, normalizeLocationCode,
  pickProductionLocation, productionRefusal, shortRefusal, transferLink, type LocationRow, type StockItemKind,
} from "@/lib/inventory/locations";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;
type Fail = { _appCode: number; message: string; errorEn: string; errorAr: string; code: string; location?: Record<string, unknown> };
const fail = (status: number, code: string, ar: string, en: string, location?: Record<string, unknown>): Fail => ({ _appCode: status, message: ar, errorAr: ar, errorEn: en, code, ...(location ? { location } : {}) });

export const LOCATION_ACTIONS = [
  "STOCK_LOCATION_CREATED", "STOCK_LOCATION_UPDATED", "STOCK_LOCATION_REORDERED", "STOCK_LOCATION_DEFAULT_SET",
  "STOCK_LOCATION_DEACTIVATED", "STOCK_LOCATION_REACTIVATED", "STOCK_LOCATION_DELETED",
  "STOCK_LOCATION_PRODUCTION_SET",
] as const;
export type LocationAction = (typeof LOCATION_ACTIONS)[number];

const SELECT = { id: true, code: true, nameAr: true, nameEn: true, type: true, address: true, notes: true, isActive: true, isDefault: true, isProduction: true, sortOrder: true, deactivatedAt: true, deactivatedBy: true, deactivationReason: true, createdAt: true, updatedAt: true } as const;

// ─── The transaction's location ─────────────────────────────────────────────────────────────────

/**
 * Make `locationId` the location of the rest of this transaction's stock changes. Only for a transaction that IS one
 * operation at one site (a roast, a pack, a dispatch); a service called inside a larger transaction uses
 * withStockLocation, which restores the location before it.
 */
export async function setStockLocation(tx: Tx, locationId: string): Promise<void> {
  await tx.$queryRaw`SELECT set_config('hiqbah.stock_location', ${locationId}, true)`;
}

/** Run `fn` with `locationId` as the transaction's location, then restore the one before. */
export async function withStockLocation<T>(tx: Tx, locationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (await tx.$queryRaw<{ v: string | null }[]>`SELECT nullif(current_setting('hiqbah.stock_location', true), '') AS v`)[0]?.v ?? "";
  await setStockLocation(tx, locationId);
  return restoring(fn, () => tx.$queryRaw`SELECT set_config('hiqbah.stock_location', ${prev}, true)`);
}

/**
 * Run `fn`, then `restore`. On a failure the original error wins: after a database error the transaction is aborted
 * (and rolls back, settings included), so a failed restore must not hide what went wrong.
 */
async function restoring<T>(fn: () => Promise<T>, restore: () => Promise<unknown>): Promise<T> {
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    await restore().catch(() => undefined);
    throw e;
  }
  await restore();
  return result;
}

/**
 * Run `fn` as an allowed writer of "StockBalance" (the transfer and location services; stock_balance_guard refuses
 * any other direct write), then restore the setting before.
 */
export async function withBalanceWriter<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const prev = (await tx.$queryRaw<{ v: string | null }[]>`SELECT coalesce(current_setting('hiqbah.stock_balance_writer', true), '') AS v`)[0]?.v ?? "";
  await tx.$queryRaw`SELECT set_config('hiqbah.stock_balance_writer', 'service', true)`;
  return restoring(fn, () => tx.$queryRaw`SELECT set_config('hiqbah.stock_balance_writer', ${prev}, true)`);
}

export async function allLocations(db: Db = prisma): Promise<LocationRow[]> {
  return db.stockLocation.findMany({ select: { id: true, code: true, nameAr: true, nameEn: true, type: true, isActive: true, isDefault: true, isProduction: true, sortOrder: true }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
}

export async function defaultLocationId(db: Db = prisma): Promise<string> {
  const d = await db.stockLocation.findFirst({ where: { isDefault: true }, select: { id: true } });
  if (!d) throw fail(409, "STOCK_LOCATION_NO_DEFAULT", "لا يوجد موقع استلام افتراضي.", "No default receiving location is set.");
  return d.id;
}

/** The production site (roasting draws green from it; packaging draws materials and puts finished lots there). */
export async function productionLocation(db: Db = prisma): Promise<LocationRow> {
  const p = pickProductionLocation(await allLocations(db));
  if (!p) throw fail(409, "STOCK_LOCATION_NO_PRODUCTION", "لا يوجد موقع إنتاج نشط.", "No active production location.");
  return p;
}

/** An active location by id (refused when missing or inactive). */
export async function activeLocation(db: Db, id: unknown): Promise<LocationRow> {
  const l = typeof id === "string" && id ? await db.stockLocation.findUnique({ where: { id }, select: { id: true, code: true, nameAr: true, nameEn: true, type: true, isActive: true, isDefault: true, isProduction: true, sortOrder: true } }) : null;
  if (!l) throw fail(404, "STOCK_LOCATION_NOT_FOUND", "الموقع غير موجود.", "Location not found.");
  if (!l.isActive) { const r = inactiveRefusal(l.nameAr, l.id); throw fail(r.status, r.code, r.error, r.errorEn, { locationId: l.id }); }
  return l;
}

/** The location a receipt should go to: the one asked for (active), else the default. */
export async function receivingLocationId(db: Db, asked: unknown): Promise<string> {
  if (asked === undefined || asked === null || asked === "") return defaultLocationId(db);
  return (await activeLocation(db, asked)).id;
}

/** The site this person last received goods at (their last receipt), when it is still active. */
export async function lastReceivingLocationId(userId: string): Promise<string | null> {
  const r = await prisma.purchaseRecord.findFirst({ where: { userId, location: { isActive: true } }, orderBy: { createdAt: "desc" }, select: { locationId: true } });
  return r?.locationId ?? null;
}

/** The (active) site a document drew its stock at — its OUT movement's location — else the production site. */
export async function drawSiteOf(db: Db, sourceDocType: "ROASTING_BATCH" | "PURCHASE", sourceDocId: string): Promise<string> {
  const m = await db.inventoryMovement.findFirst({ where: { sourceDocType, sourceDocId, quantityChanged: { lt: 0 }, location: { isActive: true } }, orderBy: { timestamp: "asc" }, select: { locationId: true } });
  return m?.locationId ?? (await productionLocation(db)).id;
}

// ─── Balances ───────────────────────────────────────────────────────────────────────────────────

/** The quantity of one item at one location (0 when it holds none). */
export async function locationQty(db: Db, kind: StockItemKind, entityId: string, locationId: string): Promise<number> {
  const b = await db.stockBalance.findUnique({ where: { locationId_itemKind_entityId: { locationId, itemKind: kind, entityId } }, select: { qty: true } });
  return b?.qty ?? 0;
}

/** Per-location balances of items: entityId → [{ locationId, qty }] (only qty > 0). */
export async function balancesOf(db: Db, kind: StockItemKind, ids?: string[]): Promise<Map<string, { locationId: string; qty: number }[]>> {
  const rows = await db.stockBalance.findMany({ where: { itemKind: kind, qty: { gt: 0 }, ...(ids ? { entityId: { in: ids } } : {}) }, select: { entityId: true, locationId: true, qty: true } });
  const out = new Map<string, { locationId: string; qty: number }[]>();
  for (const r of rows) {
    const l = out.get(r.entityId) ?? [];
    l.push({ locationId: r.locationId, qty: r.qty });
    out.set(r.entityId, l);
  }
  return out;
}

/**
 * Refuse (409 STOCK_LOCATION_SHORT, with the figures and a prefilled transfer) when `locationId` holds less than `need`
 * of the item — the friendly form of the database's own refusal. `from` names where the stock is, for the suggestion.
 */
export async function assertLocationHas(db: Db, a: { kind: StockItemKind; entityId: string; locationId: string; need: number }): Promise<void> {
  const have = await locationQty(db, a.kind, a.entityId, a.locationId);
  if (covers(have, a.need)) return;
  const [loc, elsewhere] = await Promise.all([
    db.stockLocation.findUnique({ where: { id: a.locationId }, select: { nameAr: true, nameEn: true } }),
    db.stockBalance.findFirst({ where: { itemKind: a.kind, entityId: a.entityId, locationId: { not: a.locationId }, qty: { gt: 0 }, location: { isActive: true } }, orderBy: { qty: "desc" }, select: { locationId: true, qty: true, location: { select: { nameAr: true, nameEn: true } } } }),
  ]);
  const r = shortRefusal(loc?.nameAr ?? a.locationId, have, a.need);
  const shortBy = Number((a.need - have).toFixed(4));
  throw fail(r.status, r.code, r.error, r.errorEn, {
    locationId: a.locationId, locationName: loc?.nameAr ?? null, locationNameEn: loc?.nameEn ?? null, available: have, requested: a.need, shortBy,
    itemKind: a.kind, entityId: a.entityId,
    from: elsewhere ? { locationId: elsewhere.locationId, nameAr: elsewhere.location.nameAr, nameEn: elsewhere.location.nameEn, qty: elsewhere.qty } : null,
    transferHref: elsewhere ? transferLink({ from: elsewhere.locationId, to: a.locationId, kind: a.kind, item: a.entityId, qty: Math.min(elsewhere.qty, shortBy) }) : null,
  });
}

/** Material balances at the production site (null when the database has no locations — never after the migration). */
export async function productionSiteBalances(db: Db, ids: string[]): Promise<Map<string, number> | null> {
  const site = await productionLocation(db).catch(() => null);
  if (!site) return null;
  const rows = await db.stockBalance.findMany({ where: { locationId: site.id, itemKind: "MATERIAL", entityId: { in: ids } }, select: { entityId: true, qty: true } });
  return new Map(rows.map((r) => [r.entityId, r.qty]));
}

/** What a location holds: green lots / materials with a balance, and finished lots with stock. */
export async function holdings(db: Db, locationId: string) {
  const [green, materials, finished] = await Promise.all([
    // A float residue below the quantity tolerance is not stock (the database guard uses the same tolerance).
    db.stockBalance.count({ where: { locationId, itemKind: "GREEN_BEAN", qty: { gt: QTY_EPSILON } } }),
    db.stockBalance.count({ where: { locationId, itemKind: "MATERIAL", qty: { gt: QTY_EPSILON } } }),
    db.finishedGoodsLot.count({ where: { locationId, OR: [{ unitsAvailable: { gt: 0 } }, { unitsReserved: { gt: 0 } }, { availableQty: { gt: 0 } }, { reservedQty: { gt: 0 } }] } }),
  ]);
  return { green, materials, finished, any: green + materials + finished > 0 };
}

// ─── The master ─────────────────────────────────────────────────────────────────────────────────

/**
 * Every location with what it holds (the master page). Inactive ones only on request. With `withValue` (a viewer who
 * holds the accounting module) each site's ESTIMATED value: Σ its quantity × the item's company-wide moving-average
 * cost — an estimate, valuation is never per site.
 */
export async function listLocations(opts: { includeInactive?: boolean; withValue?: boolean } = {}) {
  const rows = await prisma.stockLocation.findMany({ where: opts.includeInactive ? {} : { isActive: true }, select: SELECT, orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { code: "asc" }] });
  const bal = await prisma.stockBalance.groupBy({ by: ["locationId", "itemKind"], where: { qty: { gt: QTY_EPSILON } }, _count: { _all: true } });
  const fg = await prisma.finishedGoodsLot.groupBy({ by: ["locationId"], where: { OR: [{ unitsAvailable: { gt: 0 } }, { availableQty: { gt: 0 } }] }, _count: { _all: true } });
  const used = new Set((await prisma.inventoryMovement.groupBy({ by: ["locationId"] })).map((r) => r.locationId));
  const value = new Map<string, number>();
  if (opts.withValue) {
    const v = await prisma.$queryRaw<{ l: string; v: number }[]>`
      SELECT b."locationId" AS l, coalesce(sum(b.qty * c."avgCost"::double precision), 0)::double precision AS v
        FROM "StockBalance" b JOIN "CostItem" c ON c."tenantId" = 'hiqbah' AND c.kind = b."itemKind" AND c."entityId" = b."entityId"
       WHERE b.qty > 0 GROUP BY b."locationId"`;
    for (const x of v) value.set(x.l, Math.round(x.v * 100) / 100);
  }
  return rows.map((r) => {
    const green = bal.find((b) => b.locationId === r.id && b.itemKind === "GREEN_BEAN")?._count._all ?? 0;
    const materials = bal.find((b) => b.locationId === r.id && b.itemKind === "MATERIAL")?._count._all ?? 0;
    const finished = fg.find((f) => f.locationId === r.id)?._count._all ?? 0;
    return { ...r, holdings: { green, materials, finished, any: green + materials + finished > 0 }, hasHistory: used.has(r.id), ...(opts.withValue ? { valueEstimate: value.get(r.id) ?? 0 } : {}) };
  });
}

type Actor = { id: string; name?: string | null };

async function logLocation(tx: Tx, ctx: Pick<AuditContext, "actorId" | "ip" | "userAgent" | "reason">, action: LocationAction, loc: { id: string; code: string; nameAr: string; nameEn?: string | null }, extra: Record<string, unknown> = {}) {
  await tx.authAuditLog.create({
    data: {
      userId: ctx.actorId.startsWith("migration:") ? null : ctx.actorId, action, result: "SUCCESS", sourceInterface: "WEB",
      ipHash: await ipHashOf(ctx.ip), userAgent: ctx.userAgent ?? null,
      metadata: JSON.parse(JSON.stringify({ locationId: loc.id, code: loc.code, targetName: loc.nameAr, nameEn: loc.nameEn ?? null, reason: ctx.reason ?? null, ...extra })) as Prisma.InputJsonValue,
    },
  });
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function parseFields(b: Record<string, unknown>, partial: boolean) {
  const out: { code?: string; nameAr?: string; nameEn?: string | null; type?: string; address?: string | null; notes?: string | null } = {};
  if (!partial || b.nameAr !== undefined) {
    const v = text(b.nameAr, 80);
    if (!v) throw fail(400, "LOCATION_NAME_REQUIRED", "اكتب اسم الموقع بالعربية.", "Enter the location's Arabic name.");
    out.nameAr = v;
  }
  if (b.nameEn !== undefined) out.nameEn = text(b.nameEn, 80);
  if (!partial || b.code !== undefined) {
    const c = normalizeLocationCode(b.code);
    if (!c) throw fail(400, "LOCATION_CODE_INVALID", "الرمز من 1 إلى 16 حرفًا إنجليزيًا أو رقمًا أو شرطة.", "The code is 1–16 letters, digits or dashes.");
    out.code = c;
  }
  if (!partial || b.type !== undefined) {
    if (!isLocationType(b.type)) throw fail(400, "LOCATION_TYPE_INVALID", "اختر نوع الموقع.", `Choose the location type (${LOCATION_TYPES.join(", ")}).`);
    out.type = b.type;
  }
  if (b.address !== undefined) out.address = text(b.address, 300);
  if (b.notes !== undefined) out.notes = text(b.notes, 500);
  return out;
}

async function codeTaken(tx: Tx, code: string, except?: string) {
  const hit = await tx.stockLocation.findFirst({ where: { code, ...(except ? { id: { not: except } } : {}) }, select: { id: true } });
  if (hit) throw fail(409, "LOCATION_CODE_TAKEN", `الرمز ${code} مستخدم لموقع آخر.`, `The code ${code} is used by another location.`);
}

/** The database refusals of a location write as coded refusals (the guard trigger, the default check). */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const r = locationDbRefusal(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? ""));
    if (r) throw fail(r.status, r.code, r.error, r.errorEn, r.locationId ? { locationId: r.locationId, transferHref: r.code === "STOCK_LOCATION_HOLDS_STOCK" ? transferLink({ from: r.locationId }) : null } : undefined);
    throw e;
  }
}

export async function createLocation(body: Record<string, unknown>, actor: Actor, ctx: AuditContext) {
  const f = parseFields(body, false);
  return guarded(() => prisma.$transaction(async (tx) => {
    await codeTaken(tx, f.code!);
    const max = await tx.stockLocation.aggregate({ _max: { sortOrder: true } });
    const makeDefault = body.isDefault === true;
    if (makeDefault) await tx.stockLocation.updateMany({ where: { isDefault: true }, data: { isDefault: false, updatedBy: actor.id } });
    const row = await tx.stockLocation.create({
      data: { code: f.code!, nameAr: f.nameAr!, nameEn: f.nameEn ?? null, type: f.type!, address: f.address ?? null, notes: f.notes ?? null, isDefault: makeDefault, sortOrder: (max._max.sortOrder ?? 0) + 1, createdBy: actor.id, updatedBy: actor.id },
      select: SELECT,
    });
    await logLocation(tx, ctx, "STOCK_LOCATION_CREATED", row, { after: { type: row.type, isDefault: row.isDefault } });
    return row;
  }));
}

/** PATCH: rename / code / type / address / notes, and the actions { action: "default" | "production" | "deactivate" | "reactivate" }. */
export async function updateLocation(id: string, body: Record<string, unknown>, actor: Actor, ctx: AuditContext) {
  return guarded(() => prisma.$transaction(async (tx) => {
    const cur = (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "StockLocation" WHERE "id" = ${id} FOR UPDATE`)[0];
    if (!cur) throw fail(404, "STOCK_LOCATION_NOT_FOUND", "الموقع غير موجود.", "Location not found.");
    const before = await tx.stockLocation.findUniqueOrThrow({ where: { id }, select: SELECT });
    const action = typeof body.action === "string" ? body.action : null;
    if (action === "default") {
      if (!before.isActive) { const r = inactiveRefusal(before.nameAr, id); throw fail(r.status, r.code, r.error, r.errorEn); }
      if (before.isDefault) return before;
      const prev = await tx.stockLocation.findFirst({ where: { isDefault: true }, select: { id: true, code: true, nameAr: true } });
      await tx.stockLocation.updateMany({ where: { isDefault: true }, data: { isDefault: false, updatedBy: actor.id } });
      const row = await tx.stockLocation.update({ where: { id }, data: { isDefault: true, updatedBy: actor.id }, select: SELECT });
      await logLocation(tx, ctx, "STOCK_LOCATION_DEFAULT_SET", row, { before: prev ? { defaultLocationId: prev.id, defaultName: prev.nameAr } : null });
      return row;
    }
    if (action === "production") {
      // Where roasting, packing and dispatch draw from, and where a total change with no site named is booked.
      if (!before.isActive) { const r = inactiveRefusal(before.nameAr, id); throw fail(r.status, r.code, r.error, r.errorEn); }
      if (before.isProduction) return before;
      const prev = await tx.stockLocation.findFirst({ where: { isProduction: true }, select: { id: true, nameAr: true } });
      await tx.stockLocation.updateMany({ where: { isProduction: true }, data: { isProduction: false, updatedBy: actor.id } });
      const row = await tx.stockLocation.update({ where: { id }, data: { isProduction: true, updatedBy: actor.id }, select: SELECT });
      await logLocation(tx, ctx, "STOCK_LOCATION_PRODUCTION_SET", row, { before: prev ? { productionLocationId: prev.id, productionName: prev.nameAr } : null });
      return row;
    }
    if (action === "deactivate") {
      const reason = text(body.reason, 300);
      if (!reason || reason.length < 3) throw fail(400, "LOCATION_REASON_REQUIRED", "اكتب سبب الإيقاف (3 أحرف على الأقل).", "Give the reason for deactivating (at least 3 characters).");
      if (!before.isActive) return before;
      if (before.isDefault) { const r = defaultLocationRefusal(before.nameAr, id); throw fail(r.status, r.code, r.error, r.errorEn, { locationId: id }); }
      if (before.isProduction) { const r = productionRefusal(before.nameAr, id); throw fail(r.status, r.code, r.error, r.errorEn, { locationId: id }); }
      const h = await holdings(tx, id);
      if (h.any) { const r = holdsStockRefusal(before.nameAr, id); throw fail(r.status, r.code, r.error, r.errorEn, { locationId: id, holdings: h, transferHref: transferLink({ from: id }) }); }
      const row = await tx.stockLocation.update({ where: { id }, data: { isActive: false, deactivatedAt: new Date(), deactivatedBy: actor.id, deactivationReason: reason, updatedBy: actor.id }, select: SELECT });
      await logLocation(tx, { ...ctx, reason }, "STOCK_LOCATION_DEACTIVATED", row);
      return row;
    }
    if (action === "reactivate") {
      if (before.isActive) return before;
      const row = await tx.stockLocation.update({ where: { id }, data: { isActive: true, deactivatedAt: null, deactivatedBy: null, deactivationReason: null, updatedBy: actor.id }, select: SELECT });
      await logLocation(tx, ctx, "STOCK_LOCATION_REACTIVATED", row, { before: { deactivatedAt: before.deactivatedAt, reason: before.deactivationReason } });
      return row;
    }
    if (action) throw fail(400, "OPS_BAD_INPUT", "إجراء غير معروف.", "Unknown action.");
    const f = parseFields(body, true);
    if (f.code && f.code !== before.code) await codeTaken(tx, f.code, id);
    const row = await tx.stockLocation.update({ where: { id }, data: { ...f, updatedBy: actor.id }, select: SELECT });
    const changed = Object.fromEntries(Object.keys(f).filter((k) => (before as Record<string, unknown>)[k] !== (row as Record<string, unknown>)[k]).map((k) => [k, { from: (before as Record<string, unknown>)[k], to: (row as Record<string, unknown>)[k] }]));
    if (Object.keys(changed).length) await logLocation(tx, ctx, "STOCK_LOCATION_UPDATED", row, { changed });
    return row;
  }));
}

/** The order of the locations (ids, first to last). */
export async function reorderLocations(ids: unknown, actor: Actor, ctx: AuditContext) {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw fail(400, "OPS_BAD_INPUT", "ترتيب غير صالح.", "ids must be an array of location ids.");
  return prisma.$transaction(async (tx) => {
    const rows = await tx.stockLocation.findMany({ where: { id: { in: ids as string[] } }, select: { id: true, code: true, nameAr: true, sortOrder: true } });
    // Only the rows whose place changed, in id order (one lock order everywhere: no deadlock between two reorders).
    const want = new Map((ids as string[]).map((id, i) => [id, i + 1]));
    for (const r of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (r.sortOrder !== want.get(r.id)) await tx.stockLocation.update({ where: { id: r.id }, data: { sortOrder: want.get(r.id)!, updatedBy: actor.id } });
    }
    await tx.authAuditLog.create({
      data: { userId: ctx.actorId, action: "STOCK_LOCATION_REORDERED", result: "SUCCESS", sourceInterface: "WEB", ipHash: await ipHashOf(ctx.ip), userAgent: ctx.userAgent ?? null,
        metadata: { order: (ids as string[]).map((id) => rows.find((r) => r.id === id)?.code ?? id), targetName: "المواقع" } },
    });
    return { ok: true };
  });
}

/** Delete a location that was never used (no movement, balance, lot, receipt, count, delivery, invoice or transfer). */
export async function deleteLocation(id: string, actor: Actor, ctx: AuditContext) {
  return guarded(() => prisma.$transaction(async (tx) => {
    const l = await tx.stockLocation.findUnique({ where: { id }, select: SELECT });
    if (!l) throw fail(404, "STOCK_LOCATION_NOT_FOUND", "الموقع غير موجود.", "Location not found.");
    if (l.isDefault) { const r = defaultLocationRefusal(l.nameAr, id); throw fail(r.status, r.code, r.error, r.errorEn); }
    if (l.isProduction) { const r = productionRefusal(l.nameAr, id); throw fail(r.status, r.code, r.error, r.errorEn); }
    const refs = await Promise.all([
      tx.inventoryMovement.count({ where: { OR: [{ locationId: id }, { counterpartLocationId: id }] } }), tx.stockBalance.count({ where: { locationId: id, qty: { gt: 0 } } }),
      tx.finishedGoodsLot.count({ where: { locationId: id } }), tx.purchaseRecord.count({ where: { locationId: id } }), tx.inventoryCountSession.count({ where: { locationId: id } }),
      tx.delivery.count({ where: { locationId: id } }), tx.supplierInvoice.count({ where: { receivingLocationId: id } }), tx.stockTransfer.count({ where: { OR: [{ fromLocationId: id }, { toLocationId: id }] } }),
    ]);
    if (refs.some((n) => n > 0)) throw fail(409, "STOCK_LOCATION_HAS_HISTORY", `«${l.nameAr}» له حركات وسجل، فلا يُحذف. أوقفه بدلًا من ذلك.`, `«${l.nameAr}» has history, so it is not deleted. Deactivate it instead.`);
    await withBalanceWriter(tx, () => tx.stockBalance.deleteMany({ where: { locationId: id } }));
    await tx.stockLocation.delete({ where: { id } });
    await logLocation(tx, ctx, "STOCK_LOCATION_DELETED", l, { by: actor.id });
    return { ok: true };
  }));
}
