// Accounting A3 — the inventory COST sub-ledger (perpetual, moving weighted average). Every stock movement an
// operation makes is mirrored here, INSIDE the operation's transaction, with the unit-cost snapshot it moved at;
// then the operation's journal entry is posted through the engine (postEntry, by role) and each movement records
// what became of it (POSTED with its entry / SKIPPED before go-live / NONE when there is nothing to post).
//
// Concurrency: a holder's row is locked (SELECT … FOR UPDATE) before its average is read and written, so two
// receipts or a receipt and an issue of one holder serialise and the average is never computed from a stale
// balance. Operations lock their own stock row first (GreenBean, MaterialItem, RoastingBatch, FinishedGoodsLot),
// then the holder — one direction everywhere. Several holders in one operation are locked in id order.
//
// Idempotency: one movement per (source event, holder, lineKey) (unique index); a repeated call returns it.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { postEntry, type PostEntryInput, type PostEntryResult, type PostingLineInput, type PostingDims, type EngineModule } from "../posting-engine";
import { riyadhDay, dayText } from "../dates";
import { roundMoney, ZERO, Decimal } from "../money";
import { issue, receive, revalue, unitCost, type Holder } from "./costing";

type Tx = Prisma.TransactionClient;

export const COST_KINDS = ["GREEN_BEAN", "MATERIAL", "ROASTED_BATCH", "FG_LOT"] as const;
export type CostKind = (typeof COST_KINDS)[number];
export type InventoryRole = "INVENTORY_GREEN" | "INVENTORY_PACKAGING" | "INVENTORY_CAFE" | "INVENTORY_ROASTED" | "INVENTORY_PACKED";

/** The ledger's item dimension of a holder (a roast and a finished lot are dimensioned by their product / SKU by the caller). */
export const ITEM_DIM: Partial<Record<CostKind, "GREEN_BEAN" | "MATERIAL">> = { GREEN_BEAN: "GREEN_BEAN", MATERIAL: "MATERIAL" };

export type Src = { module: EngineModule; type: string; id: string; event: string };
export type HolderRow = { id: string; kind: CostKind; entityId: string; role: InventoryRole; qty: Decimal; value: Decimal; avgCost: Decimal; lastInCost: Decimal | null };

/** The default role of a holder: materials by category (packaging / labels → packaging; consumables / other → café). */
export async function roleFor(tx: Tx, kind: CostKind, entityId: string): Promise<InventoryRole> {
  if (kind === "GREEN_BEAN") return "INVENTORY_GREEN";
  if (kind === "ROASTED_BATCH") return "INVENTORY_ROASTED";
  if (kind === "FG_LOT") return "INVENTORY_PACKED";
  const m = await tx.materialItem.findUnique({ where: { id: entityId }, select: { category: true } });
  return m && (m.category === "CONSUMABLE" || m.category === "OTHER") ? "INVENTORY_CAFE" : "INVENTORY_PACKAGING";
}

/** Lock (creating it on first use) the cost holder of an entity. */
export async function lockHolder(tx: Tx, kind: CostKind, entityId: string, role?: InventoryRole): Promise<HolderRow> {
  const r = role ?? (await roleFor(tx, kind, entityId));
  await tx.$executeRaw`INSERT INTO "CostItem" ("id", "kind", "entityId", "role", "updatedAt") VALUES (${`ci_${randomUUID()}`}, ${kind}, ${entityId}, ${r}, now()) ON CONFLICT ("tenantId", "kind", "entityId") DO NOTHING`;
  const rows = await tx.$queryRaw<{ id: string; role: string; qty: Decimal; value: Decimal; avgCost: Decimal; lastInCost: Decimal | null }[]>`
    SELECT "id", "role", "qty", "value", "avgCost", "lastInCost" FROM "CostItem" WHERE "tenantId" = 'hiqbah' AND "kind" = ${kind} AND "entityId" = ${entityId} FOR UPDATE`;
  const h = rows[0];
  return { id: h.id, kind, entityId, role: h.role as InventoryRole, qty: new Decimal(h.qty), value: new Decimal(h.value), avgCost: new Decimal(h.avgCost), lastInCost: h.lastInCost === null ? null : new Decimal(h.lastInCost) };
}

