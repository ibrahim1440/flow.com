// Message templates render exactly what the editor previews.
// Run: npm run test:automation:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { getEvent } from "../../src/lib/automation/catalog";
import { placeholders, renderTemplate, unknownPlaceholders } from "../../src/lib/automation/template";

const statusChanged = getEvent("order.status_changed")!;

test("placeholders are found once each, spaces inside the braces allowed", () => {
  assert.deepEqual(placeholders("{{order.number}} {{ customer.name }} {{order.number}}"), ["order.number", "customer.name"]);
});

test("unknown placeholders are reported per event", () => {
  assert.deepEqual(unknownPlaceholders(statusChanged, "{{order.number}} {{quote.total}} {{nope}}"), ["quote.total", "nope"]);
});

test("enumerated values are written as labels in the rule's language", () => {
  const tpl = "طلبك {{order.number}}: {{status.to}}";
  const ctx = { "order.number": 1042, "status.to": "Ready for Shipping" };
  assert.equal(renderTemplate(statusChanged, tpl, ctx, "ar"), "طلبك 1042: جاهز للشحن");
  assert.equal(renderTemplate(statusChanged, tpl, ctx, "en"), "طلبك 1042: Ready for Shipping");
});

test("a missing value renders as nothing, never as the raw placeholder", () => {
  const out = renderTemplate(statusChanged, "Hi {{customer.name}}, reason: {{status.reason}}", { "customer.name": "Ali" }, "en");
  assert.equal(out, "Hi Ali, reason:");
  assert.ok(!out.includes("{{"));
});

test("an unknown enum code is shown as stored", () => {
  assert.equal(renderTemplate(statusChanged, "{{status.to}}", { "status.to": "Something New" }, "ar"), "Something New");
});
