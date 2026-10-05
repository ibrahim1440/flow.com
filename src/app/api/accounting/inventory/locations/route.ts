import { prisma } from "@/lib/db";
import { accountingRoute, body } from "@/lib/accounting/http";
import { createLocation } from "@/lib/accounting/inventory-service";

export const GET = accountingRoute(null, () => prisma.invLocation.findMany({ orderBy: { code: "asc" } }));
export const POST = accountingRoute("inv_master_manage", async ({ user, request }) => createLocation(await body(request), user.id), 201);
