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
import { issue, receive, returnOut, revalue, unitCost, stateOfReceipt, stateAfterReceipt, CONSUMING_KINDS, type Holder, type CostState } from "./costing";
import { opsRefuse } from "./refusals";
import { materialInventoryRole } from "@/lib/inventory/item-categories";

type Tx = Prisma.TransactionClient;

export const COST_KINDS = ["GREEN_BEAN", "MATERIAL", "ROASTED_BATCH", "FG_LOT"] as const;
export type CostKind = (typeof COST_KINDS)[number];
export type InventoryRole = "INVENTORY_GREEN" | "INVENTORY_PACKAGING" | "INVENTORY_CAFE" | "INVENTORY_ROASTED" | "INVENTORY_PACKED";

/** The ledger's item dimension of a holder (a roast and a finished lot are dimensioned by their product / SKU by the caller). */
export const ITEM_DIM: Partial<Record<CostKind, "GREEN_BEAN" | "MATERIAL">> = { GREEN_BEAN: "GREEN_BEAN", MATERIAL: "MATERIAL" };

export type Src = { module: EngineModule; type: string; id: string; event: string };
export type HolderRow = {
  id: string; kind: CostKind; entityId: string; role: InventoryRole; qty: Decimal; value: Decimal; avgCost: Decimal; lastInCost: Decimal | null;
  /** NULL on a holder last written before the cost state existed: read it through costStateOf(). */
  costState: CostState | null; costGap: string | null;
};

/**
 * The default role of a holder. A material takes its item category's inventory role (unified inventory phase 1,
 * 20261112090000_item_categories); without a category, the legacy enum rule (packaging / labels → packaging;
 * consumables / other → café). Identical for every material that existed before categories (the back-fill maps
 * each enum to a category of that same role): tests/ops/unit/item-categories.test.ts. A holder's role is fixed
 * when it is first costed; a later move to a category of another role is refused (trigger + API).
 */
export async function roleFor(tx: Tx, kind: CostKind, entityId: string): Promise<InventoryRole> {
  if (kind === "GREEN_BEAN") return "INVENTORY_GREEN";
  if (kind === "ROASTED_BATCH") return "INVENTORY_ROASTED";
  if (kind === "FG_LOT") return "INVENTORY_PACKED";
  const m = await tx.materialItem.findUnique({ where: { id: entityId }, select: { category: true, itemCategory: { select: { inventoryRole: true } } } });
  return materialInventoryRole(m ?? {});
}

/** Lock (creating it on first use) the cost holder of an entity. */
export async function lockHolder(tx: Tx, kind: CostKind, entityId: string, role?: InventoryRole): Promise<HolderRow> {
  const r = role ?? (await roleFor(tx, kind, entityId));
  await tx.$executeRaw`INSERT INTO "CostItem" ("id", "kind", "entityId", "role", "updatedAt") VALUES (${`ci_${randomUUID()}`}, ${kind}, ${entityId}, ${r}, now()) ON CONFLICT ("tenantId", "kind", "entityId") DO NOTHING`;
  const rows = await tx.$queryRaw<{ id: string; role: string; qty: Decimal; value: Decimal; avgCost: Decimal; lastInCost: Decimal | null; costState: string | null; costGap: string | null }[]>`
    SELECT "id", "role", "qty", "value", "avgCost", "lastInCost", "costState", "costGap" FROM "CostItem" WHERE "tenantId" = 'hiqbah' AND "kind" = ${kind} AND "entityId" = ${entityId} FOR UPDATE`;
  const h = rows[0];
  return { id: h.id, kind, entityId, role: h.role as InventoryRole, qty: new Decimal(h.qty), value: new Decimal(h.value), avgCost: new Decimal(h.avgCost), lastInCost: h.lastInCost === null ? null : new Decimal(h.lastInCost), costState: (h.costState as CostState | null) ?? null, costGap: h.costGap ?? null };
}

