// Inventory costing engine (no database access; unit-tested). Quantities are Decimal(18,4) in an
// item's base unit, values Decimal(18,2) in SAR. Every function conserves value exactly: what
// leaves a layer is what the layer loses, to the halala, and nothing is created by rounding.
//
// Decision D-1 (DECISION_PACK §3) chooses the method and the loss bands. Nothing here assumes a
// band or a method: callers pass them, from settings the accountant approves.
//   WEIGHTED_AVERAGE — an issue is valued at the item-location's average (total value / total
//                      quantity) and taken from every layer in proportion, so layers stay consistent.
//   FIFO             — an issue takes the oldest layers first, each at its own unit cost.
import { Prisma } from "@/generated/prisma/client";

type D = Prisma.Decimal;
const Z = new Prisma.Decimal(0);
export const q4 = (d: D) => d.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
export const m2 = (d: D) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export type CostMethod = "WEIGHTED_AVERAGE" | "FIFO";
export type Layer = { id: string; qtyLeft: D; valueLeft: D };
export type Take = { layerId: string; qty: D; value: D };

export class InsufficientStock extends Error {
  constructor(public readonly available: D, public readonly wanted: D) { super(`Only ${available.toFixed(4)} on hand; ${wanted.toFixed(4)} requested.`); }
}

/** Value a layer gives up when `qty` of it is taken (all of it when fully taken). */
const partOf = (l: Layer, qty: D) => (qty.equals(l.qtyLeft) ? l.valueLeft : m2(l.valueLeft.mul(qty).div(l.qtyLeft)));

/**
 * Take `qty` from `layers` (oldest first). Returns what each layer gives up. Refuses to go below
 * zero stock. With WEIGHTED_AVERAGE the issue value is the average cost × qty (the whole value when
 * everything is issued) and is spread over the layers in proportion to their quantity.
 */
export function consume(layers: Layer[], qty: D, method: CostMethod): Take[] {
  if (qty.lte(0)) throw new Error("Issue quantity must be positive.");
  const live = layers.filter((l) => l.qtyLeft.gt(0));
  const onHand = live.reduce((s, l) => s.add(l.qtyLeft), Z);
  if (qty.gt(onHand)) throw new InsufficientStock(onHand, qty);
  if (method === "FIFO") {
    const out: Take[] = [];
    let left = qty;
    for (const l of live) {
      if (left.isZero()) break;
      const t = Prisma.Decimal.min(left, l.qtyLeft);
      out.push({ layerId: l.id, qty: t, value: partOf(l, t) });
      left = left.sub(t);
    }
    return out;
  }
  const totalValue = live.reduce((s, l) => s.add(l.valueLeft), Z);
  if (qty.equals(onHand)) return live.map((l) => ({ layerId: l.id, qty: l.qtyLeft, value: l.valueLeft }));
  const issueValue = m2(totalValue.mul(qty).div(onHand));
  // 1. Quantity from every layer in proportion (rounded down to 0.0001, so none is overdrawn); the
  //    remainder 0.0001 at a time to layers that still have more, preferring not to empty one.
  const TICK = new Prisma.Decimal("0.0001");
  const qs = live.map((l) => qty.mul(l.qtyLeft).div(onHand).toDecimalPlaces(4, Prisma.Decimal.ROUND_DOWN));
  let rest = qty.sub(qs.reduce((s, x) => s.add(x), Z));
  for (const allowFull of [false, true]) {
    for (let i = 0; rest.gt(0) && i < live.length; i++) {
      const room = live[i].qtyLeft.sub(qs[i]).sub(allowFull ? Z : TICK);
      if (room.lte(0)) continue;
      const t = Prisma.Decimal.min(room, rest);
      qs[i] = qs[i].add(t); rest = rest.sub(t);
    }
  }
  // 2. Value: an emptied layer gives all it holds; the others share the rest of the issue value in
  //    proportion to quantity, never below zero or above what they hold. Any rounding difference
  //    is moved between layers with room, so the issue value stays exact where it is feasible.
  const vs = live.map(() => Z);
  const full = live.map((l, i) => qs[i].equals(l.qtyLeft));
  live.forEach((l, i) => { if (full[i]) vs[i] = l.valueLeft; });
  const target = issueValue.sub(vs.reduce((s, v) => s.add(v), Z));
  const partQty = qs.reduce((s, x, i) => (full[i] ? s : s.add(x)), Z);
  live.forEach((l, i) => {
    if (full[i] || qs[i].isZero() || partQty.isZero()) return;
    vs[i] = Prisma.Decimal.min(l.valueLeft, Prisma.Decimal.max(Z, m2(target.mul(qs[i]).div(partQty))));
  });
  let diff = issueValue.sub(vs.reduce((s, v) => s.add(v), Z));
  const order = live.map((_, i) => i).filter((i) => !full[i] && qs[i].gt(0)).sort((x, y) => qs[y].cmp(qs[x]));
  for (const i of order) {
    if (diff.isZero()) break;
    const t = diff.isPositive() ? Prisma.Decimal.min(diff, live[i].valueLeft.sub(vs[i])) : Prisma.Decimal.max(diff, vs[i].neg());
    vs[i] = vs[i].add(t); diff = diff.sub(t);
  }
  return live.map((l, i) => ({ layerId: l.id, qty: qs[i], value: vs[i] })).filter((t) => t.qty.gt(0));
}

