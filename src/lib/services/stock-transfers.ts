/**
 * «تحويل مخزون» — stock transfers between locations (20261115090000_stock_locations).
 *
 * One step («تحويل فوري»): in ONE transaction both balances move ("StockBalance", the company-wide total untouched),
 * each line writes an OUT movement at the source and an IN movement at the destination (sourceDocType STOCK_TRANSFER,
 * the transfer's id on both, the other site as counterpart; their before / after are the LOCATION's balance), and the
 * cost ledger records TRANSFER_OUT then TRANSFER_IN on the item's one holder — same quantity, same value (the moving
 * average), glState NONE: no journal entry. Valuation is company-wide: same legal entity, same inventory account
 * (accounting council 01 «inter-branch transfers at cost, no revenue»; 02 a transfer is an inventory event that posts
 * nothing within one role). A cancel reverses the movements, only while the goods are all still at the destination.
 *
 * Two-step (send → in transit → receive) is NOT built in this phase (owner decision listed in the phase report).
 *
 * Locking: the stock rows (GreenBean / MaterialItem) first, in (kind, id) order — the one direction every stock
 * operation takes, so a transfer and a roast / receipt / count of the same item serialise — then the cost holders.
 * Every action is one row of the person audit (AuthAuditLog): STOCK_TRANSFER_CREATED / STOCK_TRANSFER_CANCELLED.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { ipHashOf } from "@/lib/accounting/ops/purchase-activity";
import { costIn, costOut, flushPostings, lockHolders, resolveNone, type CostKind, type HolderRow } from "@/lib/accounting/ops/cost-ledger";
import { qty4 } from "@/lib/accounting/ops/costing";
import { dayText, parseBusinessDay, riyadhDay } from "@/lib/accounting/dates";
import { covers, locationName, parseTransferLines, shortRefusal, inactiveRefusal, type StockItemKind } from "@/lib/inventory/locations";
import { locationQty, withBalanceWriter } from "./stock-locations";

type Tx = Prisma.TransactionClient;
type Fail = { _appCode: number; message: string; errorEn: string; errorAr: string; code: string; location?: Record<string, unknown> };
const fail = (status: number, code: string, ar: string, en: string, location?: Record<string, unknown>): Fail => ({ _appCode: status, message: ar, errorAr: ar, errorEn: en, code, ...(location ? { location } : {}) });

export const TRANSFER_ACTIONS = ["STOCK_TRANSFER_CREATED", "STOCK_TRANSFER_CANCELLED"] as const;
export const transferRef = (n: number) => `TR-${String(n).padStart(5, "0")}`;
const r4 = (n: number) => Number(n.toFixed(4));

type Actor = { id: string; name?: string | null };
type ItemInfo = { kind: StockItemKind; id: string; code: string; name: string; nameAr: string | null; unit: string; isActive: boolean };

/** Names, codes and units of the items on transfer lines. */
export async function itemInfo(db: Tx | typeof prisma, refs: { itemKind: string; entityId: string }[]): Promise<Map<string, ItemInfo>> {
  const g = refs.filter((r) => r.itemKind === "GREEN_BEAN").map((r) => r.entityId);
  const m = refs.filter((r) => r.itemKind === "MATERIAL").map((r) => r.entityId);
  const [beans, mats] = await Promise.all([
    g.length ? db.greenBean.findMany({ where: { id: { in: g } }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true, isActive: true } }) : [],
    m.length ? db.materialItem.findMany({ where: { id: { in: m } }, select: { id: true, code: true, name: true, nameAr: true, unitOfMeasure: true, isActive: true } }) : [],
  ]);
  const out = new Map<string, ItemInfo>();
  for (const b of beans) out.set(`GREEN_BEAN:${b.id}`, { kind: "GREEN_BEAN", id: b.id, code: b.serialNumber, name: b.beanType, nameAr: b.beanTypeAr, unit: "KG", isActive: b.isActive });
  for (const x of mats) out.set(`MATERIAL:${x.id}`, { kind: "MATERIAL", id: x.id, code: x.code, name: x.name, nameAr: x.nameAr, unit: x.unitOfMeasure, isActive: x.isActive });
  return out;
}

