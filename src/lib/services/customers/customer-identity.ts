// The customer's «مسلّمات» — the buyer identity and national address a ZATCA standard invoice carries (owner decision,
// Nov 2026, soon batch round 2). Pure (client- and test-safe): the field set, its formats with Arabic messages, the reason
// rule for a later change, and the before → after of a change.
//
//   · VAT (الرقم الضريبي) and CR (السجل التجاري) are parsed by fields.ts parseAccountFields (unchanged formats: 15 digits
//     starting and ending with 3; 10 digits). This file adds the unified number (الرقم الموحد: 10 digits starting with 7)
//     and the structured national address (رقم المبنى 4 digits, الشارع, الحي, المدينة, الرمز البريدي 5 digits,
//     الرقم الإضافي 4 digits, العنوان المختصر optional) — the database CHECKs the same (migration 20261220090000).
//   · A CHANGE of any of them (also a first entry, also a clear) needs a reason — for everyone, the account owner and a
//     customers editor alike: trimmed, at least 5 characters; else 400 REASON_REQUIRED. The reason, with before → after,
//     goes to the customer's activity log and to the audit log (PUT /api/customers/[id]).
//   · Registration (round 4, owner decision): only the name is required, for everyone; every field here is optional.
//     A value given must be well-formed; an empty one is NULL (never a CHECK violation, never a duplicate).

export const IDENTITY_FIELDS = [
  "vatNumber", "commercialRegNo", "unifiedNumber",
  "nationalBuildingNo", "nationalStreet", "nationalDistrict", "nationalCity", "nationalPostalCode", "nationalAdditionalNo", "nationalShortAddress",
] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** The fields this file parses (VAT and CR are parsed by parseAccountFields). */
export const NATIONAL_FIELDS = [
  "unifiedNumber", "nationalBuildingNo", "nationalStreet", "nationalDistrict", "nationalCity", "nationalPostalCode", "nationalAdditionalNo", "nationalShortAddress",
] as const;
export type NationalField = (typeof NATIONAL_FIELDS)[number];
export type NationalFields = Partial<Record<NationalField, string | null>>;

export const FIELD_LABELS_AR: Record<string, string> = {
  name: "اسم العميل", phone: "الجوال", email: "الإيميل", city: "المدينة", address: "العنوان",
  vatNumber: "الرقم الضريبي", commercialRegNo: "السجل التجاري", unifiedNumber: "الرقم الموحد",
  nationalBuildingNo: "رقم المبنى", nationalStreet: "الشارع", nationalDistrict: "الحي", nationalCity: "مدينة العنوان الوطني",
  nationalPostalCode: "الرمز البريدي", nationalAdditionalNo: "الرقم الإضافي", nationalShortAddress: "العنوان المختصر",
};

type Problem = { ok: false; error: string; errorAr: string; field: string };
const fail = (field: string, error: string, errorAr: string): Problem => ({ ok: false, field, error, errorAr });
const toAscii = (s: string) => s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
const digits = (s: string) => toAscii(s).replace(/[\s-]/g, "");

/** The unified number and the national address of a body. Absent keys are absent from `data`; "" / null clear. */
export function parseNationalFields(b: Record<string, unknown>): { ok: true; data: NationalFields } | Problem {
  const data: NationalFields = {};
  for (const k of NATIONAL_FIELDS) {
    if (!(k in b)) continue;
    const raw = b[k];
    if (raw === null || raw === "") { data[k] = null; continue; }
    if (typeof raw !== "string") return fail(k, `${k} must be text.`, `${FIELD_LABELS_AR[k]}: قيمة غير صالحة.`);
    const t = raw.trim();
    if (!t) { data[k] = null; continue; }
    switch (k) {
      case "unifiedNumber": {
        const d = digits(t);
        if (!/^7\d{9}$/.test(d)) return fail(k, "The unified number is 10 digits starting with 7.", "الرقم الموحد 10 أرقام يبدأ بـ 7.");
        data[k] = d; break;
      }
      case "nationalBuildingNo": case "nationalAdditionalNo": {
        const d = digits(t);
        if (!/^\d{4}$/.test(d)) return fail(k, `${k === "nationalBuildingNo" ? "The building number" : "The additional number"} is 4 digits.`, `${FIELD_LABELS_AR[k]} 4 أرقام.`);
        data[k] = d; break;
      }
      case "nationalPostalCode": {
        const d = digits(t);
        if (!/^\d{5}$/.test(d)) return fail(k, "The postal code is 5 digits.", "الرمز البريدي 5 أرقام.");
        data[k] = d; break;
      }
      case "nationalShortAddress": {
        const v = toAscii(t).replace(/\s+/g, "").toUpperCase();
        if (!/^[A-Z]{4}\d{4}$/.test(v)) return fail(k, "The short address is 4 letters and 4 digits (e.g. RRRD2929).", "العنوان المختصر 4 أحرف و4 أرقام، مثل RRRD2929.");
        data[k] = v; break;
      }
      default: {
        const max = k === "nationalCity" ? 80 : 120;
        if (t.length > max) return fail(k, `${k} is longer than ${max} characters.`, `${FIELD_LABELS_AR[k]} أطول من ${max} حرفًا.`);
        data[k] = t;
      }
    }
  }
  return { ok: true, data };
}

/** The reason for changing a «مسلّمة»: trimmed, at least 5 characters (max 500), else null. Pure. */
export function parseChangeReason(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t.length >= 5 ? t.slice(0, 500) : null;
}

export type IdentityChange = { field: IdentityField; from: string | null; to: string | null };

/** The «مسلّمات» this write really changes (a value sent unchanged is no change). Pure. */
export function identityChanges(before: Record<string, unknown>, next: Record<string, unknown>): IdentityChange[] {
  const norm = (x: unknown) => (x === undefined || x === null || x === "" ? null : String(x));
  const out: IdentityChange[] = [];
  for (const f of IDENTITY_FIELDS) {
    if (!(f in next)) continue;
    const from = norm(before[f]), to = norm(next[f]);
    if (from !== to) out.push({ field: f, from, to });
  }
  return out;
}

/** The activity-log lines of a change: «الرقم الضريبي: من 300…003 إلى 311…003». Pure. */
export function describeIdentityChanges(changes: IdentityChange[]): string {
  return changes.map((c) => `${FIELD_LABELS_AR[c.field]}: من ${c.from ?? "—"} إلى ${c.to ?? "—"}`).join("\n");
}

/**
 * The «exact normalised name» the duplicate check compares (round 3, gate M1): trimmed, inner whitespace collapsed,
 * Arabic-Indic digits to ASCII, lower case; tatweel removed. The database side (duplicates.ts) applies the same steps.
 */
export function normaliseCustomerName(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = toAscii(s).replace(/ـ/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return t || null;
}

/** The refusal of a registration or change that matches an existing customer — never naming that customer or its owner. */
export const DUPLICATE_CUSTOMER = {
  code: "DUPLICATE_CUSTOMER",
  error: "هذا العميل مسجّل مسبقًا — اطلب من مشرفك إسناده لك.",
  errorEn: "This customer is already registered — ask your supervisor to assign it to you.",
} as const;
