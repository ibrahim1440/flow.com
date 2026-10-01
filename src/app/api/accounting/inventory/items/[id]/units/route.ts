import { accountingRoute, body } from "@/lib/accounting/http";
import { setItemUnit } from "@/lib/accounting/inventory-service";

export const PUT = accountingRoute("inv_master_manage", async ({ user, params, request }) => { const b = await body(request); return setItemUnit(params.id, String(b.unit ?? ""), b.factor, user.id); });
