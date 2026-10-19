// Quotation settings (migration 20261021090000_sales_quotes): the owner's discount-approval
// threshold and the seller block printed on the quotation document. Both live on the
// "SystemConfig" singleton, the organisation's settings row (it already holds the logo).
//
// The threshold: NULL means the owner has not set one, and the built-in policy value
// (DISCOUNT_APPROVAL_THRESHOLD, 10%) applies — the behaviour this system has always had. Setting
// it changes the figure; nothing turns the approval rule off.
//
// Parsing is pure (asserted without a database); reading takes any Prisma client or transaction.
import { parseFiniteDecimal, Decimal } from "../commissions/engine";
import { parseAccountFields } from "../customers/fields";
import { DISCOUNT_APPROVAL_THRESHOLD, DISCOUNT_MAX } from "./discount-limits";

export const SELLER_FIELDS = [
  "sellerLegalNameAr", "sellerLegalNameEn", "sellerAddressAr", "sellerAddressEn",
  "sellerVatNumber", "sellerCrNumber", "sellerPhone",
  // The bank transfer details printed on the quotation («بيانات التحويل البنكي»). Part of the
  // seller block, so they share its gate, its audit and its freeze into the issued snapshot.
  "sellerBankName", "sellerBankAccountName", "sellerIban",
] as const;
export type SellerField = (typeof SELLER_FIELDS)[number];
export type Seller = Record<SellerField, string | null>;

export type QuoteSettings = {
  /** What the owner stored, as text ("12.50"), or null when not set. */
  discountApprovalPercent: string | null;
  /** The threshold in force: the stored value, else the built-in one. */
  effectiveThresholdPercent: string;
  /** True when the built-in value is in force (nothing stored). */
  thresholdIsDefault: boolean;
  seller: Seller;
};

type ConfigRow = { quoteDiscountApprovalPercent: { toString(): string } | null } & Partial<Record<SellerField, string | null>>;
type Db = { systemConfig: { findUnique(args: { where: { id: string } }): Promise<unknown> } };

export const EMPTY_SELLER: Seller = Object.fromEntries(SELLER_FIELDS.map((k) => [k, null])) as Seller;

/** The settings as a plain object, from a SystemConfig row (or none). */
export function settingsFromRow(row: ConfigRow | null | undefined): QuoteSettings {
  const stored = row?.quoteDiscountApprovalPercent ?? null;
  const storedText = stored === null ? null : new Decimal(stored.toString()).toFixed(2);
  const seller = { ...EMPTY_SELLER };
  for (const k of SELLER_FIELDS) seller[k] = (row?.[k] ?? null) || null;
  return {
    discountApprovalPercent: storedText,
    effectiveThresholdPercent: storedText === null ? String(DISCOUNT_APPROVAL_THRESHOLD) : trimZeros(storedText),
    thresholdIsDefault: storedText === null,
    seller,
  };
}

/** "12.50" → "12.5", "10.00" → "10": the figure as people write it. */
function trimZeros(s: string): string {
  return new Decimal(s).toString();
}

/** Read the settings. A missing singleton row reads as "nothing set". Never writes. */
export async function readQuoteSettings(db: Db): Promise<QuoteSettings> {
  const row = (await db.systemConfig.findUnique({ where: { id: "singleton" } })) as ConfigRow | null;
  return settingsFromRow(row);
}

/** The threshold in force, as a Decimal, for the pricing rules. */
export async function discountThreshold(db: Db): Promise<Decimal> {
  return new Decimal((await readQuoteSettings(db)).effectiveThresholdPercent);
}

type Problem = { ok: false; error: string; errorAr: string };
export type SettingsPatch = {
  quoteDiscountApprovalPercent?: Decimal | null;
} & Partial<Record<SellerField, string | null>>;