/** Lock several holders in a fixed order (by kind, then entity id) — the deadlock-free order. */
export async function lockHolders(tx: Tx, list: { kind: CostKind; entityId: string }[]): Promise<Map<string, HolderRow>> {
  const uniq = [...new Map(list.map((x) => [`${x.kind}:${x.entityId}`, x])).values()].sort((a, b) => (a.kind + a.entityId < b.kind + b.entityId ? -1 : 1));
  const out = new Map<string, HolderRow>();
  for (const x of uniq) out.set(`${x.kind}:${x.entityId}`, await lockHolder(tx, x.kind, x.entityId));
  return out;
}

export type MoveKind = "RECEIPT" | "ISSUE" | "TRANSFER_IN" | "TRANSFER_OUT" | "ADJUSTMENT" | "REVALUATION" | "OPENING" | "WRITE_OFF" | "RETURN";
export type MoveResult = { id: string; holderId: string; role: InventoryRole; qty: Decimal; value: Decimal; unitCost: Decimal; replayed: boolean };

type MoveBase = { holder: HolderRow; src: Src; lineKey?: string; kind: MoveKind; day?: Date; actor: string; inventoryMovementId?: string | null; reason?: string | null };

async function existing(tx: Tx, m: MoveBase): Promise<MoveResult | null> {
  const hit = await tx.costMove.findUnique({
    where: { tenantId_sourceType_sourceId_sourceEvent_costItemId_lineKey: { tenantId: "hiqbah", sourceType: m.src.type, sourceId: m.src.id, sourceEvent: m.src.event, costItemId: m.holder.id, lineKey: m.lineKey ?? "" } },
  });
  return hit ? { id: hit.id, holderId: hit.costItemId, role: m.holder.role, qty: new Decimal(hit.qty).abs(), value: new Decimal(hit.value).abs(), unitCost: new Decimal(hit.unitCost), replayed: true } : null;
}

async function write(tx: Tx, m: MoveBase, signedQty: Decimal, signedValue: Decimal, snapshot: Decimal, after: Holder & { avgCost: Decimal }, extra: { lastInCost?: Decimal; glState?: string } = {}): Promise<MoveResult> {
  const day = m.day ?? riyadhDay();
  const row = await tx.costMove.create({
    data: {
      costItemId: m.holder.id, businessDay: day, kind: m.kind, qty: signedQty, value: signedValue, unitCost: snapshot,
      qtyAfter: after.qty, valueAfter: after.value, sourceModule: m.src.module, sourceType: m.src.type, sourceId: m.src.id, sourceEvent: m.src.event,
      lineKey: m.lineKey ?? "", inventoryMovementId: m.inventoryMovementId ?? null, reason: m.reason ? m.reason.slice(0, 500) : null, createdBy: m.actor,
      ...(extra.glState ? { glState: extra.glState } : {}),
    },
    select: { id: true },
  });
  await tx.costItem.update({ where: { id: m.holder.id }, data: { qty: after.qty, value: after.value, avgCost: after.avgCost, ...(extra.lastInCost ? { lastInCost: extra.lastInCost } : {}) } });
  m.holder.qty = after.qty; m.holder.value = after.value; m.holder.avgCost = after.avgCost;
  if (extra.lastInCost) m.holder.lastInCost = extra.lastInCost;
  return { id: row.id, holderId: m.holder.id, role: m.holder.role, qty: signedQty.abs(), value: signedValue.abs(), unitCost: snapshot, replayed: false };
}

