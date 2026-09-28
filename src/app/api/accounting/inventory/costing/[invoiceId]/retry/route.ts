import { accountingRoute } from "@/lib/accounting/http";
import { retryCosting } from "@/lib/accounting/sales-costing";

export const POST = accountingRoute("events_process", ({ user, params }) => retryCosting(params.invoiceId, user.id));