async function logTransfer(tx: Tx, ctx: Pick<AuditContext, "actorId" | "ip" | "userAgent" | "reason">, action: (typeof TRANSFER_ACTIONS)[number], t: { id: string; number: number }, extra: Record<string, unknown>) {
  await tx.authAuditLog.create({
    data: {
      userId: ctx.actorId, action, result: "SUCCESS", sourceInterface: "WEB", ipHash: await ipHashOf(ctx.ip), userAgent: ctx.userAgent ?? null,
      metadata: JSON.parse(JSON.stringify({ transferId: t.id, number: t.number, targetName: transferRef(t.number), reason: ctx.reason ?? null, ...extra })) as Prisma.InputJsonValue,
    },
  });
}

async function lockItems(tx: Tx, lines: { itemKind: string; entityId: string }[]) {
  const sorted = [...lines].sort((a, b) => (a.itemKind + a.entityId < b.itemKind + b.entityId ? -1 : 1));
  for (const l of sorted) {
    const hit = l.itemKind === "GREEN_BEAN"
      ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "GreenBean" WHERE "id" = ${l.entityId} FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MaterialItem" WHERE "id" = ${l.entityId} FOR UPDATE`;
    if (!hit[0]) throw fail(404, "STOCK_ITEM_INVALID", "صنف المخزون غير موجود.", "Stock item not found.");
  }
}

/** Move one line's quantity between two balances: the two movements and the two cost moves (net zero, glState NONE). */
async function moveLine(tx: Tx, a: {
  transfer: { id: string; number: number }; lineNo: number; kind: StockItemKind; entityId: string; qty: number; from: string; to: string;
  holder: HolderRow; day: Date; actor: string; events: [string, string]; note: string;
}) {
  const fromQty = await locationQty(tx, a.kind, a.entityId, a.from);
  const toQty = await locationQty(tx, a.kind, a.entityId, a.to);
  // Total-preserving, unrounded: what leaves the source is exactly what arrives (a balance may carry more decimals than
  // a quantity — a count's or a draw's — and Σ must stay the total to the millionth; rounding is for display only).
  const fromAfter = Math.max(0, fromQty - a.qty);
  const toAfter = toQty + (fromQty - fromAfter);
  const key = (locationId: string) => ({ locationId_itemKind_entityId: { locationId, itemKind: a.kind, entityId: a.entityId } });
  await withBalanceWriter(tx, async () => {
    await tx.stockBalance.update({ where: key(a.from), data: { qty: fromAfter } });
    await tx.stockBalance.upsert({ where: key(a.to), create: { locationId: a.to, itemKind: a.kind, entityId: a.entityId, qty: toAfter }, update: { qty: toAfter } });
  });
  const category = a.kind === "GREEN_BEAN" ? "RAW_MATERIAL" : "PACKAGING_MATERIAL";
  const common = { category, referenceEntityId: a.entityId, sourceDocType: "STOCK_TRANSFER", sourceDocId: a.transfer.id, transferId: a.transfer.id, userId: a.actor, notes: a.note.slice(0, 1000) } as const;
  const out = await tx.inventoryMovement.create({ data: { ...common, type: "OUT", quantityChanged: -(fromQty - fromAfter), previousQuantity: fromQty, newQuantity: fromAfter, locationId: a.from, counterpartLocationId: a.to } });
  const inn = await tx.inventoryMovement.create({ data: { ...common, type: "IN", quantityChanged: fromQty - fromAfter, previousQuantity: toQty, newQuantity: toAfter, locationId: a.to, counterpartLocationId: a.from } });
  // The cost ledger: out at the moving average, in at exactly the same quantity and value — the holder is unchanged.
  const src = { module: "inventory" as const, type: "STOCK_TRANSFER", id: a.transfer.id };
  const lineKey = String(a.lineNo);
  const co = await costOut(tx, { holder: a.holder, src: { ...src, event: a.events[0] }, lineKey, kind: "TRANSFER_OUT", qty: qty4(a.qty), day: a.day, actor: a.actor, inventoryMovementId: out.id, reason: a.note });
  const ci = await costIn(tx, { holder: a.holder, src: { ...src, event: a.events[1] }, lineKey, kind: "TRANSFER_IN", qty: co.qty, value: co.value, day: a.day, actor: a.actor, inventoryMovementId: inn.id, reason: a.note });
  await resolveNone(tx, [co.id, ci.id]);
  return { outMovementId: out.id, inMovementId: inn.id, fromQty, fromAfter, toQty, toAfter, value: co.value.toFixed(2) };
}

