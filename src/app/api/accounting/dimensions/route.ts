import { prisma } from "@/lib/db";
import { accountingRoute } from "@/lib/accounting/http";

// Branches and cost centres (the Finance masters) for journal lines — read-only here.
export const GET = accountingRoute(null, async () => {
  const [branches, costCenters] = await Promise.all([
    prisma.finBranch.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, nameEn: true, nameAr: true } }),
    prisma.finCostCenter.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, nameEn: true, nameAr: true } }),
  ]);
  return { branches, costCenters };
});
