import { accountingRoute, body } from "@/lib/accounting/http";
import { createCostPool, listCostPools } from "@/lib/accounting/conversion-costs";

export const GET = accountingRoute(null, () => listCostPools());
export const POST = accountingRoute("inv_master_manage", async ({ user, request }) => createCostPool(await body(request), user.id), 201);
