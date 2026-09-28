import { accountingRoute, body } from "@/lib/accounting/http";
import { assignReceipt } from "@/lib/accounting/receivables-service";

export const PUT = accountingRoute("ar_receipt_assign", async ({ user, params, request }) => assignReceipt(params.id, await body(request), user.id));