/** Lock several holders in a fixed order (by kind, then entity id) — the deadlock-free order. */
export async function lockHolders(tx: Tx, list: { kind: CostKind; entityId: string }[]): Promise<Map<string, HolderRow>> {
  const uniq = [...new Map(list.map((x) => [`${x.kind}:${x.entityId}`, x])).values()].sort((a, b) => (a.kind + a.entityId < b.kind + b.entityId ? -1 : 1));
  const out = new Map<string, HolderRow>();
  for (const x of uniq) out.set(`${x.kind}:${x.entityId}`, await lockHolder(tx, x.kind, x.entityId));
  return out;
}

export type MoveKind = "RECEIPT" | "ISSUE" | "TRANSFER_IN" | "TRANSFER_OUT" | "ADJUSTMENT" | "REVALUATION" | "OPENING" | "WRITE_OFF" | "RETURN";
export type MoveResult = {
  id: string; holderId: string; role: InventoryRole; qty: Decimal; value: Decimal; unitCost: Decimal; replayed: boolean;
  /** For a movement OUT: the cost state of the holder it left (what an output made from it inherits). Null on a replay. */
  sourceState?: CostState | null; sourceGap?: string | null;
};

type MoveBase = { holder: HolderRow; src: Src; lineKey?: string; kind: MoveKind; day?: Date; actor: string; inventoryMovementId?: string | null; reason?: string | null };

async function existing(tx: Tx, m: MoveBase): Promise<MoveResult | null> {
  const hit = await tx.costMove.findUnique({
    where: { tenantId_sourceType_sourceId_sourceEvent_costItemId_lineKey: { tenantId: "hiqbah", sourceType: m.src.type, sourceId: m.src.id, sourceEvent: m.src.event, costItemId: m.holder.id, lineKey: m.lineKey ?? "" } },
  });
  return hit ? { id: hit.id, holderId: hit.costItemId, role: m.holder.role, qty: new Decimal(hit.qty).abs(), value: new Decimal(hit.value).abs(), unitCost: new Decimal(hit.unitCost), replayed: true } : null;
}

async function write(tx: Tx, m: MoveBase, signedQty: Decimal, signedValue: Decimal, snapshot: Decimal, after: Holder & { avgCost: Decimal }, extra: { lastInCost?: Decimal; glState?: string; state?: { costState: CostState; costGap: string | null } } = {}): Promise<MoveResult> {
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
  // The state is NOT reset when a holder is emptied: a real receipt into an empty holder brings its own state
  // (stateAfterReceipt), while a return, a count surplus or a transfer coming back in keeps what the holder was —
  // emptying a holder and filling it again is not a way to make an unknown cost known.
  const state = extra.state;
  await tx.costItem.update({ where: { id: m.holder.id }, data: { qty: after.qty, value: after.value, avgCost: after.avgCost, ...(extra.lastInCost ? { lastInCost: extra.lastInCost } : {}), ...(state ? { costState: state.costState, costGap: state.costGap ? state.costGap.slice(0, 500) : null } : {}) } });
  m.holder.qty = after.qty; m.holder.value = after.value; m.holder.avgCost = after.avgCost;
  if (state) { m.holder.costState = state.costState; m.holder.costGap = state.costGap; }
  if (extra.lastInCost) m.holder.lastInCost = extra.lastInCost;
  return { id: row.id, holderId: m.holder.id, role: m.holder.role, qty: signedQty.abs(), value: signedValue.abs(), unitCost: snapshot, replayed: false };
}

/**
 * Stock IN of `qty` at a total `value` (receipt, transfer in, gain). `state`: the cost state the quantity comes in
 * with — an output states what it inherited from its inputs (stateOfOutput); left out, a zero value with a quantity
 * is UNKNOWN and anything else KNOWN. `gap`: what is missing, when UNKNOWN.
 */
