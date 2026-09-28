import { accountingRoute, body, query } from "@/lib/accounting/http";
import { absorptionReport } from "@/lib/accounting/conversion-costs";
import { accountingDate } from "@/lib/accounting/dates";

export const GET = accountingRoute(null, ({ request }) => { const q = query(request); return absorptionReport(accountingDate(q.get("from")), accountingDate(q.get("to"))); });
