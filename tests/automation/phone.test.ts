// Phone numbers as typed by people → the digits the WhatsApp server expects.
// Run: npm run test:automation:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPhone, normalizePhoneForWhatsApp } from "../../src/lib/automation/phone";

const ok = (raw: string) => {
  const r = normalizePhoneForWhatsApp(raw);
  assert.ok(r.ok, `${raw} should be accepted: ${!r.ok ? r.reason : ""}`);
  return r.phone;
};
const refused = (raw: string | null) => assert.equal(normalizePhoneForWhatsApp(raw).ok, false, `${raw} should be refused`);

test("every common spelling of a Saudi mobile becomes 9665XXXXXXXX", () => {
  for (const raw of ["0501234567", "501234567", "+966501234567", "00966501234567", "966501234567", "9660501234567", "050 123 4567", "+966-50-123-4567"]) {
    assert.equal(ok(raw), "966501234567", raw);
  }
});

test("Arabic-Indic and Persian digits are read as digits", () => {
  assert.equal(ok("٠٥٠١٢٣٤٥٦٧"), "966501234567");
  assert.equal(ok("۰۵۰۱۲۳۴۵۶۷"), "966501234567");
});

test("international numbers from other countries are accepted as written", () => {
  assert.equal(ok("+971501234567"), "971501234567");
  assert.equal(ok("0020 100 123 4567"), "201001234567");
});

test("empty, malformed and ambiguous local numbers are refused, never guessed", () => {
  refused(null);
  refused("");
  refused("   ");
  refused("abc");
  refused("0112345678"); // a Saudi landline written locally: not a WhatsApp mobile
  refused("96611234567"); // 966 but not a mobile
  refused("12345");
  refused("+1234567890123456"); // longer than E.164 allows
});

test("display formatting", () => {
  assert.equal(formatPhone("966501234567"), "+966 50 123 4567");
  assert.equal(formatPhone("971501234567"), "+971501234567");
  assert.equal(formatPhone(null), "");
});
