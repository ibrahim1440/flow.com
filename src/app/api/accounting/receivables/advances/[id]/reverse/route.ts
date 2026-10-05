import { accountingRoute, body } from "@/lib/accounting/http";
import { reverseAdvanceApplication } from "@/lib/accounting/receivables-service";

export const POST = accountingRoute("ar_receipt_assign", async ({ user, params, request }) => reverseAdvanceApplication(params.id, user.id, String((await body(request)).reason ?? "")));
