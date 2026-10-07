// Rule conditions: all must hold; codes compared, not labels.
// Run: npm run test:automation:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCondition, firstFailingCondition, type Condition } from "../../src/lib/automation/conditions";

const ctx = { "status.to": "Ready for Shipping", "order.itemCount": 3, "customer.name": "مقهى الركن", "status.reason": "" };
const holds = (c: Condition) => evaluateCondition(c, ctx);

test("equality is exact on the stored code, case- and space-insensitive", () => {
  assert.ok(holds({ field: "status.to", op: "eq", value: "ready for shipping " }));
  assert.ok(!holds({ field: "status.to", op: "eq", value: "Preparing" }));
  assert.ok(holds({ field: "status.to", op: "neq", value: "Preparing" }));
});

test("contains / empty", () => {
  assert.ok(holds({ field: "customer.name", op: "contains", value: "الركن" }));
  assert.ok(holds({ field: "customer.name", op: "not_contains", value: "زد" }));
  assert.ok(holds({ field: "status.reason", op: "empty" }));
  assert.ok(holds({ field: "customer.name", op: "not_empty" }));
  assert.ok(holds({ field: "missing.field", op: "empty" }));
});

test("numeric comparisons, and a non-number never matches", () => {
  assert.ok(holds({ field: "order.itemCount", op: "gt", value: "2" }));
  assert.ok(holds({ field: "order.itemCount", op: "gte", value: "3" }));
  assert.ok(!holds({ field: "order.itemCount", op: "lt", value: "3" }));
  assert.ok(holds({ field: "order.itemCount", op: "lte", value: "3" }));
  assert.ok(!holds({ field: "customer.name", op: "gt", value: "1" }));
});

test("the first failing condition is reported", () => {
  const conds: Condition[] = [
    { field: "status.to", op: "eq", value: "Ready for Shipping" },
    { field: "order.itemCount", op: "gt", value: "5" },
  ];
  assert.deepEqual(firstFailingCondition(conds, ctx), conds[1]);
  assert.equal(firstFailingCondition([conds[0]], ctx), null);
  assert.equal(firstFailingCondition([], ctx), null);
});