/** Stock IN of `qty` at a total `value` (receipt, transfer in, gain). */
export async function costIn(tx: Tx, m: MoveBase & { qty: Decimal; value: Decimal }): Promise<MoveResult> {
  const prior = await existing(tx, m);
  if (prior) return prior;
  const a = receive(m.holder, m.qty, m.value);
  return write(tx, m, a.qty, a.value, a.unitCost, a.after, m.kind === "RECEIPT" && a.qty.gt(0) ? { lastInCost: a.unitCost } : {});
}

/** Stock OUT of `qty` at the moving average (issue, transfer out, loss); `closeOut` empties the holder. */
export async function costOut(tx: Tx, m: MoveBase & { qty: Decimal; closeOut?: boolean }): Promise<MoveResult> {
  const prior = await existing(tx, m);
  if (prior) return prior;
  const a = issue(m.holder, m.qty, { closeOut: m.closeOut });
  return write(tx, m, a.qty.negated(), a.value.negated(), a.unitCost, a.after);
}

/** A value change without quantity: what the holder absorbs, and the rest (to expense). */
export async function costRevalue(tx: Tx, m: MoveBase & { delta: Decimal }): Promise<MoveResult & { rest: Decimal }> {
  const prior = await existing(tx, m);
  if (prior) {
    const signed = new Decimal((await tx.costMove.findUniqueOrThrow({ where: { id: prior.id }, select: { value: true } })).value);
    return { ...prior, value: signed, rest: roundMoney(m.delta).minus(signed) };
  }
  const r = revalue(m.holder, m.delta);
  if (r.absorbed.isZero()) return { id: "", holderId: m.holder.id, role: m.holder.role, qty: ZERO, value: ZERO, unitCost: m.holder.avgCost, replayed: false, rest: r.rest };
  const w = await write(tx, m, ZERO, r.absorbed, r.after.avgCost, r.after);
  return { ...w, value: r.absorbed, rest: r.rest };
}

/** The opening valuation: set the holder to exactly (qty, value). Its movement is OPENING (fed to the opening grid). */
export async function costSet(tx: Tx, m: MoveBase & { qty: Decimal; value: Decimal }): Promise<MoveResult> {
  const prior = await existing(tx, m);
  if (prior) return prior;
  const value = roundMoney(m.value);
  const after = { qty: m.qty, value: m.qty.gt(0) ? value : ZERO, avgCost: unitCost(m.qty.gt(0) ? value : ZERO, m.qty) };
  return write(tx, m, after.qty.minus(m.holder.qty), after.value.minus(m.holder.value), after.avgCost, after, { glState: "OPENING", ...(after.qty.gt(0) ? { lastInCost: after.avgCost } : {}) });
}

// ─── Posting ─────────────────────────────────────────────────────────────────────────────────────

/** A line on the side its sign says (+ debit, − credit); null for zero. */
export function side(role: string, amount: Decimal, dims?: PostingDims, description?: string): PostingLineInput | null {
  const a = roundMoney(amount);
  if (a.isZero()) return null;
  return { role, ...(a.isNegative() ? { credit: a.abs().toFixed(2) } : { debit: a.toFixed(2) }), ...(dims ? { dims } : {}), ...(description ? { description } : {}) };
}

/** Merge lines of the same role (or account), side and dimensions, and drop nothing-lines (a contra pair on one account nets off). */
export function netLines(lines: (PostingLineInput | null)[]): PostingLineInput[] {
  const m = new Map<string, { role?: string; accountId?: string; amount: Decimal; dims?: PostingDims; description?: string | null }>();
  for (const l of lines) {
    if (!l || (!l.role && !l.accountId)) continue;
    const amt = l.debit ? new Decimal(String(l.debit)) : new Decimal(String(l.credit)).negated();
    const k = `${l.role ?? ""}|${l.accountId ?? ""}|${JSON.stringify(l.dims ?? {})}`;
    const cur = m.get(k);
    if (cur) cur.amount = cur.amount.plus(amt);
    else m.set(k, { role: l.role ?? undefined, accountId: l.accountId ?? undefined, amount: amt, dims: l.dims, description: l.description });
  }
  const out: PostingLineInput[] = [];
  for (const x of m.values()) {
    const a = roundMoney(x.amount);
    if (a.isZero()) continue;
    out.push({ ...(x.role ? { role: x.role } : { accountId: x.accountId }), ...(a.isNegative() ? { credit: a.abs().toFixed(2) } : { debit: a.toFixed(2) }), ...(x.dims ? { dims: x.dims } : {}), ...(x.description ? { description: x.description } : {}) });
  }
  return out;
}

