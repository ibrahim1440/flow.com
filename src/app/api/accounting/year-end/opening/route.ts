import { accountingRoute, query } from "@/lib/accounting/http";
import { openingBalancesAfter } from "@/lib/accounting/year-end-service";

// Balances carried into the year after ?year= (every revenue and expense account should be zero once closed).
export const GET = accountingRoute(null, async ({ request }) => openingBalancesAfter(Number(query(request).get("year"))));
