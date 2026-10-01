import { accountingRoute, body } from "@/lib/accounting/http";
import { updateSupplierTaxData } from "@/lib/accounting/payables-service";

export const PATCH = accountingRoute("ap_bill_create", async ({ user, request, params }) => updateSupplierTaxData(params.id, await body(request), user.id));
