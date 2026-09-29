import { accountingRoute, body } from "@/lib/accounting/http";
import { linkItem } from "@/lib/accounting/inventory-service";

// Link an unlinked item to its operational record (green coffee, roasted product, material, SKU).
export const POST = accountingRoute("inv_master_manage", async ({ user, params, request }) => linkItem(params.id, await body(request), user.id));
