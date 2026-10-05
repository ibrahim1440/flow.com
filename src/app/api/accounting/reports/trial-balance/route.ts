import { accountingRoute, query } from "@/lib/accounting/http";
import { trialBalance } from "@/lib/accounting/reports";
import { range } from "../params";

export const GET = accountingRoute(null, ({ request }) => trialBalance(range(query(request))));