const MAX_LEN: Record<SellerField, number> = {
  sellerLegalNameAr: 160, sellerLegalNameEn: 160, sellerAddressAr: 300, sellerAddressEn: 300,
  sellerVatNumber: 40, sellerCrNumber: 40, sellerPhone: 40,
  // The IBAN as typed (spaces allowed); it is checked and normalised below.
  sellerBankName: 120, sellerBankAccountName: 160, sellerIban: 60,
};

/**
 * A Saudi IBAN as typed → the stored form, or null when it is not one.
 *
 * «SA» and 22 digits (24 characters). Spaces (and the non-breaking or thin spaces and direction marks a
 * paste brings) are allowed on input and dropped; Arabic-Indic digits are read as Latin ones; the
 * letters may be typed in lower case. Stored without spaces, upper case. The check is the
 * format only: the bank's own check digits are not verified here.
 */
export function normalizeIban(raw: string): string | null {
  const t = raw
    .replace(/[\s\u00a0\u2000-\u200f\u202a-\u202f\u2066-\u2069]/g, "")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toUpperCase();
  return /^SA\d{22}$/.test(t) ? t : null;
}


/**
 * A PUT body → the columns to write. A key absent from the body is left unchanged; "" or null
 * clears it (for the threshold: back to the built-in value). The VAT and CR numbers follow the
 * same rules as a customer's (15 digits 3…3; 10 digits), and are stored digits only.
 */
export function parseSettingsPatch(b: Record<string, unknown>): { ok: true; data: SettingsPatch } | Problem {
  const data: SettingsPatch = {};
  if ("discountApprovalPercent" in b) {
    const v = b.discountApprovalPercent;
    if (v === null || v === "") data.quoteDiscountApprovalPercent = null;
    else {
      const d = typeof v === "string" || typeof v === "number" ? parseFiniteDecimal(v) : null;
      if (!d || d.isNegative() || d.greaterThan(DISCOUNT_MAX) || d.decimalPlaces() > 2) {
        return {
          ok: false,
          error: `The discount threshold is a percentage from 0 to ${DISCOUNT_MAX}, with at most two decimals.`,
          errorAr: `حد الخصم نسبة من 0 إلى ${DISCOUNT_MAX}، بمنزلتين عشريتين على الأكثر.`,
        };
      }
      data.quoteDiscountApprovalPercent = d;
    }
  }
  for (const k of SELLER_FIELDS) {
    if (!(k in b)) continue;
    const v = b[k];
    if (v === null) { data[k] = null; continue; }
    if (typeof v !== "string") return { ok: false, error: `${k} must be text.`, errorAr: "قيمة غير صالحة." };
    const t = v.trim();
    if (t.length > MAX_LEN[k]) return { ok: false, error: `${k} is longer than ${MAX_LEN[k]} characters.`, errorAr: `النص أطول من ${MAX_LEN[k]} حرفًا.` };
    data[k] = t || null;
  }
  if (data.sellerIban) {
    const iban = normalizeIban(data.sellerIban);
    if (!iban) {
      return {
        ok: false,
        error: "The IBAN is SA followed by 22 digits (spaces allowed).",
        errorAr: "رقم الآيبان يبدأ بـ SA ويليه 22 رقمًا (المسافات مسموحة).",
      };
    }
    data.sellerIban = iban;
  }
  // Identifiers: the customer rules, one definition.
  const ids: Record<string, unknown> = {};
  if (data.sellerVatNumber) ids.vatNumber = data.sellerVatNumber;
  if (data.sellerCrNumber) ids.commercialRegNo = data.sellerCrNumber;
  if (Object.keys(ids).length) {
    const parsed = parseAccountFields(ids);
    if (!parsed.ok) return { ok: false, error: parsed.error, errorAr: parsed.errorAr };
    if (data.sellerVatNumber) data.sellerVatNumber = parsed.data.vatNumber ?? null;
    if (data.sellerCrNumber) data.sellerCrNumber = parsed.data.commercialRegNo ?? null;
  }
  return { ok: true, data };
}
