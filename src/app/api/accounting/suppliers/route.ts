import { prisma } from "@/lib/db";
import { accountingRoute } from "@/lib/accounting/http";

export const GET = accountingRoute(null, async () =>
  prisma.supplier.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, vatNumber: true, crNumber: true, paymentTermsDays: true, active: true } }));
