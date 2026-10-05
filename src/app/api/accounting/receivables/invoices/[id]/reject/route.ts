import { accountingRoute, body } from "@/lib/accounting/http";
import { rejectSalesDoc } from "@/lib/accounting/receivables-service";

export const POST = accountingRoute("ar_invoice_approve", async ({ user, params, request }) => rejectSalesDoc(params.id, user.id, String((await body(request)).reason ?? "")));
