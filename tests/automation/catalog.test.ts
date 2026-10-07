// The event catalogue and the dispatcher agree on what exists.
// Run: npm run test:automation:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENTS, EVENT_GROUPS, RECIPIENT_LABELS, sampleContext } from "../../src/lib/automation/catalog";
import { RESOLVED_EVENT_TYPES } from "../../src/lib/automation/context";
import { renderTemplate, unknownPlaceholders } from "../../src/lib/automation/template";

test("every catalogued event has a resolver, and every resolver a catalogued event", () => {
  assert.deepEqual([...EVENTS.map((e) => e.key)].sort(), [...RESOLVED_EVENT_TYPES].sort());
});

test("event keys are unique and every event sits in a known group", () => {
  const keys = EVENTS.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
  const groups = new Set(EVENT_GROUPS.map((g) => g.key));
  for (const e of EVENTS) assert.ok(groups.has(e.group), e.key);
});

test("variables are unique per event, bilingual, and enums carry their options", () => {
  for (const e of EVENTS) {
    const keys = e.variables.map((v) => v.key);
    assert.equal(new Set(keys).size, keys.length, `${e.key} repeats a variable`);
    for (const v of e.variables) {
      assert.ok(v.ar && v.en, `${e.key}.${v.key} needs both labels`);
      if (v.kind === "enum") assert.ok(v.options?.length, `${e.key}.${v.key} is an enum without options`);
    }
  }
});

test("every recipient has a label, and every event offers at least one of its own", () => {
  for (const e of EVENTS) {
    assert.ok(e.recipients.length > 0, e.key);
    for (const r of e.recipients) assert.ok(RECIPIENT_LABELS[r], `${e.key}: ${r}`);
  }
});

test("a template using every variable renders with the sample data", () => {
  for (const e of EVENTS) {
    const tpl = e.variables.map((v) => `{{${v.key}}}`).join(" ");
    assert.deepEqual(unknownPlaceholders(e, tpl), []);
    assert.ok(!renderTemplate(e, tpl, sampleContext(e), "ar").includes("{{"), e.key);
  }
});