/** Average unit cost of what is on hand (null when nothing is). */
export function averageCost(layers: Layer[]): D | null {
  const q = layers.reduce((s, l) => s.add(l.qtyLeft), Z);
  return q.isZero() ? null : layers.reduce((s, l) => s.add(l.valueLeft), Z).div(q);
}

/** Base-unit quantity of `qty` in `unit`, given base units per unit (1 for the base unit). */
export function toBase(qty: D, factor: D): D {
  if (factor.lte(0)) throw new Error("A unit conversion factor must be positive.");
  return q4(qty.mul(factor));
}

export type ProductionInput = { key: string; value: D; yieldQty: D; conversion?: boolean };   // conversion: labour/overhead absorbed — no weight, but part of the cost of processing the yielding inputs   // yieldQty: kg (or the yield unit) that can become output; 0 for components (bags, labels)
export type ProductionOutput = { key: string; yieldQty: D };
export type ProductionResult = {
  inputValue: D; yieldIn: D; expectedYield: D | null; actualYield: D;
  normalLossQty: D; abnormalLossQty: D; abnormalLossValue: D;
  outputs: { key: string; value: D }[];
};

/**
 * Production costing (D-1 recommendation, DECISION_PACK §3): loss inside the band is absorbed into
 * the output; loss beyond it is valued at the cost per unit of expected good output and expensed.
 * Components that do not yield (packaging) go entirely into the output. Output value is split by
 * yield quantity. With no band (null), all loss is treated as normal.
 *   expectedYield = yield inputs × (1 − band)
 *   abnormal qty  = max(0, expectedYield − actual yield)
 *   abnormal value = yield-input value × abnormal qty / expectedYield
 */
export function costProduction(inputs: ProductionInput[], outputs: ProductionOutput[], bandPercent: D | null): ProductionResult {
  if (!outputs.length) throw new Error("A production needs at least one output.");
  if (outputs.some((o) => o.yieldQty.lte(0))) throw new Error("Every output needs a positive quantity.");
  const inputValue = inputs.reduce((s, i) => s.add(i.value), Z);
  const yieldIn = inputs.reduce((s, i) => s.add(i.yieldQty), Z);
  const yieldValue = inputs.filter((i) => i.yieldQty.gt(0) || i.conversion).reduce((s, i) => s.add(i.value), Z);
  const actualYield = outputs.reduce((s, o) => s.add(o.yieldQty), Z);
  if (yieldIn.gt(0) && actualYield.gt(yieldIn)) throw new Error("Output weighs more than the inputs it is made from.");
  let expectedYield: D | null = null, abnormalQty = Z, abnormalValue = Z;
  if (bandPercent !== null && yieldIn.gt(0)) {
    if (bandPercent.lt(0) || bandPercent.gte(100)) throw new Error("A loss band is between 0 and 100 percent.");
    expectedYield = q4(yieldIn.mul(new Prisma.Decimal(100).sub(bandPercent)).div(100));
    if (actualYield.lt(expectedYield)) {
      abnormalQty = expectedYield.sub(actualYield);
      abnormalValue = m2(yieldValue.mul(abnormalQty).div(expectedYield));
    }
  }
  const toOutputs = inputValue.sub(abnormalValue);
  const vs = outputs.map((o) => m2(toOutputs.mul(o.yieldQty).div(actualYield)));
  let k = 0; outputs.forEach((o, i) => { if (o.yieldQty.gt(outputs[k].yieldQty)) k = i; });
  vs[k] = vs[k].add(toOutputs.sub(vs.reduce((s, v) => s.add(v), Z)));
  const loss = yieldIn.gt(0) ? yieldIn.sub(actualYield) : Z;
  return {
    inputValue, yieldIn, expectedYield, actualYield,
    normalLossQty: loss.sub(abnormalQty), abnormalLossQty: abnormalQty, abnormalLossValue: abnormalValue,
    outputs: outputs.map((o, i) => ({ key: o.key, value: vs[i] })),
  };
}

/**
 * Spread an amount (landed cost, or a bill-vs-receipt price difference, which may be negative)
 * over receipt lines by value or by quantity, to the halala. Then each part splits between what is
 * still on hand in that receipt's layer (added to inventory) and what has left it (expensed).
 */
export function allocateAmount(amount: D, targets: { key: string; weight: D }[]): { key: string; amount: D }[] {
  const tot = targets.reduce((s, t) => s.add(t.weight), Z);
  if (tot.lte(0)) throw new Error("Nothing to allocate to.");
  const out = targets.map((t) => m2(amount.mul(t.weight).div(tot)));
  let k = 0; targets.forEach((t, i) => { if (t.weight.gt(targets[k].weight)) k = i; });
  out[k] = out[k].add(amount.sub(out.reduce((s, x) => s.add(x), Z)));
  return targets.map((t, i) => ({ key: t.key, amount: out[i] }));
}

/** Part of a cost change that stays in a layer (its remaining share of the received quantity). */
export function onHandShare(amount: D, layer: { qtyIn: D; qtyLeft: D }): { onHand: D; consumed: D } {
  if (layer.qtyIn.lte(0)) return { onHand: Z, consumed: amount };
  const onHand = m2(amount.mul(layer.qtyLeft).div(layer.qtyIn));
  return { onHand, consumed: amount.sub(onHand) };
}
