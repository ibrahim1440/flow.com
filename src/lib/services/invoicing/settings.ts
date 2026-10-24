// Sales invoicing A2 — the owner's invoicing settings (SystemConfig, 20261103090000_sales_invoicing) and the
// seller particulars an issued document freezes. Parsing is pure; reading takes any client or transaction.
import { readQuoteSettings } from "@/lib/services/sales/quote-settings";
import { DEFAULT_TERMS_DAYS, SERIES_RE, isKsaVatNumber, normDigits } from "./pricing";

export const INVOICING_POINTS = ["MANUAL", "ON_DELIVERY"] as const;
export type InvoicingPoint = (typeof INVOICING_POINTS)[number];

export const SELLER_ADDRESS_FIELDS = ["sellerBuildingNo", "sellerStreet", "sellerDistrict", "sellerCity", "sellerPostalCode", "sellerAdditionalNo"] as const;
type AddrField = (typeof SELLER_ADDRESS_FIELDS)[number];

export type InvoiceSettings = {
  invoicePrefix: string; creditNotePrefix: string; debitNotePrefix: string;
  invoicingPoint: InvoicingPoint; defaultTermsDays: number;
  stored: { invoicePrefix: string | null; creditNotePrefix: string | null; debitNotePrefix: string | null; invoicingPoint: string | null; invoiceDefaultTermsDays: number | null };
  address: Record<AddrField, string | null>;
};

type Row = Partial<Record<"invoicePrefix" | "creditNotePrefix" | "debitNotePrefix" | "invoicingPoint" | AddrField, string | null>> & { invoiceDefaultTermsDays?: number | null };
type Db = { systemConfig: { findUnique(args: { where: { id: string } }): Promise<unknown> } };

export function settingsFromRow(row: Row | null | undefined): InvoiceSettings {
  const r = row ?? {};
  return {
    invoicePrefix: r.invoicePrefix || "INV", creditNotePrefix: r.creditNotePrefix || "CN", debitNotePrefix: r.debitNotePrefix || "DN",
    invoicingPoint: r.invoicingPoint === "ON_DELIVERY" ? "ON_DELIVERY" : "MANUAL",
    defaultTermsDays: r.invoiceDefaultTermsDays ?? DEFAULT_TERMS_DAYS,
    stored: { invoicePrefix: r.invoicePrefix ?? null, creditNotePrefix: r.creditNotePrefix ?? null, debitNotePrefix: r.debitNotePrefix ?? null, invoicingPoint: r.invoicingPoint ?? null, invoiceDefaultTermsDays: r.invoiceDefaultTermsDays ?? null },
    address: Object.fromEntries(SELLER_ADDRESS_FIELDS.map((k) => [k, r[k] ?? null])) as Record<AddrField, string | null>,
  };
}

export async function readInvoiceSettings(db: Db): Promise<InvoiceSettings> {
  return settingsFromRow((await db.systemConfig.findUnique({ where: { id: "singleton" } })) as Row | null);
}

export type SettingsPatch = Partial<{ invoicePrefix: string | null; creditNotePrefix: string | null; debitNotePrefix: string | null; invoicingPoint: string | null; invoiceDefaultTermsDays: number | null } & Record<AddrField, string | null>>;

/** PUT body → the columns to write, or the field that is wrong. */
export function parseSettingsPatch(b: Record<string, unknown>): { ok: true; data: SettingsPatch } | { ok: false; field: string; ar: string; en: string } {
  const data: SettingsPatch = {};
  for (const k of ["invoicePrefix", "creditNotePrefix", "debitNotePrefix"] as const) {
    if (!(k in b)) continue;
    const v = b[k];
    if (v === null || v === "") { data[k] = null; continue; }
    const s = typeof v === "string" ? v.trim().toUpperCase() : "";
    if (!SERIES_RE.test(s)) return { ok: false, field: k, ar: "البادئة من 1 إلى 10 أحرف لاتينية كبيرة أو أرقام (مثل INV).", en: "A prefix is 1–10 capital letters or digits (e.g. INV)." };
    data[k] = s;
  }
  if ("invoicingPoint" in b) {
    const v = b.invoicingPoint;
    if (v === null || v === "") data.invoicingPoint = null;
    else if (typeof v === "string" && (INVOICING_POINTS as readonly string[]).includes(v)) data.invoicingPoint = v;
    else return { ok: false, field: "invoicingPoint", ar: "نقطة الفوترة: يدويًا أو عند التسليم.", en: "The invoicing point is MANUAL or ON_DELIVERY." };
  }
  if ("defaultTermsDays" in b) {
    const v = b.defaultTermsDays;
    if (v === null || v === "") data.invoiceDefaultTermsDays = null;
    else {
      const n = typeof v === "number" ? v : Number(normDigits(String(v)));
      if (!Number.isInteger(n) || n < 0 || n > 365) return { ok: false, field: "defaultTermsDays", ar: "مدة السداد أيام صحيحة من 0 إلى 365.", en: "Payment terms are 0 to 365 whole days." };
      data.invoiceDefaultTermsDays = n;
    }
  }
  for (const k of SELLER_ADDRESS_FIELDS) {
    if (!(k in b)) continue;
    const v = b[k];
    const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : "";
    if (k === "sellerPostalCode" && s && !/^\d{5}$/.test(normDigits(s))) return { ok: false, field: k, ar: "الرمز البريدي 5 أرقام.", en: "The postal code is 5 digits." };
    if (k === "sellerBuildingNo" && s && !/^\d{4}$/.test(normDigits(s))) return { ok: false, field: k, ar: "رقم المبنى 4 أرقام.", en: "The building number is 4 digits." };
    data[k] = s ? (k === "sellerPostalCode" || k === "sellerBuildingNo" || k === "sellerAdditionalNo" ? normDigits(s) : s) : null;
  }
  return { ok: true, data };
}

export type SellerSnapshot = {
  name: string | null; nameEn: string | null; vatNumber: string | null; crNumber: string | null; phone: string | null;
  address: string | null; addressEn: string | null; buildingNo: string | null; street: string | null; district: string | null; city: string | null;
  postalCode: string | null; additionalNo: string | null; countryCode: "SA";
  bank: { name: string | null; accountName: string | null; iban: string | null };
};

/** The seller particulars as they stand (frozen into the document at issue). */
export async function sellerSnapshot(db: Db): Promise<SellerSnapshot> {
  const q = await readQuoteSettings(db);
  const s = await readInvoiceSettings(db);
  return {
    name: q.seller.sellerLegalNameAr || q.seller.sellerLegalNameEn, nameEn: q.seller.sellerLegalNameEn,
    vatNumber: q.seller.sellerVatNumber, crNumber: q.seller.sellerCrNumber, phone: q.seller.sellerPhone,
    address: q.seller.sellerAddressAr, addressEn: q.seller.sellerAddressEn,
    buildingNo: s.address.sellerBuildingNo, street: s.address.sellerStreet, district: s.address.sellerDistrict, city: s.address.sellerCity,
    postalCode: s.address.sellerPostalCode, additionalNo: s.address.sellerAdditionalNo, countryCode: "SA",
    bank: { name: q.seller.sellerBankName, accountName: q.seller.sellerBankAccountName, iban: q.seller.sellerIban },
  };
}

export const sellerReady = (s: Pick<SellerSnapshot, "name" | "vatNumber">) => !!s.name && isKsaVatNumber(s.vatNumber);
