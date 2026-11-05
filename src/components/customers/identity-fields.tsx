"use client";
// The customer's «مسلّمات» in a form (soon batch round 2): VAT, CR, unified number and the structured national address.
// Shared by «عميل جديد» (customers list) and the customer page's edit dialogs. The formats are the server's
// (services/customers/customer-identity.ts, fields.ts) — the inputs only hint them.
import type { ReactNode } from "react";
import { Field } from "@/components/hr/ui";
import { registrationNoOf } from "@/lib/services/customers/customer-identity";

// «السجل التجاري / الرقم الموحد» is ONE field (owner decision, 5 Nov 2026): `registrationNo`, which the server stores
// in its column (7… → unified number, else CR) — customer-identity.ts expandRegistrationNo.
export const IDENTITY_FORM_KEYS = [
  "vatNumber", "registrationNo",
  "nationalBuildingNo", "nationalStreet", "nationalDistrict", "nationalCity", "nationalPostalCode", "nationalAdditionalNo", "nationalShortAddress",
] as const;
export type IdentityForm = Record<(typeof IDENTITY_FORM_KEYS)[number], string>;
export const blankIdentity = (): IdentityForm => Object.fromEntries(IDENTITY_FORM_KEYS.map((k) => [k, ""])) as IdentityForm;
const str = (c: object | null | undefined, k: string): string => {
  const v = (c as Record<string, unknown> | null | undefined)?.[k];
  return typeof v === "string" ? v : "";
};
const recordValue = (c: object | null | undefined, k: string): string =>
  k === "registrationNo" ? registrationNoOf(c as { commercialRegNo?: string | null; unifiedNumber?: string | null }) : str(c, k);
export const identityFrom = (c: object | null | undefined): IdentityForm =>
  Object.fromEntries(IDENTITY_FORM_KEYS.map((k) => [k, recordValue(c, k)])) as IdentityForm;
/** The keys whose value differs from the record (a «مسلّمة» changed: the dialog asks for the reason). */
export const changedIdentityKeys = (form: IdentityForm, c: object | null | undefined): string[] =>
  IDENTITY_FORM_KEYS.filter((k) => (form[k] ?? "").trim() !== recordValue(c, k).trim());
/** The edit body: only the «مسلّمات» that changed (an unchanged merged number is never re-sent, so a legacy customer
 *  holding both a CR and a unified number keeps them until someone edits the field). */
export const changedIdentityBody = (form: IdentityForm, c: object | null | undefined): Partial<IdentityForm> =>
  Object.fromEntries(changedIdentityKeys(form, c).map((k) => [k, form[k as keyof IdentityForm]]));
/** A legacy customer with BOTH numbers (possible before 5 Nov 2026): the note under the merged field. */
export function legacyRegistrationNote(c: object | null | undefined, ar: boolean): ReactNode {
  const cr = str(c, "commercialRegNo"), uni = str(c, "unifiedNumber");
  if (!cr || !uni) return null;
  return <>{ar ? "مسجّل له رقمان: السجل" : "Two numbers on file: CR"} <bdi dir="ltr">{cr}</bdi> · {ar ? "الموحد" : "unified"} <bdi dir="ltr">{uni}</bdi>. {ar ? "إذا عدّلت الخانة يبقى الرقم الجديد فقط." : "Editing the field keeps only the new number."}</>;
}
/** The national address is the customer's address (5 Nov 2026); the free address / city are shown for a legacy
 *  customer only — one that has them and no national address. */
export const showsLegacyAddress = (c: object | null | undefined): boolean =>
  !!(str(c, "address") || str(c, "city")) && !IDENTITY_FORM_KEYS.slice(2).some((k) => str(c, k));

// Round 4 (owner decision): every field here is optional — no required marks; a value given must be well-formed.
type Props = { value: IdentityForm; onChange: (v: IdentityForm) => void; ar: boolean; testPrefix?: string; registrationHint?: ReactNode };

export function IdentityFields({ value, onChange, ar, testPrefix = "cid", registrationHint }: Props) {
  const L = (a: string, e: string) => (ar ? a : e);
  const set = (k: keyof IdentityForm) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  const num = (k: keyof IdentityForm, label: string, ph: string, max: number, help?: ReactNode) => (
    <Field label={label} help={help}>
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
      {num("registrationNo", L("السجل التجاري / الرقم الموحد", "CR / unified number"), "7xxxxxxxxx", 12, registrationHint ?? L("10 أرقام — أي واحد منهم", "10 digits — either one"))}
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
