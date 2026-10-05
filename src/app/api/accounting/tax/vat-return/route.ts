import { accountingRoute, query } from "@/lib/accounting/http";
import { accountingDate } from "@/lib/accounting/dates";
import { vatReturn } from "@/lib/accounting/einvoice/vat-return";

// VAT return for ?from=&to= (a report for review; nothing is filed from the system).
export const GET = accountingRoute(null, async ({ request }) => { const q = query(request); return vatReturn(accountingDate(q.get("from")), accountingDate(q.get("to"))); });
