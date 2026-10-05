import { accountingRoute } from "@/lib/accounting/http";
import { approveSalesDoc } from "@/lib/accounting/receivables-service";

export const POST = accountingRoute("ar_invoice_approve", ({ user, params }) => approveSalesDoc(params.id, user.id));
