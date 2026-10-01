import { accountingRoute, query } from "@/lib/accounting/http";
import { incomeStatement } from "@/lib/accounting/reports";
import { range } from "../params";

export const GET = accountingRoute(null, ({ request }) => incomeStatement(range(query(request))));
