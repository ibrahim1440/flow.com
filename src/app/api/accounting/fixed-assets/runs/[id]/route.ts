import { accountingRoute } from "@/lib/accounting/http";
import { runDetail } from "@/lib/accounting/fixed-assets-queries";

export const GET = accountingRoute(null, async ({ params }) => runDetail(params.id));
