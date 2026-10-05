// Inventory costing engine: the worked example in DECISION_PACK §3 to the halala, FIFO and
// weighted-average issues, conservation of value over thousands of random issue sequences,
// landed-cost allocation and unit conversion. Pure functions; no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { consume, costProduction, allocateAmount, onHandShare, toBase, averageCost, InsufficientStock, type Layer, type CostMethod } from "../../../src/lib/accounting/inventory-costing";

const d = (s: string | number) => new Prisma.Decimal(s);
const L = (id: string, q: string, v: string): Layer => ({ id, qtyLeft: d(q), valueLeft: d(v) });
const sum = (xs: { value: Prisma.Decimal }[]) => xs.reduce((s, x) => s.add(x.value), d(0)).toFixed(2);

test("DECISION_PACK §3 example: 100 kg @ 30 + 50 kg @ 36 → average 32.00; issue 60 kg = 1,920.00", () => {
  const layers = [L("a", "100", "3000.00"), L("b", "50", "1800.00")];
  assert.equal(averageCost(layers)!.toFixed(2), "32.00");
  const t = consume(layers, d("60"), "WEIGHTED_AVERAGE");
  assert.equal(sum(t), "1920.00");
  assert.deepEqual(t.map((x) => [x.layerId, x.qty.toFixed(4), x.value.toFixed(2)]), [["a", "40.0000", "1280.00"], ["b", "20.0000", "640.00"]]);
});

test("DECISION_PACK §3 example: band 18% (synthetic), 60 kg in, 47 kg out → 1,834.15 to output, 85.85 abnormal (5300)", () => {
  const r = costProduction([{ key: "green", value: d("1920.00"), yieldQty: d("60") }], [{ key: "roasted", yieldQty: d("47") }], d("18"));
  assert.equal(r.expectedYield!.toFixed(4), "49.2000");
  assert.equal(r.abnormalLossQty.toFixed(4), "2.2000");
  assert.equal(r.abnormalLossValue.toFixed(2), "85.85");
  assert.equal(r.outputs[0].value.toFixed(2), "1834.15");
  assert.equal(r.normalLossQty.toFixed(4), "10.8000");
  // inside the band (50 kg): everything carried, nothing expensed (38.40/kg)
  const ok = costProduction([{ key: "green", value: d("1920.00"), yieldQty: d("60") }], [{ key: "roasted", yieldQty: d("50") }], d("18"));
  assert.equal(ok.abnormalLossValue.toFixed(2), "0.00"); assert.equal(ok.outputs[0].value.toFixed(2), "1920.00");
});

test("packing: roasted coffee yields, bags and labels do not; output split by yield weight", () => {
  const r = costProduction([
    { key: "roasted", value: d("1834.15"), yieldQty: d("45") },
    { key: "bags", value: d("117.00"), yieldQty: d("0") },
    { key: "labels", value: d("27.00"), yieldQty: d("0") },
  ], [{ key: "sku250", yieldQty: d("45") }], d("1"));
  assert.equal(r.expectedYield!.toFixed(4), "44.5500");
  assert.equal(r.abnormalLossValue.toFixed(2), "0.00");
  assert.equal(r.outputs[0].value.toFixed(2), "1978.15");
  const two = costProduction([{ key: "dough", value: d("100.00"), yieldQty: d("3") }], [{ key: "a", yieldQty: d("1") }, { key: "b", yieldQty: d("2") }], null);
  assert.deepEqual(two.outputs.map((o) => o.value.toFixed(2)), ["33.33", "66.67"]);
});

test("FIFO takes the oldest layers at their own cost; running out is refused", () => {
  const layers = [L("a", "10", "300.00"), L("b", "5", "180.00")];
  const t = consume(layers, d("12"), "FIFO");
  assert.deepEqual(t.map((x) => [x.layerId, x.qty.toFixed(4), x.value.toFixed(2)]), [["a", "10.0000", "300.00"], ["b", "2.0000", "72.00"]]);
  assert.throws(() => consume(layers, d("15.0001"), "FIFO"), InsufficientStock);
  assert.throws(() => consume(layers, d("0"), "FIFO"));
});

test("conservation: 3,000 random sequences — no value created or lost, no layer below zero, last issue empties exactly", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let run = 0; run < 3000; run++) {
    const method: CostMethod = run % 2 ? "FIFO" : "WEIGHTED_AVERAGE";
    const layers: Layer[] = [];
    const n = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) layers.push(L(`l${i}`, (0.0001 + rnd() * 500).toFixed(4), (rnd() * 20000).toFixed(2)));
    const start = layers.reduce((s, l) => s.add(l.valueLeft), d(0));
    let issued = d(0);
    for (let k = 0; k < 6; k++) {
      const onHand = layers.reduce((s, l) => s.add(l.qtyLeft), d(0));
      if (onHand.isZero()) break;
      const q = k === 5 ? onHand : Prisma.Decimal.max(d("0.0001"), onHand.mul(rnd()).toDecimalPlaces(4, Prisma.Decimal.ROUND_DOWN));
      const takes = consume(layers, q, method);
      assert.equal(takes.reduce((s, t) => s.add(t.qty), d(0)).toFixed(4), q.toFixed(4), `quantity ${run}`);
      for (const t of takes) {
        const l = layers.find((x) => x.id === t.layerId)!;
        assert.ok(t.qty.lte(l.qtyLeft) && t.value.lte(l.valueLeft) && t.value.gte(0), `layer bounds ${run}`);
        l.qtyLeft = l.qtyLeft.sub(t.qty); l.valueLeft = l.valueLeft.sub(t.value);
        if (l.qtyLeft.isZero()) assert.ok(l.valueLeft.isZero(), `empty layer keeps no value ${run}`);
        issued = issued.add(t.value);
      }
    }
    const left = layers.reduce((s, l) => s.add(l.valueLeft), d(0));
    assert.equal(issued.add(left).toFixed(2), start.toFixed(2), `value conserved ${run}`);
    assert.ok(left.isZero(), `everything issued in the end ${run}`);
  }
});

test("landed cost / price difference: exact allocation by weight; on-hand vs consumed split", () => {
  const a = allocateAmount(d("1000.00"), [{ key: "x", weight: d("11400") }, { key: "y", weight: d("1") }, { key: "z", weight: d("2") }]);
  assert.equal(a.reduce((s, x) => s.add(x.amount), d(0)).toFixed(2), "1000.00");
  const neg = allocateAmount(d("-10.00"), [{ key: "x", weight: d("1") }, { key: "y", weight: d("2") }]);
  assert.deepEqual(neg.map((x) => x.amount.toFixed(2)), ["-3.33", "-6.67"]);
  assert.deepEqual(Object.values(onHandShare(d("1000.00"), { qtyIn: d("400"), qtyLeft: d("340") })).map((x) => x.toFixed(2)), ["850.00", "150.00"]);
});

test("units: a 12-litre carton is 12 L; a 60 kg sack is 60 kg; factors must be positive", () => {
  assert.equal(toBase(d("3"), d("12")).toFixed(4), "36.0000");
  assert.equal(toBase(d("2.5"), d("60")).toFixed(4), "150.0000");
  assert.throws(() => toBase(d("1"), d("0")));
});
