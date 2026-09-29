import { accountingRoute, query } from "@/lib/accounting/http";
import { faPickers } from "@/lib/accounting/fixed-assets-queries";

/** bill-lines (posted, on asset accounts, not yet funding an asset), accounts, periods, branches, years. */
export const GET = accountingRoute(null, async ({ request }) => faPickers(query(request).get("what")));
