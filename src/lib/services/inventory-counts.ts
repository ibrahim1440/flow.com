/**
 * Count sessions («الجرد والتسويات») — the database side. The rules are in
 * src/lib/inventory/counts.ts (pure); the movement / balance / audit of a posted line is the shared
 * adjustment service (applyInventoryAdjustment), the same code a single count goes through.
 *
 * Permissions (decided by the routes, before any of this runs):
 *   · read                         — the inventory module;
 *   · start / count / edit / cancel — inventory › receive or inventory › adjust (the catalogue
 *     maintenance duty, as for bean records): entering a counted quantity changes no stock;
 *   · post                         — inventory › adjust through stockChangeGate (privileged:
 *     verified individual, username + PIN, fresh step-up; SIMPLE MODE as elsewhere).
 *
 * Phase 3 (20261115090000_stock_locations): a session counts ONE location (InventoryCountSession.locationId, chosen
 * when it is started; default: the default site). Its lines' system quantities are that location's balances, and
 * posting adjusts that location's balance (and the company-wide total by the same variance).
 */
import { flushPostings } from "@/lib/accounting/ops/cost-ledger";
import { prisma } from "@/lib/db";
import type { Db } from "@/lib/hr/core";
import { parseStockQuantity } from "./stock-quantity";
import { applyInventoryAdjustment, type AdjustmentUser } from "./inventory-adjustment";
import { activeLocation, defaultLocationId } from "./stock-locations";
import {
  MAX_COUNT_LINES, isBookable, isCountCategory, lineVariance, postBlocker, postedBalance, summarizeCount,
  type CountCategory,
} from "@/lib/inventory/counts";

type AppError = { _appCode: number; message: string; code?: string };
const fail = (status: number, code: string, message: string): AppError => ({ _appCode: status, code, message });

export type CountItemRef = { category: CountCategory; entityId: string };

/** Current balances (at `locationId`, else the company-wide total), names and units of the items on a sheet (green coffee in kg). */
async function itemsOf(db: Db, refs: CountItemRef[], locationId?: string | null) {
  const beanIds = refs.filter((r) => r.category === "RAW_MATERIAL").map((r) => r.entityId);
  const matIds = refs.filter((r) => r.category === "PACKAGING_MATERIAL").map((r) => r.entityId);
  const [beans, mats] = await Promise.all([
    beanIds.length ? db.greenBean.findMany({ where: { id: { in: beanIds } }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, process: true, processAr: true, location: true, quantityKg: true, isActive: true } }) : [],
    matIds.length ? db.materialItem.findMany({ where: { id: { in: matIds } }, select: { id: true, code: true, name: true, nameAr: true, category: true, unitOfMeasure: true, quantityOnHand: true, isActive: true } }) : [],
  ]);
  const map = new Map<string, { name: string; nameAr: string | null; code: string; sub: string | null; subAr: string | null; unit: string; qty: number; isActive: boolean }>();
  for (const b of beans) map.set(`RAW_MATERIAL:${b.id}`, { name: b.beanType, nameAr: b.beanTypeAr, code: b.serialNumber, sub: b.location, subAr: b.location, unit: "KG", qty: b.quantityKg, isActive: b.isActive });
  for (const m of mats) map.set(`PACKAGING_MATERIAL:${m.id}`, { name: m.name, nameAr: m.nameAr, code: m.code, sub: m.category, subAr: m.category, unit: m.unitOfMeasure, qty: m.quantityOnHand, isActive: m.isActive });
  if (locationId && refs.length) {
    const bal = await db.stockBalance.findMany({ where: { locationId, OR: [{ itemKind: "GREEN_BEAN", entityId: { in: beanIds } }, { itemKind: "MATERIAL", entityId: { in: matIds } }] }, select: { itemKind: true, entityId: true, qty: true } });
    const at = new Map(bal.map((b) => [`${b.itemKind === "GREEN_BEAN" ? "RAW_MATERIAL" : "PACKAGING_MATERIAL"}:${b.entityId}`, b.qty]));
    for (const [k, v] of map) v.qty = at.get(k) ?? 0;
  }
  return map;
}