export async function costIn(tx: Tx, m: MoveBase & { qty: Decimal; value: Decimal; state?: CostState | null; gap?: string | null }): Promise<MoveResult> {
  const prior = await existing(tx, m);
  if (prior) return prior;
  const onHand = m.holder.qty;
  const current = await costStateOf(tx, m.holder);
  const a = receive(m.holder, m.qty, m.value);
  const incoming = stateOfReceipt(a.qty, a.value, m.state);
  // A return, a count surplus and a transfer in are the holder's OWN stock coming back, not a new source of cost:
  // they keep an UNKNOWN holder UNKNOWN (and its source chain) even when it was emptied in between. Only a receipt
  // with its cost (into an empty holder), the opening valuation and a supplier invoice's stock value change that.
  const carries = INHERITING_KINDS.includes(m.kind) && current.state === "UNKNOWN";
  const next = carries ? "UNKNOWN" as CostState : stateAfterReceipt(onHand, current.state, incoming);
  const keepsGap = current.state === "UNKNOWN" && (onHand.gt(0) || carries);
  const gap = next !== "UNKNOWN" ? null
    : [...new Set([keepsGap ? current.gap : null, incoming === "UNKNOWN" ? (m.gap ?? m.reason ?? `${m.src.type} ${m.src.id}`) : null].filter(Boolean))].join(" · ").slice(0, 480) || null;
  return write(tx, m, a.qty, a.value, a.unitCost, a.after, { ...(m.kind === "RECEIPT" && a.qty.gt(0) ? { lastInCost: a.unitCost } : {}), ...(a.qty.gt(0) ? { state: { costState: next, costGap: gap } } : {}) });
}

/**
 * Stock OUT of `qty` at the moving average (issue, transfer out, loss); `closeOut` empties the holder.
 * A consuming movement (ISSUE, WRITE_OFF, and a transfer that says `consumes` — a blend) out of a holder whose cost is UNKNOWN is REFUSED once the
 * ledger posts (COST_UNKNOWN, 409): the average of such a holder is not a cost, and what would be posted — COGS, the
 * roasted or finished stock's value, wastage — would be understated with nothing to show it. Before activation /
 * go-live nothing is posted, the state travels with the stock (sourceState), and the opening valuation settles it.
 */
export async function costOut(tx: Tx, m: MoveBase & { qty: Decimal; closeOut?: boolean; consumes?: boolean }): Promise<MoveResult> {
  const prior = await existing(tx, m);
  if (prior) return prior;
  let from = await costStateOf(tx, m.holder);
  // Stock the cost ledger does not hold at all (a quantity that never came in through it: older than the ledger and
  // left out of the opening valuation) has no cost either — issuing it would move nothing, silently.
  const consumes = m.consumes ?? CONSUMING_KINDS.includes(m.kind);
  if (consumes && from.state !== "UNKNOWN" && m.qty.minus(m.holder.qty).gt(UNHELD_TOLERANCE)) from = { state: "UNKNOWN", gap: `الكمية المصروفة (${m.qty.toFixed()}) أكبر مما يحمله سجل التكلفة (${m.holder.qty.toFixed()}): رصيد لم يدخل السجل بتكلفة` };
  if (from.state === "UNKNOWN" && consumes && m.qty.gt(0) && (await postingLive(tx, m.day ?? riyadhDay()))) throw await costUnknownRefusal(tx, m.holder, from.gap);
  const a = issue(m.holder, m.qty, { closeOut: m.closeOut });
  // A holder older than the cost state (NULL) that is read as UNKNOWN gets the state written with this movement:
  // once it is emptied its history no longer says so, and what comes back in must still find it UNKNOWN.
  const stamp = from.state === "UNKNOWN" && m.holder.costState !== "UNKNOWN" && m.holder.qty.gt(0) ? { state: { costState: "UNKNOWN" as CostState, costGap: from.gap } } : {};
  const w = await write(tx, m, a.qty.negated(), a.value.negated(), a.unitCost, a.after, stamp);
  return { ...w, sourceState: from.state, sourceGap: from.state === "UNKNOWN" ? (from.gap ?? (await holderLabel(tx, m.holder.kind, m.holder.entityId))) : null };
}

/** Stock OUT of `qty` at a GIVEN value (a receipt reversed: the value it came in at, bounded by what the holder holds). */
export async function costReturnOut(tx: Tx, m: MoveBase & { qty: Decimal; value: Decimal }): Promise<MoveResult> {
  const prior = await existing(tx, m);
  if (prior) return prior;
  const a = returnOut(m.holder, m.qty, m.value);
  return write(tx, m, a.qty.negated(), a.value.negated(), a.unitCost, a.after);
}

