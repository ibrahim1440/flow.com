import { accountingRoute } from "@/lib/accounting/http";
import { submitSalesDoc } from "@/lib/accounting/receivables-service";

export const POST = accountingRoute("ar_invoice_create", ({ user, params }) => submitSalesDoc(params.id, user.id));
