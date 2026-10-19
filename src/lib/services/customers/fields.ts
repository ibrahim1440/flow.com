// The customer account particulars (migration 20261019120000_customer_account) — parsing and
// validation of what PUT /api/customers/[id] and POST /api/customers accept for them, and of a
// contact (/api/customers/[id]/contacts). Pure, so the rules are asserted without a database.
//
// Every field is optional and nullable: an empty string clears it. None has a default and none
// is inferred; the account page shows «غير محدد» until an administrator enters it.

import { parseFiniteDecimal, roundMoney, type Decimal } from "../commissions/engine";

export const SEGMENTS = ["WHOLESALE", "RETAIL", "CAFE", "DISTRIBUTOR", "OTHER"] as const;
export type Segment = (typeof SEGMENTS)[number];

export type AccountFields = {
  commercialRegNo?: string | null;
  vatNumber?: string | null;
  segment?: Segment | null;
  city?: string | null;
  priceList?: string | null;
  paymentTermsDays?: number | null;
  creditLimit?: Decimal | null;
  accountOwnerId?: string | null;
};

type Problem = { error: string; errorAr: string };
type Parsed<T> = { ok: true; data: T } | ({ ok: false } & Problem);

const fail = (error: string, errorAr: string): { ok: false } & Problem => ({ ok: false, error, errorAr });
/** Arabic-Indic and Eastern Arabic-Indic digits to ASCII. */
const arabicDigits = (s: string) =>
  s.replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
/** As arabicDigits, with spaces and dashes dropped (identifiers typed in groups). */
const digitsOnly = (s: string) => arabicDigits(s).replace(/[\s-]/g, "");

/**
 * The account particulars of a request body. A key absent from the body is left unchanged
 * (absent from `data`); a key present with "" or null clears the column.
 */
export function parseAccountFields(b: Record<string, unknown>): Parsed<AccountFields> {
  const data: AccountFields = {};
  const text = (k: string, max: number): string | null | undefined | Problem => {
    if (!(k in b)) return undefined;
    const v = b[k];
    if (v === null) return null;
    if (typeof v !== "string") return { error: `${k} must be text.`, errorAr: "قيمة غير صالحة." };
    const t = v.trim();
    if (t.length > max) return { error: `${k} is longer than ${max} characters.`, errorAr: `النص أطول من ${max} حرفًا.` };
    return t || null;
  };
  const isProblem = (x: unknown): x is Problem => !!x && typeof x === "object" && "error" in x;

  // Commercial registration (السجل التجاري): ten digits. Stored digits only; shown «CR-…».
  if ("commercialRegNo" in b) {
    const v = text("commercialRegNo", 40);
    if (isProblem(v)) return fail(v.error, v.errorAr);
    if (v) {
      const d = digitsOnly(v.replace(/^CR[-\s]*/i, ""));
      if (!/^\d{10}$/.test(d)) return fail("The commercial registration number is 10 digits.", "رقم السجل التجاري 10 أرقام.");
      data.commercialRegNo = d;
    } else data.commercialRegNo = null;
  }
  // VAT registration number (ZATCA): 15 digits, first and last digit 3.
  if ("vatNumber" in b) {
    const v = text("vatNumber", 40);
    if (isProblem(v)) return fail(v.error, v.errorAr);
    if (v) {
      const d = digitsOnly(v);
      if (!/^3\d{13}3$/.test(d)) return fail("A VAT number is 15 digits and starts and ends with 3.", "الرقم الضريبي 15 رقمًا، يبدأ بـ 3 وينتهي بـ 3.");
      data.vatNumber = d;
    } else data.vatNumber = null;
  }
  if ("segment" in b) {
    const v = b.segment;
    if (v === null || v === "") data.segment = null;
    else if (typeof v === "string" && (SEGMENTS as readonly string[]).includes(v)) data.segment = v as Segment;
    else return fail(`segment must be one of: ${SEGMENTS.join(", ")}.`, "فئة العميل غير معروفة.");
  }
  for (const k of ["city", "priceList"] as const) {
    const v = text(k, 80);
    if (isProblem(v)) return fail(v.error, v.errorAr);
    if (v !== undefined) data[k] = v;
  }
  if ("paymentTermsDays" in b) {
    const v = b.paymentTermsDays;
    if (v === null || v === "") data.paymentTermsDays = null;
    else {
      const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(digitsOnly(v)) ? Number(digitsOnly(v)) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 365) return fail("Payment terms are whole days, 0 to 365.", "شروط الدفع أيام صحيحة من 0 إلى 365.");
      data.paymentTermsDays = n;
    }
  }
  if ("creditLimit" in b) {
    const v = b.creditLimit;
    if (v === null || v === "") data.creditLimit = null;
    else {
      const d = typeof v === "string" || typeof v === "number" ? parseFiniteDecimal(typeof v === "string" ? arabicDigits(v).replace(/[\s,]/g, "") : v) : null;
      if (!d || d.isNegative() || d.decimalPlaces() > 2 || d.greaterThan("9999999999999999.99")) {
        return fail("The credit limit is an amount in SAR, zero or more, with at most two decimals.", "حد الائتمان مبلغ بالريال، صفر أو أكثر، بمنزلتين عشريتين على الأكثر.");
      }
      data.creditLimit = roundMoney(d);
    }
  }
  if ("accountOwnerId" in b) {
    const v = b.accountOwnerId;
    if (v === null || v === "") data.accountOwnerId = null;
    else if (typeof v === "string" && v.length <= 64) data.accountOwnerId = v;
    else return fail("accountOwnerId is not an employee id.", "المسؤول غير صالح.");
  }
  return { ok: true, data };
}

export type ContactInput = { name: string; role: string | null; phone: string | null; email: string | null };

/** A contact from a request body. `partial` (an edit) leaves absent keys unchanged. */
export function parseContact(b: Record<string, unknown>, partial = false): Parsed<Partial<ContactInput>> {
  const out: Partial<ContactInput> = {};
  const str = (k: string, max: number) => {
    const v = b[k];
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== "string") return "\u0000bad";
    const t = v.trim();
    return t.length > max ? "\u0000long" : t || null;
  };
  const name = str("name", 120);
  if (name === "\u0000bad" || name === "\u0000long") return fail("name must be text up to 120 characters.", "الاسم نص حتى 120 حرفًا.");
  if (name === undefined ? !partial : !name) return fail("A contact needs a name.", "جهة الاتصال تحتاج اسمًا.");
  if (name) out.name = name;
  for (const [k, max] of [["role", 80], ["phone", 40], ["email", 160]] as const) {
    const v = str(k, max);
    if (v === "\u0000bad" || v === "\u0000long") return fail(`${k} must be text up to ${max} characters.`, "قيمة غير صالحة.");
    if (v !== undefined) out[k] = v;
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return fail("That email address is not valid.", "البريد الإلكتروني غير صالح.");
  if (out.phone && !/^[+\d][\d\s()-]{5,}$/.test(digitsOnlyKeepPlus(out.phone))) return fail("That phone number is not valid.", "رقم الهاتف غير صالح.");
  if (out.phone) out.phone = digitsOnlyKeepPlus(out.phone);
  return { ok: true, data: out };
}

function digitsOnlyKeepPlus(s: string) {
  return arabicDigits(s).trim();
}
