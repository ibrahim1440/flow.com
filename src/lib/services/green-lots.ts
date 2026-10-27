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
  sackCount: number | null; sackWeightKg: number | null;
};

/**
 * The lot's sacks (20261114090000_green_lot_labels): «15 كيس × 69 كغ». A whole number of sacks 1–999 and a sack weight
 * above 0 and at most 1000 kg (only with a count), or neither; anything else is refused with a reason (the database
 * CHECK says the same). Empty / missing means "not recorded".
 */
export function sackFields(raw: Record<string, unknown>): { sackCount: number | null; sackWeightKg: number | null } | { error: string; errorEn: string } {
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(typeof v === "string" ? v.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))) : v));
  const count = num(raw.sackCount), weight = num(raw.sackWeightKg);
  if (count !== null && !(Number.isInteger(count) && count >= 1 && count <= 999)) return { error: "عدد الأكياس عدد صحيح من 1 إلى 999.", errorEn: "The sack count is a whole number from 1 to 999." };
  if (weight !== null && !(Number.isFinite(weight) && weight > 0 && weight <= 1000)) return { error: "وزن الكيس أكبر من صفر وحتى 1000 كغ.", errorEn: "The sack weight is above 0 and at most 1000 kg." };
  if (weight !== null && count === null) return { error: "أدخل عدد الأكياس مع وزن الكيس.", errorEn: "Enter the sack count with the sack weight." };
  return { sackCount: count, sackWeightKg: weight === null ? null : Math.round(weight * 1000) / 1000 };
}

/** The lot's fields (without its quantity) from the form's body; the serial is generated when left empty. */
export function greenLotFields(raw: Record<string, unknown>): GreenLotFields {
  // A malformed sack entry is dropped here (the form validates it before saving); the database CHECK holds the rule.
  const sacks = sackFields(raw);
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
    sackCount: "error" in sacks ? null : sacks.sackCount,
    sackWeightKg: "error" in sacks ? null : sacks.sackWeightKg,
  };
}

/**
 * A soft warning (never a refusal — council LOW): the sacks recorded do not add up to the lot's quantity — more than one
 * sack apart («15 كيس × 60 كغ = 900 كغ» against 1,000 kg). Null when sacks are unknown or they agree.
 */
export function sackMismatch(sackCount: number | null | undefined, sackWeightKg: number | null | undefined, quantityKg: number): { ar: string; en: string; sacksKg: number } | null {
  if (!sackCount || !sackWeightKg || !(quantityKg > 0)) return null;
  const sacksKg = Math.round(sackCount * sackWeightKg * 1000) / 1000;
  if (Math.abs(sacksKg - quantityKg) <= sackWeightKg + 1e-9) return null;
  return {
    sacksKg,
    ar: `تنبيه: ${sackCount} كيس × ${sackWeightKg} كغ = ${sacksKg} كغ، وكمية اللوت ${quantityKg} كغ. راجع عدد الأكياس أو وزنها (حُفظ كما أدخلت).`,
    en: `Note: ${sackCount} sacks × ${sackWeightKg} kg = ${sacksKg} kg, and the lot holds ${quantityKg} kg. Check the sack count or weight (saved as entered).`,
  };
}