/** A value change without quantity: what the holder absorbs, and the rest (to expense). */
/** `completesCost`: this value IS the missing cost (a supplier invoice's stock line for the item) — an UNKNOWN holder
 *  that absorbs a positive amount becomes KNOWN. A price variance or a landed cost does not complete anything. */
export async function costRevalue(tx: Tx, m: MoveBase & { delta: Decimal; completesCost?: boolean }): Promise<MoveResult & { rest: Decimal }> {
  const prior = await existing(tx, m);
  if (prior) {
    const signed = new Decimal((await tx.costMove.findUniqueOrThrow({ where: { id: prior.id }, select: { value: true } })).value);
    return { ...prior, value: signed, rest: roundMoney(m.delta).minus(signed) };
  }
  const r = revalue(m.holder, m.delta);
  if (r.absorbed.isZero()) return { id: "", holderId: m.holder.id, role: m.holder.role, qty: ZERO, value: ZERO, unitCost: m.holder.avgCost, replayed: false, rest: r.rest };
  const completes = !!m.completesCost && r.absorbed.gt(0) && (await costStateOf(tx, m.holder)).state === "UNKNOWN";
  const w = await write(tx, m, ZERO, r.absorbed, r.after.avgCost, r.after, completes ? { state: { costState: "KNOWN", costGap: null } } : {});
  return { ...w, value: r.absorbed, rest: r.rest };
}

/** The opening valuation: set the holder to exactly (qty, value). Its movement is OPENING (fed to the opening grid).
 *  `state`: what the valuation says about the cost (the owner's own figure is KNOWN, or a documented zero at 0; no
 *  cost at all is UNKNOWN); left out, a zero value with a quantity is UNKNOWN. */
export async function costSet(tx: Tx, m: MoveBase & { qty: Decimal; value: Decimal; state?: CostState | null; gap?: string | null }): Promise<MoveResult> {
  const prior = await existing(tx, m);
  if (prior) return prior;
  const value = roundMoney(m.value);
  const after = { qty: m.qty, value: m.qty.gt(0) ? value : ZERO, avgCost: unitCost(m.qty.gt(0) ? value : ZERO, m.qty) };
  const costState = after.qty.lte(0) ? "KNOWN" as CostState : stateOfReceipt(after.qty, after.value, m.state);
  const costGap = costState === "UNKNOWN" ? (m.gap ?? "لا تكلفة في التقييم الافتتاحي") : null;
  return write(tx, m, after.qty.minus(m.holder.qty), after.value.minus(m.holder.value), after.avgCost, after, { glState: "OPENING", ...(after.qty.gt(0) ? { lastInCost: after.avgCost } : {}), state: { costState, costGap } });
}

// ─── Cost state ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A quantity issued beyond what the holder holds, above rounding (holders keep 4 decimals; stock columns are floats). */
const UNHELD_TOLERANCE = new Decimal("0.001");
/** Movements IN that are the holder's own stock coming back (never a new source of cost). */
const INHERITING_KINDS: readonly string[] = ["RETURN", "ADJUSTMENT", "TRANSFER_IN"];
const LABEL: Record<CostKind, [string, string]> = { GREEN_BEAN: ["بن أخضر", "green lot"], MATERIAL: ["مادة", "material"], ROASTED_BATCH: ["دفعة محمصة", "roasted batch"], FG_LOT: ["تشغيلة منتج جاهز", "finished lot"] };

/** «بن أخضر GB-0001» — the name a person knows the holder's stock by. */
export async function holderLabel(tx: Tx, kind: CostKind, entityId: string): Promise<string> {
  let name: string | null | undefined;
  if (kind === "GREEN_BEAN") name = (await tx.greenBean.findUnique({ where: { id: entityId }, select: { serialNumber: true } }))?.serialNumber;
  else if (kind === "MATERIAL") name = (await tx.materialItem.findUnique({ where: { id: entityId }, select: { name: true } }))?.name;
  else if (kind === "ROASTED_BATCH") name = (await tx.roastingBatch.findUnique({ where: { id: entityId }, select: { batchNumber: true } }))?.batchNumber;
  else name = (await tx.finishedGoodsLot.findUnique({ where: { id: entityId }, select: { batchNumber: true } }))?.batchNumber;
  return `${LABEL[kind][0]} ${name ?? entityId}`;
}

