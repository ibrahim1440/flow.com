// The one validator every rule write goes through.
// Run: npm run test:automation:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepOffsetsMinutes, validateRuleInput, type Step } from "../../src/lib/automation/rules";

const valid = () => ({
  name: "  Ready for shipping  ",
  eventType: "order.status_changed",
  isActive: true,
  conditions: [{ field: "status.to", op: "eq", value: "Ready for Shipping" }],
  steps: [
    { type: "whatsapp", to: { kind: "customer" }, template: "طلبك {{order.number}} جاهز" },
    { type: "wait", minutes: 60 },
    { type: "whatsapp", to: { kind: "phone", phone: "0501234567", name: "المدير" }, template: "تم إشعار {{customer.name}}" },
  ],
});

const errorsOf = (body: unknown) => {
  const r = validateRuleInput(body);
  assert.equal(r.ok, false, "expected the rule to be refused");
  return (r as { errors: string[] }).errors.join(" | ");
};

test("a valid rule is accepted and normalised", () => {
  const r = validateRuleInput(valid());
  assert.ok(r.ok, !r.ok ? r.errors.join(", ") : "");
  assert.equal(r.value.name, "Ready for shipping");
  assert.equal(r.value.locale, "ar");
  assert.deepEqual(r.value.steps[2], {
    type: "whatsapp",
    to: { kind: "phone", phone: "966501234567", name: "المدير" },
    template: "تم إشعار {{customer.name}}",
  });
});

test("unknown events, fields and variables are refused", () => {
  assert.match(errorsOf({ ...valid(), eventType: "order.exploded" }), /valid event/);
  assert.match(errorsOf({ ...valid(), conditions: [{ field: "quote.total", op: "eq", value: "1" }] }), /not a field/);
  assert.match(errorsOf({ ...valid(), steps: [{ type: "whatsapp", to: { kind: "customer" }, template: "{{quote.total}}" }] }), /unknown variable/);
});

test("an enum condition must use one of the listed values", () => {
  assert.match(errorsOf({ ...valid(), conditions: [{ field: "status.to", op: "eq", value: "Shipped-ish" }] }), /listed values/);
});

test("a recipient the event cannot resolve is refused", () => {
  assert.match(errorsOf({ ...valid(), steps: [{ type: "whatsapp", to: { kind: "deal_owner" }, template: "x" }] }), /who receives/);
  assert.match(errorsOf({ ...valid(), steps: [{ type: "whatsapp", to: { kind: "employee" }, template: "x" }] }), /choose an employee/);
  assert.match(errorsOf({ ...valid(), steps: [{ type: "whatsapp", to: { kind: "phone", phone: "0112345678" }, template: "x" }] }), /country code/);
});

test("steps: at least one message, waits bounded, never a trailing wait", () => {
  const msg = { type: "whatsapp", to: { kind: "customer" }, template: "x" };
  assert.match(errorsOf({ ...valid(), steps: [] }), /at least one step/);
  assert.match(errorsOf({ ...valid(), steps: [{ type: "wait", minutes: 5 }] }), /at least one message step/);
  assert.match(errorsOf({ ...valid(), steps: [msg, { type: "wait", minutes: 5 }] }), /followed by a message/);
  assert.match(errorsOf({ ...valid(), steps: [{ type: "wait", minutes: 0 }, msg] }), /between 1 minute and 7 days/);
  assert.match(errorsOf({ ...valid(), steps: [{ ...msg, template: "   " }] }), /empty/);
});

test("each message's delay is the sum of the waits before it", () => {
  const steps: Step[] = [
    { type: "whatsapp", to: { kind: "customer" }, template: "a" },
    { type: "wait", minutes: 30 },
    { type: "whatsapp", to: { kind: "customer" }, template: "b" },
    { type: "wait", minutes: 60 },
    { type: "whatsapp", to: { kind: "customer" }, template: "c" },
  ];
  assert.deepEqual(stepOffsetsMinutes(steps), [0, null, 30, null, 90]);
});
