import { accountingRoute, body } from "@/lib/accounting/http";
import { reverseSalesDoc } from "@/lib/accounting/receivables-service";

export const POST = accountingRoute("ar_invoice_post", async ({ user, params, request }) => reverseSalesDoc(params.id, user.id, String((await body(request)).reason ?? "")));
