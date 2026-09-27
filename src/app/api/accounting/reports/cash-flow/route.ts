import { accountingRoute, query } from "@/lib/accounting/http";
import { cashFlowStatement } from "@/lib/accounting/cashflow";
import { range } from "../params";

export const GET = accountingRoute(null, async ({ request }) => cashFlowStatement(range(query(request))));
