import { route } from "@/lib/marketing/server/http";
import { prisma } from "@/lib/db";
import { dn } from "@/lib/marketing/server/http";

/** Products for the pickers, with their marketing economics. The name is in the viewer's language. */
export const GET = route(undefined, async (_req, { user }) => {
  const en = user.preferredLanguage === "en";
  const rows = await prisma.coffeeProduct.findMany({ where: { isActive: true }, orderBy: { productNameEn: "asc" }, select: { id: true, productNameAr: true, productNameEn: true, mktEconomics: true }, take: 500 });
  return {
    rows: rows.map((p) => ({
      id: p.id, name: en ? p.productNameEn : p.productNameAr ?? p.productNameEn,
      economics: p.mktEconomics ? { avgOrderValue: dn(p.mktEconomics.avgOrderValue), grossMarginPct: p.mktEconomics.grossMarginPct === null ? null : dn(p.mktEconomics.grossMarginPct)! * 100, variableCostPerOrder: dn(p.mktEconomics.variableCostPerOrder), targetCac: dn(p.mktEconomics.targetCac), repurchaseCycleDays: p.mktEconomics.repurchaseCycleDays, vatIncluded: p.mktEconomics.vatIncluded } : null,
    })),
  };
});
