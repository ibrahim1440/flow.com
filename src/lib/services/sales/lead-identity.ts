// «عميل محتمل جديد» = the customer form (owner-approved Figma page 12, 5 Nov 2026). A lead carries the customer's
// registration and national address (migration 20261221090000_lead_identity) so that converting it asks for nothing
// again. Pure (client- and test-safe): the SAME parsers and formats as the customer — expandRegistrationNo (the one
// field «السجل التجاري / الرقم الموحد»), parseAccountFields (VAT, CR), parseNationalFields (unified number, address).
//
// On a lead these fields are free (format checks only, no «reason» rule): a lead is unverified pre-customer data; the
// customer rules (duplicate check, reason for a later change) apply once it becomes a customer (orchestrator decision,
// 5 Nov 2026).
import { parseAccountFields } from "@/lib/services/customers/fields";
import { expandRegistrationNo, parseNationalFields, addressFromNational } from "@/lib/services/customers/customer-identity";

export const LEAD_IDENTITY_FIELDS = [
  "vatNumber", "commercialRegNo", "unifiedNumber",
  "nationalBuildingNo", "nationalStreet", "nationalDistrict", "nationalCity", "nationalPostalCode", "nationalAdditionalNo", "nationalShortAddress",
] as const;
export type LeadIdentityField = (typeof LEAD_IDENTITY_FIELDS)[number];
export type LeadIdentity = Partial<Record<LeadIdentityField, string | null>>;

type Problem = { ok: false; error: string; errorAr: string; field?: string };

/** The identity fields of a lead body. Absent keys stay absent; "" / null clear. */
export function parseLeadIdentity(body: Record<string, unknown>): { ok: true; data: LeadIdentity } | Problem {
  const ex = expandRegistrationNo(body);
  if (!ex.ok) return ex;
  const b = ex.body;
  const pick: Record<string, unknown> = {};
  for (const k of LEAD_IDENTITY_FIELDS) if (k in b) pick[k] = b[k] === "" ? null : b[k];

  // Each parsed alone so a refusal names its field (gate L2: the form highlights the input).
  for (const k of ["vatNumber", "commercialRegNo"] as const) {
    if (!(k in pick)) continue;
    const one = parseAccountFields({ [k]: pick[k] });
    if (!one.ok) return { ok: false, error: one.error, errorAr: one.errorAr, field: k === "commercialRegNo" && "registrationNo" in body ? "registrationNo" : k };
  }
  const acct = parseAccountFields({ ...("vatNumber" in pick ? { vatNumber: pick.vatNumber } : {}), ...("commercialRegNo" in pick ? { commercialRegNo: pick.commercialRegNo } : {}) });
  if (!acct.ok) return { ok: false, error: acct.error, errorAr: acct.errorAr };
  const nat = parseNationalFields(Object.fromEntries(Object.entries(pick).filter(([k]) => k !== "vatNumber" && k !== "commercialRegNo")));
  if (!nat.ok) return nat;

  const data: LeadIdentity = {};
  if ("vatNumber" in acct.data) data.vatNumber = acct.data.vatNumber ?? null;
  if ("commercialRegNo" in acct.data) data.commercialRegNo = acct.data.commercialRegNo ?? null;
  for (const [k, v] of Object.entries(nat.data)) if ((LEAD_IDENTITY_FIELDS as readonly string[]).includes(k)) data[k as LeadIdentityField] = v ?? null;
  return { ok: true, data };
}

/** The lead's city from its national address (null = keep what is there). Pure. */
export function leadCityFrom(d: LeadIdentity): string | null {
  return addressFromNational(d).city;
}