/** Create and post a transfer in one step («تحويل فوري»). */
export async function createTransfer(body: Record<string, unknown>, actor: Actor, ctx: AuditContext) {
  const parsed = parseTransferLines(body.lines);
  if (!parsed.ok) throw fail(400, parsed.code, parsed.error, parsed.errorEn);
  const fromId = typeof body.fromLocationId === "string" ? body.fromLocationId : "";
  const toId = typeof body.toLocationId === "string" ? body.toLocationId : "";
  if (!fromId || !toId) throw fail(400, "TRANSFER_SITES_REQUIRED", "اختر الموقع المحوَّل منه والمحوَّل إليه.", "Choose the from and to locations.");
  if (fromId === toId) throw fail(400, "TRANSFER_SAME_SITE", "الموقعان متطابقان: اختر موقعًا آخر للوجهة.", "The two locations are the same: choose another destination.");
  const today = riyadhDay();
  let day = today;
  if (body.transferDate) {
    try { day = parseBusinessDay(String(body.transferDate)); } catch { throw fail(400, "TRANSFER_DATE_INVALID", "تاريخ التحويل غير صالح.", "The transfer date is not valid."); }
    if (day > today) throw fail(400, "TRANSFER_DATE_INVALID", "تاريخ التحويل بعد اليوم.", "The transfer date is after today.");
  }
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 500) : null;
  const requestKey = typeof body.requestKey === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(body.requestKey) ? body.requestKey : null;
  const lines = parsed.lines;

  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    if (requestKey) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-transfer:${requestKey}`}, 0))`;
      const twin = await tx.stockTransfer.findUnique({ where: { requestKey }, select: { id: true } });
      if (twin) return { id: twin.id, replayed: true };
    }
    const [from, to] = await Promise.all([tx.stockLocation.findUnique({ where: { id: fromId } }), tx.stockLocation.findUnique({ where: { id: toId } })]);
    if (!from || !to) throw fail(404, "STOCK_LOCATION_NOT_FOUND", "الموقع غير موجود.", "Location not found.");
    for (const l of [from, to]) if (!l.isActive) { const r = inactiveRefusal(l.nameAr, l.id); throw fail(r.status, r.code, r.error, r.errorEn, { locationId: l.id }); }
    await lockItems(tx, lines);
    const info = await itemInfo(tx, lines);
    // Every line must be covered at the source (the friendly refusal; the balance CHECK is the backstop).
    for (const [i, l] of lines.entries()) {
      const it = info.get(`${l.itemKind}:${l.entityId}`);
      if (!it) throw fail(404, "STOCK_ITEM_INVALID", `السطر ${i + 1}: الصنف غير موجود.`, `Line ${i + 1}: item not found.`);
      if (l.itemKind === "MATERIAL" && (it.unit === "PIECE" || it.unit === "UNIT") && !Number.isInteger(l.qty)) {
        throw fail(400, "TRANSFER_LINE_INVALID", `السطر ${i + 1}: «${it.nameAr ?? it.name}» يُعدّ بالقطعة — كمية صحيحة.`, `Line ${i + 1}: «${it.name}» is counted in pieces — a whole number.`);
      }
      const have = await locationQty(tx, l.itemKind, l.entityId, fromId);
      if (!covers(have, l.qty)) {
        const r = shortRefusal(from.nameAr, have, l.qty);
        throw fail(409, "STOCK_LOCATION_SHORT", `السطر ${i + 1} (${it.code}): ${r.error}`, `Line ${i + 1} (${it.code}): ${r.errorEn}`, { locationId: fromId, available: have, requested: l.qty, itemKind: l.itemKind, entityId: l.entityId });
      }
    }
    const t = await tx.stockTransfer.create({
      data: {
        fromLocationId: fromId, toLocationId: toId, transferDate: day, notes, requestKey, createdBy: actor.id, createdByName: actor.name ?? null,
        lines: { create: lines.map((l, i) => ({ lineNo: i + 1, itemKind: l.itemKind, entityId: l.entityId, qty: l.qty, notes: l.notes })) },
      },
      select: { id: true, number: true },
    });
    const holders = await lockHolders(tx, lines.map((l) => ({ kind: l.itemKind as CostKind, entityId: l.entityId })));
    const note = `تحويل ${transferRef(t.number)} · ${from.nameAr} ← ${to.nameAr}`;
    const moved: Record<string, unknown>[] = [];
    for (const [i, l] of lines.entries()) {
      const m = await moveLine(tx, { transfer: t, lineNo: i + 1, kind: l.itemKind, entityId: l.entityId, qty: l.qty, from: fromId, to: toId, holder: holders.get(`${l.itemKind}:${l.entityId}`)!, day, actor: actor.id, events: ["SENT", "RECEIVED"], note });
      const it = info.get(`${l.itemKind}:${l.entityId}`)!;
      moved.push({ lineNo: i + 1, itemKind: l.itemKind, entityId: l.entityId, code: it.code, name: it.nameAr ?? it.name, qty: l.qty, unit: it.unit, fromBefore: m.fromQty, fromAfter: m.fromAfter, toBefore: m.toQty, toAfter: m.toAfter, value: m.value });
    }
    await logTransfer(tx, ctx, "STOCK_TRANSFER_CREATED", t, { from: { id: fromId, name: from.nameAr }, to: { id: toId, name: to.nameAr }, transferDate: dayText(day), lines: moved, notes });
    await flushPostings(tx);
    return { id: t.id, replayed: false };
  }, { ...TX_OPTS, timeout: 60_000 });
}

