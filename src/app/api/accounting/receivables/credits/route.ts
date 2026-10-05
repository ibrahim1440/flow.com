import { accountingRoute, body } from "@/lib/accounting/http";
import { allocateCredit } from "@/lib/accounting/receivables-service";

export const POST = accountingRoute("ar_receipt_assign", async ({ user, request }) => allocateCredit(await body(request), user.id), 201);