/** Validate and de-duplicate requested items; every one must exist. */
async function resolveItems(db: Db, raw: unknown, locationId?: string | null): Promise<CountItemRef[]> {
  if (!Array.isArray(raw)) throw fail(400, "COUNT_ITEMS_INVALID", "items must be an array of { category, entityId }.");
  const seen = new Set<string>();
  const refs: CountItemRef[] = [];
  for (const it of raw) {
    const r = (it ?? {}) as Record<string, unknown>;
    if (!isCountCategory(r.category) || typeof r.entityId !== "string" || !r.entityId) {
      throw fail(400, "COUNT_ITEMS_INVALID", "Each item needs category RAW_MATERIAL or PACKAGING_MATERIAL and an entityId.");
    }
    const k = `${r.category}:${r.entityId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    refs.push({ category: r.category, entityId: r.entityId });
  }
  const found = await itemsOf(db, refs, locationId);
  const missing = refs.filter((r) => !found.has(`${r.category}:${r.entityId}`));
  if (missing.length) throw fail(404, "COUNT_ITEM_NOT_FOUND", `Item not found: ${missing.map((m) => m.entityId).join(", ")}.`);
  return refs;
}

const cleanText = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

export async function listCountSessions(limit = 50) {
  const sessions = await prisma.inventoryCountSession.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { lines: { select: { category: true, systemQty: true, countedQty: true } }, location: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
  });
  const userIds = [...new Set(sessions.flatMap((s) => [s.createdById, s.postedById]).filter((x): x is string => !!x))];
  const emps = userIds.length ? await prisma.employee.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const name = new Map(emps.map((e) => [e.id, e.name]));
  return sessions.map(({ lines, ...s }) => ({
    ...s,
    createdByName: s.createdById ? name.get(s.createdById) ?? null : null,
    postedByName: s.postedById ? name.get(s.postedById) ?? null : null,
    summary: summarizeCount(lines.map((l) => ({ ...l, category: l.category as CountCategory }))),
  }));
}

export async function getCountSession(id: string, db: Db = prisma) {
  const s = await db.inventoryCountSession.findUnique({ where: { id }, include: { lines: { orderBy: { createdAt: "asc" } }, location: { select: { id: true, code: true, nameAr: true, nameEn: true, isActive: true } } } });
  if (!s) return null;
  const items = await itemsOf(db, s.lines.map((l) => ({ category: l.category as CountCategory, entityId: l.entityId })), s.locationId);
  const userIds = [...new Set([s.createdById, s.postedById, s.cancelledById, ...s.lines.map((l) => l.countedById)].filter((x): x is string => !!x))];
  const emps = userIds.length ? await db.employee.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const name = new Map(emps.map((e) => [e.id, e.name]));
  const lines = s.lines.map((l) => {
    const it = items.get(`${l.category}:${l.entityId}`);
    const variance = lineVariance(l);
    return {
      ...l,
      item: it ? { name: it.name, nameAr: it.nameAr, code: it.code, sub: it.sub, unit: it.unit, isActive: it.isActive } : null,
      /** The live balance now (for an OPEN session: what posting will start from). */
      currentQty: it ? it.qty : null,
      variance,
      bookable: isBookable(variance),
      countedByName: l.countedById ? name.get(l.countedById) ?? null : null,
    };
  });
  return {
    ...s,
    lines,
    createdByName: s.createdById ? name.get(s.createdById) ?? null : null,
    postedByName: s.postedById ? name.get(s.postedById) ?? null : null,
    cancelledByName: s.cancelledById ? name.get(s.cancelledById) ?? null : null,
    summary: summarizeCount(s.lines.map((l) => ({ ...l, category: l.category as CountCategory }))),
  };
}

/** Start a session with the chosen items; each line snapshots the balance it starts from. */
export async function createCountSession(user: { id: string }, body: Record<string, unknown>) {
  return prisma.$transaction(async (tx) => {
    // The location counted: an active one, or the default site.
    const locationId = body.locationId ? (await activeLocation(tx, body.locationId)).id : await defaultLocationId(tx);
    const refs = await resolveItems(tx, body.items, locationId);
    if (refs.length === 0) throw fail(400, "COUNT_EMPTY", "Choose at least one item to count.");
    if (refs.length > MAX_COUNT_LINES) throw fail(400, "COUNT_TOO_LARGE", `At most ${MAX_COUNT_LINES} items per count.`);
    const items = await itemsOf(tx, refs, locationId);
    const s = await tx.inventoryCountSession.create({
      data: {
        locationId,
        title: cleanText(body.title, 120),
        notes: cleanText(body.notes, 500),
        createdById: user.id,
        lines: { create: refs.map((r) => ({ category: r.category, entityId: r.entityId, systemQty: items.get(`${r.category}:${r.entityId}`)!.qty })) },
      },
    });
    return s.id;
  });
}

/**
 * Edit an OPEN sheet: enter / clear counted quantities (`lines: [{ id, countedQty|null, notes? }]`),
 * add items (`add: [{ category, entityId }]`) and remove lines (`remove: [lineId]`). Entering a
 * counted quantity re-captures the line's system balance at that moment (lineVariance).
 */
export async function updateCountSession(user: { id: string }, id: string, body: Record<string, unknown>) {
  return prisma.$transaction(async (tx) => {
    // Serialise against a concurrent post / cancel of the same sheet.
    const locked = await tx.$queryRaw<{ status: string; locationId: string }[]>`SELECT "status"::text AS "status", "locationId" FROM "InventoryCountSession" WHERE "id" = ${id} FOR UPDATE`;
    if (!locked[0]) throw fail(404, "COUNT_NOT_FOUND", "Count not found.");
    if (locked[0].status !== "OPEN") throw fail(409, "COUNT_NOT_OPEN", "This count is no longer open.");
    const at = locked[0].locationId;

    if (body.title !== undefined || body.notes !== undefined) {
      await tx.inventoryCountSession.update({ where: { id }, data: { ...(body.title !== undefined ? { title: cleanText(body.title, 120) } : {}), ...(body.notes !== undefined ? { notes: cleanText(body.notes, 500) } : {}) } });
    }

    if (body.remove !== undefined) {
      if (!Array.isArray(body.remove) || body.remove.some((x) => typeof x !== "string")) throw fail(400, "COUNT_LINES_INVALID", "remove must be an array of line ids.");
      await tx.inventoryCountLine.deleteMany({ where: { sessionId: id, id: { in: body.remove as string[] } } });
    }

    if (body.add !== undefined) {
      const refs = await resolveItems(tx, body.add, at);
      const existing = await tx.inventoryCountLine.count({ where: { sessionId: id } });
      if (existing + refs.length > MAX_COUNT_LINES) throw fail(400, "COUNT_TOO_LARGE", `At most ${MAX_COUNT_LINES} items per count.`);
      const items = await itemsOf(tx, refs, at);
      await tx.inventoryCountLine.createMany({
        data: refs.map((r) => ({ sessionId: id, category: r.category, entityId: r.entityId, systemQty: items.get(`${r.category}:${r.entityId}`)!.qty })),
        skipDuplicates: true,
      });
    }

    if (body.lines !== undefined) {
      if (!Array.isArray(body.lines)) throw fail(400, "COUNT_LINES_INVALID", "lines must be an array of { id, countedQty }.");
      const ids = body.lines.map((l) => (l as Record<string, unknown>)?.id).filter((x): x is string => typeof x === "string");
      const rows = await tx.inventoryCountLine.findMany({ where: { sessionId: id, id: { in: ids } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const items = await itemsOf(tx, rows.map((r) => ({ category: r.category as CountCategory, entityId: r.entityId })), at);
      for (const raw of body.lines) {
        const l = (raw ?? {}) as Record<string, unknown>;
        const row = typeof l.id === "string" ? byId.get(l.id) : undefined;
        if (!row) throw fail(404, "COUNT_LINE_NOT_FOUND", "Line not found on this count.");
        const it = items.get(`${row.category}:${row.entityId}`);
        if (!it) throw fail(404, "COUNT_ITEM_NOT_FOUND", "The counted item no longer exists.");
        const data: Record<string, unknown> = {};
        if (l.notes !== undefined) data.notes = cleanText(l.notes, 300);
        if (l.countedQty === null) {
          Object.assign(data, { countedQty: null, countedAt: null, countedById: null, systemQty: it.qty });
        } else if (l.countedQty !== undefined) {
          // Green coffee in kg (fractions allowed); a material in its own unit (PIECE / UNIT whole).
          const parsed = parseStockQuantity(l.countedQty, { allowZero: true, unitOfMeasure: row.category === "PACKAGING_MATERIAL" ? it.unit : undefined });
          if (!parsed.ok) throw fail(400, "COUNT_QUANTITY_INVALID", `Counted quantity ${parsed.message}.`);
          Object.assign(data, { countedQty: parsed.value, countedAt: new Date(), countedById: user.id, systemQty: it.qty });
        }
        if (Object.keys(data).length) await tx.inventoryCountLine.update({ where: { id: row.id }, data });
      }
    }
    await tx.inventoryCountSession.update({ where: { id }, data: { updatedAt: new Date() } });
    return id;
  });
}

export async function cancelCountSession(user: { id: string }, id: string) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "InventoryCountSession" WHERE "id" = ${id} FOR UPDATE`;
    if (!locked[0]) throw fail(404, "COUNT_NOT_FOUND", "Count not found.");
    if (locked[0].status !== "OPEN") throw fail(409, "COUNT_NOT_OPEN", "This count is no longer open.");
    await tx.inventoryCountSession.update({ where: { id }, data: { status: "CANCELLED", cancelledById: user.id, cancelledAt: new Date() } });
    return id;
  });
}

