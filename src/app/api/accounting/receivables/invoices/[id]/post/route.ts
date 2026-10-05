import { accountingRoute } from "@/lib/accounting/http";
import { postSalesDoc } from "@/lib/accounting/receivables-service";

export const POST = accountingRoute("ar_invoice_post", ({ user, params }) => postSalesDoc(params.id, user.id));
