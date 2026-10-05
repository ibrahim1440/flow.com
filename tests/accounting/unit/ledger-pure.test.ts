// Pure accounting helpers and static configuration. Run: npm run test:accounting:unit
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { parseAmount, round2, toMinor, dec } from "../../../src/lib/accounting/money";
import { accountingDate, accountingDateOf } from "../../../src/lib/accounting/dates";
import { databaseGuardMessage, AccountingError } from "../../../src/lib/accounting/errors";
import { COA_TEMPLATE, TEMPLATE_MAPPINGS } from "../../../src/lib/accounting/coa-template";
import { POSTING_ROLES, POLICIES, POLICY_BY_EVENT } from "../../../src/lib/accounting/catalog";

describe("money", () => {
  test("amounts are exact to the halala; a third decimal, a negative or text is refused", () => {
    assert.equal(parseAmount("1,234.50").toFixed(2), "1234.50");
    assert.equal(parseAmount("٥٠٫٢٥").toFixed(2), "50.25");
    assert.equal(parseAmount(12).toFixed(2), "12.00");
    assert.throws(() => parseAmount("1.005"), AccountingError);
    assert.throws(() => parseAmount("-5"), /must not be negative/);
    assert.throws(() => parseAmount("abc"), AccountingError);
    // Finance rule reused: a JS number is accepted only within 1e-9 of an exact halala, so float
    // noise normalises (0.1 + 0.2 → 0.30) while a real third decimal is still refused.
    assert.equal(parseAmount(0.1 + 0.2).toFixed(2), "0.30");
    assert.throws(() => parseAmount(1.005), AccountingError);
  });
  test("rounding is half-up at two places, and 0.1 + 0.2 is exactly 0.30 in Decimal", () => {
    assert.equal(round2(new Prisma.Decimal("2.345")).toFixed(2), "2.35");
    assert.equal(round2(new Prisma.Decimal("-2.345")).toFixed(2), "-2.35");
    assert.equal(dec("0.1").add("0.2").toFixed(2), "0.30");
    assert.equal(toMinor("1739067.89"), 173906789);
    assert.equal(toMinor("-600.00"), -60000);
  });
});

describe("dates", () => {
  test("calendar dates only; an instant maps to its Riyadh day", () => {
    assert.equal(accountingDate("2026-02-28").toISOString(), "2026-02-28T00:00:00.000Z");
    assert.throws(() => accountingDate("2026-02-30"), /calendar date/);
    assert.throws(() => accountingDate("28/02/2026"), /calendar date/);
    // 22:30 UTC on 31 Jan is 01:30 on 1 Feb in Riyadh.
    assert.equal(accountingDateOf(new Date("2026-01-31T22:30:00Z")).toISOString().slice(0, 10), "2026-02-01");
    assert.equal(accountingDateOf(new Date("2026-01-31T20:59:00Z")).toISOString().slice(0, 10), "2026-01-31");
  });
});

describe("database guard messages", () => {
  test("found wherever the driver adapter nests them; other errors are not mistaken for guards", () => {
    const nested = { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "23000", originalMessage: "Posted journal entry 7 cannot be changed; reverse it instead" } } } };
    assert.equal(databaseGuardMessage(nested), "Posted journal entry 7 cannot be changed; reverse it instead");
    assert.equal(databaseGuardMessage({ code: "23000", message: "ERROR: Lines of a POSTED journal entry cannot be changed" }), "Lines of a POSTED journal entry cannot be changed");
    assert.equal(databaseGuardMessage({ code: "P2002", message: "Unique constraint failed" }), null);
    assert.equal(databaseGuardMessage(new Error("boom")), null);
  });
});

describe("chart template", () => {
  const byCode = new Map(COA_TEMPLATE.map((a) => [a.code, a]));
  test("codes are unique, parents come first and share the child's type", () => {
    assert.equal(byCode.size, COA_TEMPLATE.length);
    COA_TEMPLATE.forEach((a, i) => {
      if (!a.parent) return;
      const p = byCode.get(a.parent);
      assert.ok(p, `${a.code} has a parent in the template`);
      assert.ok(COA_TEMPLATE.findIndex((x) => x.code === a.parent) < i, `${a.code}'s parent precedes it`);
      assert.equal(p!.type, a.type, `${a.code} type matches its parent`);
      assert.ok(p!.header, `${a.code}'s parent is a header account`);
    });
  });
  test("every posting role has a default mapping to a postable, non-header template account", () => {
    for (const r of POSTING_ROLES) {
      const code = TEMPLATE_MAPPINGS[r.role];
      assert.ok(code, `${r.role} is mapped`);
      assert.ok(!byCode.get(code)!.header, `${r.role} maps to a postable account`);
    }
    assert.equal(byCode.get(TEMPLATE_MAPPINGS.COMMISSION_PAYABLE)!.control, "COMMISSION_PAYABLE");
    assert.equal(byCode.get(TEMPLATE_MAPPINGS.COMMISSION_EXPENSE)!.type, "EXPENSE");
  });
  test("receivable, payable, inventory and commission control accounts are closed to manual journals", () => {
    for (const a of COA_TEMPLATE.filter((x) => ["RECEIVABLE", "PAYABLE", "INVENTORY", "COMMISSION_PAYABLE", "CUSTOMER_ADVANCES"].includes(x.control ?? ""))) {
      assert.equal(a.manual, false, `${a.code} refuses manual postings`);
    }
  });
});

describe("policies", () => {
  test("every commission event type is governed by exactly one policy", () => {
    for (const e of ["commission.accrual", "commission.reversal", "commission.adjustment", "commission.payout"]) assert.equal(POLICY_BY_EVENT.get(e), "commissions.recognition");
    assert.equal(new Set(POLICIES.map((p) => p.key)).size, POLICIES.length);
  });
});
