import { accountingRoute, body } from "@/lib/accounting/http";
import { applyAdvance } from "@/lib/accounting/receivables-service";

export const POST = accountingRoute("ar_receipt_assign", async ({ user, request }) => applyAdvance(await body(request), user.id), 201);