/** An explicit-account line on the side its sign says. */
export function accountSide(accountId: string, amount: Decimal, dims?: PostingDims, description?: string): PostingLineInput | null {
  const a = roundMoney(amount);
  if (a.isZero()) return null;
  return { accountId, ...(a.isNegative() ? { credit: a.abs().toFixed(2) } : { debit: a.toFixed(2) }), ...(dims ? { dims } : {}), ...(description ? { description } : {}) };
}

export type OpsPostResult = PostEntryResult | { status: "none" } | { status: "deferred" };

// ─── Deferred posting ────────────────────────────────────────────────────────────────────────────
// Posting takes the ledger's gapless counter row (A1) and holds it until commit. An operation that posted in the
// middle of its transaction and then locked more rows (an order, a lot, the next item of a count) would hold that
// counter while waiting — a deadlock with an operation that holds those rows and is about to post, and a global
// queue for every other posting. So the stock events record their cost movements at once (under the holders'
// locks) and QUEUE their entries; the operation calls flushPostings(tx) as the LAST step of its transaction. A
// forgotten flush cannot pass silently: its movements stay PENDING and the database refuses the commit
// (ledger_cost_move_resolved).
const queues = new WeakMap<object, (() => Promise<unknown>)[]>();

/** Post every entry the operation queued on this transaction, in order. Call it last, inside the transaction. */
export async function flushPostings(tx: Tx): Promise<void> {
  const q = queues.get(tx);
  if (!q) return;
  queues.delete(tx);
  for (const run of q) await run();
}

/**
 * Post an operation's entry (lines netted) and resolve its cost movements: POSTED with the entry, SKIPPED when the
 * engine is off or the day is before go-live, NONE when the lines net to nothing (a transfer within one role, a
 * zero value). Operations post on the business day with `nextOpenPeriod` — a soft-closed month never blocks
 * the floor; the memo records the original day.
 */
export async function postAndResolve(tx: Tx, moveIds: string[], input: Omit<PostEntryInput, "lines" | "date"> & { lines: (PostingLineInput | null)[]; date?: Date | string }, opts: { now?: boolean } = {}): Promise<OpsPostResult> {
  if (!opts.now) {
    const q = queues.get(tx) ?? [];
    q.push(() => postAndResolve(tx, moveIds, input, { now: true }));
    queues.set(tx, q);
    return { status: "deferred" };
  }
  const lines = netLines(input.lines);
  const ids = moveIds.filter(Boolean);
  if (lines.length < 2) {
    if (ids.length) await tx.costMove.updateMany({ where: { id: { in: ids }, glState: "PENDING" }, data: { glState: "NONE" } });
    return { status: "none" };
  }
  const r = await postEntry(tx, { whenPeriodNotOpen: "nextOpenPeriod", ...input, date: input.date ?? dayText(riyadhDay()), lines });
  if (ids.length) {
    await tx.costMove.updateMany({ where: { id: { in: ids }, glState: "PENDING" }, data: r.status === "posted" ? { glState: "POSTED", journalEntryId: r.entryId } : { glState: "SKIPPED" } });
  }
  return r;
}

/** Resolve movements that post nothing by themselves (a transfer within one role). */
export async function resolveNone(tx: Tx, moveIds: string[]): Promise<void> {
  const ids = moveIds.filter(Boolean);
  if (ids.length) await tx.costMove.updateMany({ where: { id: { in: ids }, glState: "PENDING" }, data: { glState: "NONE" } });
}
