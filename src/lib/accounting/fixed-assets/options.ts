// «الأصول الثابتة» — what the forms choose from (read-only).
import { prisma } from "@/lib/db";
import { sodPolicy } from "../sod";

/** Control kinds an asset is never paid from / its proceeds never go to (common.ts checkCounterAccount refuses them). */
const EXCLUDED = ["AR", "AP", "INVENTORY", "VAT_INPUT", "VAT_OUTPUT", "FIXED_ASSET", "PAYROLL", "COMMISSION", "CLEARING"];

export async function faFormOptions() {
  const [categories, branches, suppliers, employees, accounts, roles, settings, slotAccounts] = await Promise.all([
    prisma.fixedAssetCategory.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }], select: { id: true, code: true, nameAr: true, nameEn: true, usefulLifeMonths: true, method: true, residualPercent: true, decliningRatePercent: true, zakatDeductible: true, isLeasehold: true } }),
    prisma.finBranch.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true } }),
    prisma.supplier.findMany({ orderBy: { name: "asc" }, take: 500, select: { id: true, name: true } }),
    prisma.hrEmployee.findMany({ where: { status: { not: "SEPARATED" } }, orderBy: { fullNameAr: "asc" }, take: 500, select: { id: true, fullNameAr: true, fullNameEn: true, employeeNo: true } }).catch(() => []),
    prisma.account.findMany({ where: { isActive: true, allowPosting: true, children: { none: {} }, type: { in: ["ASSET", "LIABILITY", "EQUITY"] }, OR: [{ controlType: null }, { controlType: { notIn: EXCLUDED } }] }, orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true, type: true, controlType: true, roles: { select: { role: true } } } }),
    prisma.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: ["BANK", "CASH"] } }, select: { role: true, accountId: true } }),
    prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true, goLiveDate: true, openingEntryId: true } }),
    // A category's own accounts (blank = the FA role): asset accounts for cost / accumulated, expense for depreciation, either for gain / loss.
    prisma.account.findMany({ where: { isActive: true, allowPosting: true, children: { none: {} }, type: { in: ["ASSET", "EXPENSE", "REVENUE"] } }, orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true, type: true, controlType: true } }),
  ]);
  const sod = await sodPolicy();
  const fa = new Set(["FA_COST", "FA_ACCUMULATED_DEPRECIATION", "FA_DEPRECIATION_EXPENSE", "FA_DISPOSAL_GAIN_LOSS"]);
  const usable = accounts.filter((a) => !a.roles.some((r) => fa.has(r.role)));
  const view = (a: (typeof usable)[number]) => ({ id: a.id, code: a.code, name: a.nameAr ?? a.nameEn, type: String(a.type), controlType: a.controlType });
  return {
    categories: categories.map((c) => ({ ...c, residualPercent: c.residualPercent.toFixed(2), decliningRatePercent: c.decliningRatePercent ? c.decliningRatePercent.toFixed(4) : null })),
    branches, suppliers, employees,
    counterAccounts: usable.map(view),
    proceedsAccounts: usable.filter((a) => String(a.type) === "ASSET").map(view),
    categoryAccounts: {
      asset: slotAccounts.filter((a) => String(a.type) === "ASSET" && (!a.controlType || a.controlType === "FIXED_ASSET")).map((a) => ({ id: a.id, code: a.code, name: a.nameAr ?? a.nameEn })),
      expense: slotAccounts.filter((a) => String(a.type) === "EXPENSE").map((a) => ({ id: a.id, code: a.code, name: a.nameAr ?? a.nameEn })),
      gainLoss: slotAccounts.filter((a) => String(a.type) !== "ASSET").map((a) => ({ id: a.id, code: a.code, name: a.nameAr ?? a.nameEn })),
    },
    defaults: { bank: roles.find((r) => r.role === "BANK")?.accountId ?? null, cash: roles.find((r) => r.role === "CASH")?.accountId ?? null },
    books: { active: !!settings?.accountingActive, goLiveDate: settings?.goLiveDate ? settings.goLiveDate.toISOString().slice(0, 10) : null, openingPosted: !!settings?.openingEntryId },
    /** The segregation-of-duties setting: may the preparer post their own fixed-asset document (flagged when so)? */
    sod: { selfAllowed: sod.allowSelfApproval },
  };
}
