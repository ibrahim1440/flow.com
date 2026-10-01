import { accountingRoute } from "@/lib/accounting/http";
import { submitEInvoice } from "@/lib/accounting/einvoice/service";

// LOCAL_ONLY profiles record that nothing was sent; SANDBOX only to an allowed test target; never production.
export const POST = accountingRoute("einv_submit", async ({ user, params }) => submitEInvoice(params.id, user.id));
