"use client";
// The customer's «مسلّمات» in a form (soon batch round 2): VAT, CR, unified number and the structured national address.
// Shared by «عميل جديد» (customers list) and the customer page's edit dialogs. The formats are the server's
// (services/customers/customer-identity.ts, fields.ts) — the inputs only hint them.
import { Field } from "@/components/hr/ui";

export const IDENTITY_FORM_KEYS = [
  "vatNumber", "commercialRegNo", "unifiedNumber",
  "nationalBuildingNo", "nationalStreet", "nationalDistrict", "nationalCity", "nationalPostalCode", "nationalAdditionalNo", "nationalShortAddress",
] as const;
export type IdentityForm = Record<(typeof IDENTITY_FORM_KEYS)[number], string>;
export const blankIdentity = (): IdentityForm => Object.fromEntries(IDENTITY_FORM_KEYS.map((k) => [k, ""])) as IdentityForm;
const str = (c: object | null | undefined, k: string): string => {
  const v = (c as Record<string, unknown> | null | undefined)?.[k];
  return typeof v === "string" ? v : "";
};
export const identityFrom = (c: object | null | undefined): IdentityForm =>
  Object.fromEntries(IDENTITY_FORM_KEYS.map((k) => [k, str(c, k)])) as IdentityForm;
/** The keys whose value differs from the record (a «مسلّمة» changed: the dialog asks for the reason). */
export const changedIdentityKeys = (form: IdentityForm, c: object | null | undefined): string[] =>
  IDENTITY_FORM_KEYS.filter((k) => (form[k] ?? "").trim() !== str(c, k).trim());

// Round 4 (owner decision): every field here is optional — no required marks; a value given must be well-formed.
type Props = { value: IdentityForm; onChange: (v: IdentityForm) => void; ar: boolean; testPrefix?: string };

export function IdentityFields({ value, onChange, ar, testPrefix = "cid" }: Props) {
  const L = (a: string, e: string) => (ar ? a : e);
  const set = (k: keyof IdentityForm) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  const num = (k: keyof IdentityForm, label: string, ph: string, max: number) => (
    <Field label={label}>
      <input className="hr-input hr-id" dir="ltr" inputMode="numeric" maxLength={max} value={value[k]} onChange={set(k)} placeholder={ph} data-testid={`${testPrefix}-${k}`} />
    </Field>
  );
  const txt = (k: keyof IdentityForm, label: string) => (
    <Field label={label}>
      <input className="hr-input" value={value[k]} onChange={set(k)} data-testid={`${testPrefix}-${k}`} />
    </Field>
  );
  return (
    <>
      <p className="hr-label is-wide" style={{ gridColumn: "1 / -1", marginTop: 8, fontWeight: 600 }}>{L("الأرقام الرسمية", "Registration numbers")}</p>
      {num("vatNumber", L("الرقم الضريبي", "VAT number"), "3xxxxxxxxxxxxx3", 15)}
      {num("commercialRegNo", L("السجل التجاري", "CR number"), "10 أرقام", 10)}
      {num("unifiedNumber", L("الرقم الموحد", "Unified number"), "7xxxxxxxxx", 10)}
      <p className="hr-label is-wide" style={{ gridColumn: "1 / -1", marginTop: 8, fontWeight: 600 }}>{L("العنوان الوطني", "National address")}</p>
      {num("nationalBuildingNo", L("رقم المبنى", "Building no."), "4 أرقام", 4)}
      {txt("nationalStreet", L("الشارع", "Street"))}
      {txt("nationalDistrict", L("الحي", "District"))}
      {txt("nationalCity", L("المدينة", "City"))}
      {num("nationalPostalCode", L("الرمز البريدي", "Postal code"), "5 أرقام", 5)}
      {num("nationalAdditionalNo", L("الرقم الإضافي", "Additional no."), "4 أرقام", 4)}
      <Field label={L("العنوان المختصر", "Short address")}>
        <input className="hr-input hr-id" dir="ltr" maxLength={8} value={value.nationalShortAddress} onChange={set("nationalShortAddress")} placeholder="RRRD2929" data-testid={`${testPrefix}-nationalShortAddress`} />
      </Field>
    </>
  );
}

/** Read-only lines for the customer page: «العنوان الوطني: مبنى 1234، شارع …، حي …، الرياض 12345». */
export function nationalAddressLine(o: object, ar: boolean): string | null {
  const c = Object.fromEntries(IDENTITY_FORM_KEYS.map((k) => [k, str(o, k) || null])) as Record<string, string | null>;
  const parts = [
    c.nationalBuildingNo ? `${ar ? "مبنى" : "Bldg"} ${c.nationalBuildingNo}` : null,
    c.nationalStreet || null,
    c.nationalDistrict ? `${ar ? "حي" : ""} ${c.nationalDistrict}`.trim() : null,
    [c.nationalCity, c.nationalPostalCode].filter(Boolean).join(" ") || null,
    c.nationalAdditionalNo ? `${ar ? "إضافي" : "Add."} ${c.nationalAdditionalNo}` : null,
    c.nationalShortAddress || null,
  ].filter(Boolean);
  return parts.length ? parts.join(ar ? "، " : ", ") : null;
}