/** Cancel a posted transfer: the movements are reversed, only while every line's goods are still at the destination. */
export async function cancelTransfer(id: string, reasonRaw: unknown, actor: Actor, ctx: AuditContext) {
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim().slice(0, 500) : "";
  if (reason.length < 3) throw fail(400, "TRANSFER_REASON_REQUIRED", "اكتب سبب الإلغاء (3 أحرف على الأقل).", "Give the reason for the cancel (at least 3 characters).");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason });
    const locked = (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "StockTransfer" WHERE "id" = ${id} FOR UPDATE`)[0];
    if (!locked) throw fail(404, "TRANSFER_NOT_FOUND", "التحويل غير موجود.", "Transfer not found.");
    const t = await tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } }, fromLocation: true, toLocation: true } });
    if (t.status !== "POSTED") throw fail(409, "TRANSFER_NOT_POSTED", "التحويل ملغى بالفعل.", "The transfer is already cancelled.");
    if (!t.fromLocation.isActive) { const r = inactiveRefusal(t.fromLocation.nameAr, t.fromLocationId); throw fail(r.status, r.code, r.error, r.errorEn); }
    await lockItems(tx, t.lines);
    const info = await itemInfo(tx, t.lines);
    for (const l of t.lines) {
      const have = await locationQty(tx, l.itemKind as StockItemKind, l.entityId, t.toLocationId);
      if (!covers(have, l.qty)) {
        const it = info.get(`${l.itemKind}:${l.entityId}`);
        throw fail(409, "TRANSFER_STOCK_MOVED_ON",
          `لا يُلغى التحويل: «${it?.nameAr ?? it?.name ?? l.entityId}» لم يعد كله في «${t.toLocation.nameAr}» (المتوفر ${r4(have)} من ${l.qty}). صحّح بتحويل عكسي أو بالجرد.`,
          `The transfer cannot be cancelled: «${it?.name ?? l.entityId}» is no longer all at «${t.toLocation.nameEn || t.toLocation.nameAr}» (${r4(have)} of ${l.qty}). Correct it with a transfer back or a count.`,
          { locationId: t.toLocationId, available: have, requested: l.qty });
      }
    }
    const holders = await lockHolders(tx, t.lines.map((l) => ({ kind: l.itemKind as CostKind, entityId: l.entityId })));
    const note = `إلغاء تحويل ${transferRef(t.number)} · ${reason}`;
    const day = riyadhDay();
    const reversed: Record<string, unknown>[] = [];
    for (const l of t.lines) {
      const m = await moveLine(tx, { transfer: t, lineNo: l.lineNo, kind: l.itemKind as StockItemKind, entityId: l.entityId, qty: l.qty, from: t.toLocationId, to: t.fromLocationId, holder: holders.get(`${l.itemKind}:${l.entityId}`)!, day, actor: actor.id, events: ["CANCEL_OUT", "CANCEL_IN"], note });
      reversed.push({ lineNo: l.lineNo, itemKind: l.itemKind, entityId: l.entityId, qty: l.qty, value: m.value });
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: actor.id, cancelledByName: actor.name ?? null, cancelReason: reason } });
    await logTransfer(tx, { ...ctx, reason }, "STOCK_TRANSFER_CANCELLED", t, { from: { id: t.fromLocationId, name: t.fromLocation.nameAr }, to: { id: t.toLocationId, name: t.toLocation.nameAr }, lines: reversed });
    await flushPostings(tx);
    return { id, cancelled: true };
  }, { ...TX_OPTS, timeout: 60_000 });
}

export async function listTransfers(q: { location?: string | null; from?: string | null; to?: string | null; status?: string | null; dateFrom?: string | null; dateTo?: string | null; by?: string | null; take?: number }) {
  const where: Prisma.StockTransferWhereInput = {};
  // By creator (council EA3): the owner reviews each person's transfers for the month.
  if (q.by) where.createdBy = q.by;
  if (q.location) where.OR = [{ fromLocationId: q.location }, { toLocationId: q.location }];
  if (q.from) where.fromLocationId = q.from;
  if (q.to) where.toLocationId = q.to;
  if (q.status === "POSTED" || q.status === "CANCELLED") where.status = q.status;
  const range: { gte?: Date; lte?: Date } = {};
  try { if (q.dateFrom) range.gte = parseBusinessDay(q.dateFrom); if (q.dateTo) range.lte = parseBusinessDay(q.dateTo); } catch { /* an invalid filter is ignored */ }
  if (range.gte || range.lte) where.transferDate = range;
  const rows = await prisma.stockTransfer.findMany({
    where, orderBy: [{ transferDate: "desc" }, { number: "desc" }], take: Math.min(q.take ?? 100, 500),
    include: { fromLocation: { select: { id: true, code: true, nameAr: true, nameEn: true } }, toLocation: { select: { id: true, code: true, nameAr: true, nameEn: true } }, lines: { select: { itemKind: true, entityId: true, qty: true } } },
  });
  const info = await itemInfo(prisma, rows.flatMap((r) => r.lines));
  return rows.map(({ lines, ...r }) => ({
    ...r, ref: transferRef(r.number), transferDate: dayText(r.transferDate), lineCount: lines.length,
    items: lines.slice(0, 3).map((l) => { const it = info.get(`${l.itemKind}:${l.entityId}`); return { code: it?.code ?? "—", name: it?.nameAr ?? it?.name ?? "—", nameEn: it?.name ?? "—", qty: l.qty, unit: it?.unit ?? "" }; }),
  }));
}

export async function getTransfer(id: string) {
  const t = await prisma.stockTransfer.findUnique({
    where: { id },
    include: { fromLocation: true, toLocation: true, lines: { orderBy: { lineNo: "asc" } }, movements: { orderBy: [{ timestamp: "asc" }, { type: "desc" }], select: { id: true, type: true, locationId: true, referenceEntityId: true, quantityChanged: true, previousQuantity: true, newQuantity: true, timestamp: true, notes: true } } },
  });
  if (!t) return null;
  const info = await itemInfo(prisma, t.lines);
  const moves = await prisma.costMove.findMany({ where: { sourceType: "STOCK_TRANSFER", sourceId: id }, select: { kind: true, qty: true, value: true, glState: true, lineKey: true, sourceEvent: true } });
  const value = t.lines.map((l) => moves.filter((m) => m.lineKey === String(l.lineNo) && m.sourceEvent === "SENT").reduce((s, m) => s + Math.abs(Number(m.value)), 0));
  const activity = await prisma.authAuditLog.findMany({ where: { action: { in: [...TRANSFER_ACTIONS] }, metadata: { path: ["transferId"], equals: id } }, orderBy: { occurredAt: "asc" }, select: { id: true, action: true, userId: true, occurredAt: true, metadata: true } });
  const people = [...new Set(activity.map((a) => a.userId).filter((x): x is string => !!x))];
  const names = new Map((people.length ? await prisma.employee.findMany({ where: { id: { in: people } }, select: { id: true, name: true } }) : []).map((e) => [e.id, e.name]));
  return {
    ...t, ref: transferRef(t.number), transferDate: dayText(t.transferDate),
    lines: t.lines.map((l, i) => ({ ...l, item: info.get(`${l.itemKind}:${l.entityId}`) ?? null, value: value[i].toFixed(2) })),
    costMoves: moves.map((m) => ({ ...m, qty: String(m.qty), value: String(m.value) })),
    glStates: [...new Set(moves.map((m) => m.glState))],
    activity: activity.map((a) => ({ id: a.id, action: a.action, at: a.occurredAt, by: a.userId ? names.get(a.userId) ?? null : null, metadata: a.metadata })),
  };
}

export { locationName };