/**
 * The cost state of a holder. Stored for every holder written since 20261231220000_cost_state; for an older one
 * (NULL) it is DERIVED here from its movements and never written back (no historical row is changed):
 *   · nothing on hand → KNOWN;  a quantity with no value → UNKNOWN;
 *   · since the holder was last empty (or opened), a quantity that came in at zero value and was not completed by a
 *     later supplier-invoice cost → UNKNOWN (the average is contaminated, whatever the value);
 *   · a roast or a finished lot whose production event drew an input at zero value → UNKNOWN — the case the value
 *     hides: the lot holds its materials' cost and no coffee cost. Inputs that are roasts are traced the same way.
 */
export async function costStateOf(tx: Tx, h: { id: string; kind: CostKind; entityId: string; qty: Decimal; value: Decimal; costState: CostState | null; costGap: string | null }, depth = 0): Promise<{ state: CostState; gap: string | null }> {
  if (h.costState) return { state: h.costState, gap: h.costGap };
  if (h.qty.lte(0)) return { state: "KNOWN", gap: null };
  if (h.value.isZero()) return { state: "UNKNOWN", gap: "رصيد بلا قيمة في سجل التكلفة" };
  const moves = await tx.costMove.findMany({ where: { costItemId: h.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { kind: true, qty: true, value: true, qtyAfter: true, sourceType: true, sourceId: true, reason: true } });
  let start = 0;
  moves.forEach((mv, i) => { if (mv.kind === "OPENING") start = i; else if (new Decimal(mv.qtyAfter).lte(0)) start = i + 1; });
  const since = moves.slice(start);
  for (const [i, mv] of since.entries()) {
    if (mv.kind === "OPENING" || !new Decimal(mv.qty).gt(0)) continue;
    if (new Decimal(mv.value).isZero()) {
      const completed = since.slice(i + 1).some((x) => x.kind === "REVALUATION" && new Decimal(x.value).gt(0));
      if (!completed) return { state: "UNKNOWN", gap: mv.reason ?? `${mv.sourceType} ${mv.sourceId} بلا تكلفة` };
      continue;
    }
    if (h.kind !== "ROASTED_BATCH" && h.kind !== "FG_LOT") continue;
    // The inputs of the production event that made this quantity.
    const inputs = await tx.costMove.findMany({ where: { sourceType: mv.sourceType, sourceId: mv.sourceId, costItemId: { not: h.id }, qty: { lt: 0 } }, select: { value: true, costItem: { select: { id: true, kind: true, entityId: true, qty: true, value: true, costState: true, costGap: true } } } });
    for (const x of inputs) {
      const ci = x.costItem;
      const label = () => holderLabel(tx, ci.kind as CostKind, ci.entityId);
      if (new Decimal(x.value).isZero()) return { state: "UNKNOWN", gap: `${await label()} صُرف بلا تكلفة` };
      if ((ci.kind === "ROASTED_BATCH" || ci.costState === "UNKNOWN") && depth < 3) {
        // The input as it stood: its own production history (not its balance now, which may be empty).
        const st = ci.costState ? { state: ci.costState as CostState, gap: ci.costGap } : await costStateOf(tx, { id: ci.id, kind: ci.kind as CostKind, entityId: ci.entityId, qty: new Decimal(1), value: new Decimal(1), costState: null, costGap: null }, depth + 1);
        if (st.state === "UNKNOWN") return { state: "UNKNOWN", gap: st.gap ?? `${await label()} تكلفته غير مكتملة` };
      }
    }
  }
  return { state: "KNOWN", gap: null };
}

const liveCache = new WeakMap<object, Map<string, boolean>>();
/** Does the ledger post for this business day (accounting activated and the day on or after go-live)? */
export async function postingLive(tx: Tx, day: Date): Promise<boolean> {
  const key = dayText(day);
  const c = liveCache.get(tx) ?? new Map<string, boolean>();
  liveCache.set(tx, c);
  const hit = c.get(key);
  if (hit !== undefined) return hit;
  const s = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true, goLiveDate: true } });
  const on = !!s?.accountingActive && !!s.goLiveDate && day >= s.goLiveDate;
  c.set(key, on);
  return on;
}

