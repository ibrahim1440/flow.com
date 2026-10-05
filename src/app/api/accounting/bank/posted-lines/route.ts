import { accountingRoute, query } from "@/lib/accounting/http";
import { postedLinesForCorrection } from "@/lib/accounting/bank-correction-service";

export const GET = accountingRoute(null, ({ request }) => postedLinesForCorrection(query(request).get("q")));
