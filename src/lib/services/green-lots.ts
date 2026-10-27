/**
 * A green-coffee lot's record from the lot form («لوط جديد»: serial, names in both languages, origin, process,
 * variety, altitude, storage location) — the one mapping POST /api/green-beans and the one-step purchase invoice
 * (a new lot entered inline, created in the same save) both use, so the two cannot drift apart.
 */
function nullify(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export type GreenLotFields = {
  serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; countryAr: string | null;
  region: string | null; regionAr: string | null; variety: string | null; process: string | null; processAr: string | null;
  altitude: string | null; location: string | null;
};

/** The lot's fields (without its quantity) from the form's body; the serial is generated when left empty. */
export function greenLotFields(raw: Record<string, unknown>): GreenLotFields {
  const serialNumber =
    text(raw.serialNumber) ||
    `GB-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(Math.random() * 900 + 100)}`;
  return {
    serialNumber,
    beanType: text(raw.beanType) || "Unknown",
    beanTypeAr: nullify(raw.beanTypeAr),
    country: text(raw.country) || "Unknown",
    countryAr: nullify(raw.countryAr),
    region: nullify(raw.region),
    regionAr: nullify(raw.regionAr),
    variety: nullify(raw.variety),
    process: nullify(raw.process),
    processAr: nullify(raw.processAr),
    altitude: nullify(raw.altitude),
    location: nullify(raw.location),
  };
}
