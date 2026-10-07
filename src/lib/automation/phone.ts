/**
 * Phone numbers for WhatsApp: whatever a person typed, to the digits the WhatsApp server
 * expects — international, no "+", no leading zeros (9665XXXXXXXX).
 *
 * Pure, so it is shared by the rule validator, the dispatcher and the screens.
 *
 * ── Saudi first, not Saudi only ──
 * Almost every number in this system is a Saudi mobile written the local way: 05XXXXXXXX.
 * Those are completed with 966. A number written in international form (+, 00, or already
 * starting with a country code) is accepted for any country. A local number that is not a
 * Saudi mobile is refused rather than guessed at: completing it with the wrong country code
 * messages a stranger.
 */

export type PhoneResult = { ok: true; phone: string } | { ok: false; reason: string };

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

function asciiDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const a = ARABIC_INDIC.indexOf(ch);
    const p = PERSIAN.indexOf(ch);
    out += a >= 0 ? String(a) : p >= 0 ? String(p) : ch;
  }
  return out;
}

export function normalizePhoneForWhatsApp(raw: string | null | undefined): PhoneResult {
  if (raw == null || raw.trim() === "") return { ok: false, reason: "No phone number." };

  const text = asciiDigits(raw.trim());
  const international = text.startsWith("+") || text.startsWith("00");
  let digits = text.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);

  if (digits.length === 0) return { ok: false, reason: "No phone number." };

  // Saudi mobile, every common spelling: 05XXXXXXXX, 5XXXXXXXX, 9665XXXXXXXX, 96605XXXXXXXX.
  if (/^05\d{8}$/.test(digits)) return { ok: true, phone: `966${digits.slice(1)}` };
  if (!international && /^5\d{8}$/.test(digits)) return { ok: true, phone: `966${digits}` };
  if (/^9660(5\d{8})$/.test(digits)) return { ok: true, phone: `966${digits.slice(4)}` };
  if (digits.startsWith("966")) {
    return /^9665\d{8}$/.test(digits)
      ? { ok: true, phone: digits }
      : { ok: false, reason: "Not a valid Saudi mobile number." };
  }

  if (digits.startsWith("0")) {
    return { ok: false, reason: "A local number that is not a Saudi mobile. Write it with its country code." };
  }
  // E.164 allows 8–15 digits including the country code.
  if (digits.length < 8 || digits.length > 15) return { ok: false, reason: "Not a valid phone number." };
  return { ok: true, phone: digits };
}

/** For display: 9665XXXXXXXX → +966 5X XXX XXXX. Anything else is shown with a "+". */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const m = /^966(5\d)(\d{3})(\d{4})$/.exec(phone);
  return m ? `+966 ${m[1]} ${m[2]} ${m[3]}` : `+${phone}`;
}
