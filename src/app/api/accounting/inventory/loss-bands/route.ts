import { accountingRoute, body } from "@/lib/accounting/http";
import { createLossBand } from "@/lib/accounting/inventory-service";

export const POST = accountingRoute("inv_master_manage", async ({ user, request }) => createLossBand(await body(request), user.id), 201);
