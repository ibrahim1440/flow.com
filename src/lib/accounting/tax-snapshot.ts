import type { TaxCategory } from "@/generated/prisma/client";

export type TaxCategorySnapshot = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  rate: string;
  categoryType: string;
  zatcaTaxCategoryCode: string | null;
  snapshotAt: string;
};

// Captured onto JournalEntryLine.taxCategorySnapshot at posting time. Later changes to the
// TaxCategory master must never retroactively change historical lines — this snapshot is why.
export function buildTaxCategorySnapshot(taxCategory: TaxCategory): TaxCategorySnapshot {
  return {
    id: taxCategory.id,
    code: taxCategory.code,
    nameEn: taxCategory.nameEn,
    nameAr: taxCategory.nameAr,
    rate: taxCategory.rate.toString(),
    categoryType: taxCategory.categoryType,
    zatcaTaxCategoryCode: taxCategory.zatcaTaxCategoryCode,
    snapshotAt: new Date().toISOString(),
  };
}
