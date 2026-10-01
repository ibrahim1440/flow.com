import { accountingRoute, query } from "@/lib/accounting/http";
import { grossMargin } from "@/lib/accounting/inventory-reports";
import { range } from "../../../reports/params";

export const GET = accountingRoute(null, ({ request }) => { const { from, to } = range(query(request)); return grossMargin(from, to); });
