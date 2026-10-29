// «بيع أصل ثابت» (BATCH 22 WP-F) — the default tax of a line selling a fixed asset (refinement 3): S 15 % as usual; land
// and buildings are an exempt real-estate supply (E, VATEX-SA-30) subject to RETT, which is outside this system — the
// screen shows a RETT reminder. Matched on the asset category's code or names. Pure.
const REAL_ESTATE = /LAND|BUILDING|REAL_ESTATE|أراض|أرض|مبان|مبنى|عقار/i;

export type AssetSaleTax = { taxCategory: "S" | "E"; taxRatePercent: string; exemptionReasonCode: string | null; rett: boolean };

export function assetSaleTax(category: { code: string; nameAr?: string | null; nameEn?: string | null }): AssetSaleTax {
  return REAL_ESTATE.test(`${category.code} ${category.nameAr ?? ""} ${category.nameEn ?? ""}`)
    ? { taxCategory: "E", taxRatePercent: "0", exemptionReasonCode: "VATEX-SA-30", rett: true }
    : { taxCategory: "S", taxRatePercent: "15", exemptionReasonCode: null, rett: false };
}