/**
 * Post the sheet in ONE transaction: every counted line whose variance is bookable becomes an
 * ADJUSTMENT through applyInventoryAdjustment (balance = current + variance, see postedBalance),
 * the line records what was booked, and the session turns POSTED. Any failure (a negative
 * resulting balance, a deleted item) rolls the whole post back: a count is posted entirely or not
 * at all. The reason (normalizeAdjustmentReason, by the route) is the movements' note, followed by
 * the line's own note when it has one.
 */
export async function postCountSession(user: AdjustmentUser, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: string; number: number; locationId: string }[]>`SELECT "status"::text AS "status", "number", "locationId" FROM "InventoryCountSession" WHERE "id" = ${id} FOR UPDATE`;
    if (!locked[0]) throw fail(404, "COUNT_NOT_FOUND", "Count not found.");
    const lines = await tx.inventoryCountLine.findMany({ where: { sessionId: id }, orderBy: [{ category: "asc" }, { entityId: "asc" }] });
    const summary = summarizeCount(lines.map((l) => ({ ...l, category: l.category as CountCategory })));
    const blocked = postBlocker(locked[0].status, summary);
    if (blocked === "COUNT_NOT_OPEN") throw fail(409, blocked, "This count is no longer open.");
    if (blocked === "COUNT_EMPTY") throw fail(409, blocked, "This count has no items.");
    if (blocked === "COUNT_INCOMPLETE") throw fail(409, blocked, `${summary.uncounted} item(s) are not counted yet: count them or remove them from the sheet.`);

    let booked = 0;
    // Lines are taken in a fixed (category, entityId) order so two concurrent posts that share
    // items lock the rows in the same order (no deadlock).
    for (const l of lines) {
      const variance = lineVariance(l);
      if (!isBookable(variance)) continue;
      const note = l.notes ? `${reason} — ${l.notes}` : reason;
      const r = await applyInventoryAdjustment(tx, user, {
        kind: l.category === "RAW_MATERIAL" ? "GREEN_BEAN" : "MATERIAL",
        entityId: l.entityId,
        target: (current) => postedBalance(current, variance),
        reason: note,
        sourceDocId: id,
        locationId: locked[0].locationId,
        details: { countSessionId: id, countNumber: locked[0].number, countLineId: l.id, systemQtyAtCount: l.systemQty, countedQty: l.countedQty, variance },
      });
      await tx.inventoryCountLine.update({
        where: { id: l.id },
        data: { postedPreviousQty: r.previousQuantity, postedNewQty: r.newQuantity, postedVariance: r.quantityChanged, movementId: r.movementId },
      });
      if (!r.noChange) booked++;
    }
    await tx.inventoryCountSession.update({ where: { id }, data: { status: "POSTED", postedById: user.id, postedAt: new Date(), postReason: reason } });
    await flushPostings(tx);
    return { id, booked, lines: lines.length };
  }, { timeout: 30_000 });
}
