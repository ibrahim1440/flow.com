import { accountingRoute, body } from "@/lib/accounting/http";
import { updateInventorySettings } from "@/lib/accounting/inventory-service";

// Decision D-1: costing method and supplier price-difference treatment.
export const PATCH = accountingRoute("settings_manage", async ({ user, request }) => updateInventorySettings(await body(request), user.id));
