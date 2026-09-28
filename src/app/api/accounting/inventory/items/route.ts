import { accountingRoute, body } from "@/lib/accounting/http";
import { createItem } from "@/lib/accounting/inventory-service";
import { inventoryMasters } from "@/lib/accounting/inventory-queries";

export const GET = accountingRoute(null, () => inventoryMasters());
export const POST = accountingRoute("inv_master_manage", async ({ user, request }) => createItem(await body(request), user.id), 201);