/** The refusal: which stock, what is missing, and the way to complete it — never a way around it. */
async function costUnknownRefusal(tx: Tx, h: HolderRow, gap: string | null) {
  const label = await holderLabel(tx, h.kind, h.entityId);
  const raw = h.kind === "GREEN_BEAN" || h.kind === "MATERIAL";
  const st = raw ? await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { openingEntryId: true } }) : null;
  const howAr = raw
    ? `طريقة الاستكمال: سجّل ورحّل فاتورة المورد لهذا الصنف بسطر «مخزون» (المحاسبة › المشتريات) ليدخل سعره في تكلفته${st?.openingEntryId ? "" : "، أو أدخل تكلفته في «تقييم المخزون الافتتاحي» قبل ترحيل الأرصدة الافتتاحية"}. ثم أعد العملية.`
    : "طريقة الاستكمال: هذه تكلفة ناتج من مصدر بلا تكلفة، ولا تُستكمل من هذه الشاشة: تحتاج إعادة تقييم معتمدة من المحاسب لهذا الرصيد (قبل ترحيل الأرصدة الافتتاحية: «تقييم المخزون الافتتاحي»).";
  const howEn = raw
    ? `To complete it: enter and post the supplier's invoice for this item with a «stock» line${st?.openingEntryId ? "" : ", or enter its cost in the opening inventory valuation before the opening balances are posted"}; then repeat the operation.`
    : "To complete it: this is the cost of an output made from an input with no cost; it is not completed from this screen and needs a revaluation approved by the accountant (before the opening balances are posted: the opening inventory valuation).";
  return opsRefuse("COST_UNKNOWN", `Stock: ${LABEL[h.kind][1]} ${label.split(" ").slice(-1)[0]}. Missing: ${gap ?? "its cost"}. ${howEn}`, `المخزون: ${label}. الناقص: ${gap ?? "تكلفته"}. ${howAr}`);
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
  const m = new Map<string, { role?: string; accountId?: string; amount: Decimal; dims?: PostingDims; description?: string | null; accountBasis?: PostingLineInput["accountBasis"]; salesCategoryId?: string | null }>();
  for (const l of lines) {
    if (!l || (!l.role && !l.accountId)) continue;
    const amt = l.debit ? new Decimal(String(l.debit)) : new Decimal(String(l.credit)).negated();
    const k = `${l.role ?? ""}|${l.accountId ?? ""}|${l.accountBasis ?? ""}|${l.salesCategoryId ?? ""}|${JSON.stringify(l.dims ?? {})}`;
    const cur = m.get(k);
    if (cur) cur.amount = cur.amount.plus(amt);
    else m.set(k, { role: l.role ?? undefined, accountId: l.accountId ?? undefined, amount: amt, dims: l.dims, description: l.description, accountBasis: l.accountBasis ?? undefined, salesCategoryId: l.salesCategoryId ?? undefined });
  }
  const out: PostingLineInput[] = [];
  for (const x of m.values()) {
    const a = roundMoney(x.amount);
    if (a.isZero()) continue;
    out.push({ ...(x.role ? { role: x.role } : { accountId: x.accountId }), ...(a.isNegative() ? { credit: a.abs().toFixed(2) } : { debit: a.toFixed(2) }), ...(x.dims ? { dims: x.dims } : {}), ...(x.description ? { description: x.description } : {}), ...(x.accountBasis ? { accountBasis: x.accountBasis } : {}), ...(x.salesCategoryId ? { salesCategoryId: x.salesCategoryId } : {}) });
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

/** Queue a posting step of its own (a reversal) to run with the others at flushPostings(tx). */
export function deferPosting(tx: Tx, run: () => Promise<unknown>): void {
  const q = queues.get(tx) ?? [];
  q.push(run);
  queues.set(tx, q);
}

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
