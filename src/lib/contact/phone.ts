// P1 ERR-04 (owner QA): ONE place that reads a phone number and an e-mail address typed by a person — the lead form, its
// edit, the field round, the CSV import, the customer form and its edit, the customer's contacts and the profile all use
// it. Pure (no database, no server-only import): the forms use the same rules to say what is wrong before sending.
//
//   phone  → stored canonical: a Saudi number as +966XXXXXXXXX (mobile +9665XXXXXXXX, landline +9661XXXXXXXX…); any other
//            country in international form (+ then 8–15 digits). Arabic-Indic / Persian digits are read as digits; spaces,
//            dashes, dots and brackets are ignored. "abc", "123", a run of zeros, a local number of the wrong length are
//            refused. Idempotent: the canonical form parses to itself.
//   email  → lower-cased, one address, a real domain with a TLD (the rules of automation/email-mode.ts parseEmailAddress).
//
// Derived, never stored separately: `waDigits` (the WhatsApp wire form 9665…, what the message tables hold) and `last9`
// (the duplicate key: Lead.normalizedPhone and the Customer_phone_last9_idx expression).

const AR = "٠١٢٣٤٥٦٧٨٩", FA = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-Indic and Persian digits → ASCII. */
export function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) => String(AR.includes(c) ? AR.indexOf(c) : FA.indexOf(c)));
}

export type PhoneResult = { ok: true; phone: string } | { ok: false; code: "PHONE_INVALID"; ar: string; en: string };

const BAD: PhoneResult = {
  ok: false, code: "PHONE_INVALID",
  ar: "رقم الجوال غير صحيح — اكتبه مثل 05XXXXXXXX أو +9665XXXXXXXX.",
  en: "The phone number is not valid — write it like 05XXXXXXXX or +9665XXXXXXXX.",
};

/** A typed phone → its canonical form, or why not. Empty input is not handled here (callers treat "" as "no phone"). */
export function parsePhone(raw: unknown): PhoneResult {
  if (typeof raw !== "string" && typeof raw !== "number") return BAD;
  let s = toLatinDigits(String(raw)).trim();
  if (!/^[+\d\s().\-]+$/.test(s)) return BAD; // letters, @, … — not a phone
  const plus = s.startsWith("+");
  s = s.replace(/\D/g, "");
  // Gate R1: Saudi service numbers are domestic only — the unified number «9200 XXXXX» (9 digits) and toll-free
  // «800 XXX XXXX» (10 digits) are stored as dialled (no +966: they cannot be reached from abroad).
  if (!plus && /^9200\d{5}$/.test(s)) return { ok: true, phone: s };
  if (!plus && /^800\d{7}$/.test(s)) return { ok: true, phone: s };
  if (!plus && s.startsWith("00")) s = s.slice(2); // 00966… → 966…
  else if (!plus) {
    // Local Saudi forms: 05XXXXXXXX / 5XXXXXXXX (mobile); 01XXXXXXXX (landline: area 11–17 etc., 9 national digits like a mobile).
    if (/^05\d{8}$/.test(s)) s = `966${s.slice(1)}`;
    else if (/^5\d{8}$/.test(s)) s = `966${s}`;
    else if (/^0[1-7]\d{8}$/.test(s)) s = `966${s.slice(1)}`;
    else if (!/^966/.test(s)) return BAD; // a bare local number of any other shape
  }
  if (/^9660/.test(s)) s = `966${s.slice(4)}`; // +966 05… typed with the trunk 0
  if (s.startsWith("966")) {
    const n = s.slice(3);
    if (/^5\d{8}$/.test(n) || /^[1-7]\d{8}$/.test(n)) return { ok: true, phone: `+966${n}` };
    return BAD;
  }
  // Any other country: + then 8–15 digits, not starting with 0, not one repeated digit.
  if (!/^[1-9]\d{7,14}$/.test(s) || /^(\d)\1+$/.test(s)) return BAD;
  return { ok: true, phone: `+${s}` };
}

/** The WhatsApp wire form (no "+"): what the message tables and wa.me hold. Null when not a phone. */
export function waDigits(raw: unknown): string | null {
  const r = parsePhone(raw);
  // A service number (9200 / 800) has no WhatsApp.
  return r.ok && r.phone.startsWith("+") ? r.phone.slice(1) : null;
}

/** The duplicate key: the last 9 digits (any stored format). Null under 7 digits. Arabic digits are read. */
export function last9(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const d = toLatinDigits(raw).replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-9) : null;
}

/**
 * How a stored phone is shown to staff and on print (owner decision 4, 12 Nov 2026): a Saudi number in its local form —
 * «05X XXX XXXX» for a mobile, «01X XXX XXXX» for a landline — with +9665… stored behind it; any other country in its
 * international form (+ and the digits). Idempotent; an unreadable value is shown as stored.
 */
export function displayPhone(p: string | null | undefined): string {
  if (!p) return "";
  const r = parsePhone(p);
  if (!r.ok) return p;
  if (/^9200\d{5}$/.test(r.phone)) return `9200 ${r.phone.slice(4)}`;
  if (/^800\d{7}$/.test(r.phone)) return `800 ${r.phone.slice(3, 6)} ${r.phone.slice(6)}`;
  const m = /^\+966(\d{2})(\d{3})(\d{4})$/.exec(r.phone);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : r.phone;
}

export type EmailResult = { ok: true; email: string } | { ok: false; code: "EMAIL_INVALID"; ar: string; en: string };

/** One e-mail address, lower-cased, with a real domain — or why not. */
export function parseEmail(raw: unknown): EmailResult {
  const bad: EmailResult = { ok: false, code: "EMAIL_INVALID", ar: "البريد الإلكتروني غير صحيح — مثل name@cafe.com.", en: "The e-mail address is not valid — like name@cafe.com." };
  if (typeof raw !== "string") return bad;
  const t = raw.trim().toLowerCase();
  if (!t || t.length > 254 || /[\s,;<>"'()\\]/.test(t) || (t.match(/@/g) ?? []).length !== 1) return bad;
  const [local, domain] = t.split("@");
  if (!local || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain)) return bad;
  return { ok: true, email: t };
}

/**
 * The write paths' helper: a request field → what to store. `undefined` = the field was not sent (leave it); `null` =
 * cleared; a string = the canonical value. An invalid value throws the coded 400 every route answers through
 * handleDomainError (the Arabic message for the screen, the English one for the English screen).
 */
export function phoneField(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && !v.trim())) return null;
  const r = parsePhone(v);
  if (!r.ok) throw { _appCode: 400, code: r.code, message: r.ar, errorAr: r.ar, errorEn: r.en, field: "phone" };
  return r.phone;
}

export function emailField(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && !v.trim())) return null;
  const r = parseEmail(v);
  if (!r.ok) throw { _appCode: 400, code: r.code, message: r.ar, errorAr: r.ar, errorEn: r.en, field: "email" };
  return r.email;
}

/**
 * A search box's phone key: digits only (Arabic digits read), without the country code or the trunk 0 — so «055 123»,
 * «+96655123» and «٠٥٥١٢٣» all find a number stored as +966551234567 (or an older 0551234567). Null under 3 digits.
 */
export function phoneSearchKey(q: string | null | undefined): string | null {
  if (typeof q !== "string") return null;
  let d = toLatinDigits(q).replace(/\D/g, "");
  if (d.startsWith("00966")) d = d.slice(5);
  else if (d.startsWith("966")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return d.length >= 3 ? d : null;
}
