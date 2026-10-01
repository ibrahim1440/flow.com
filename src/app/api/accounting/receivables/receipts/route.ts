import { accountingRoute } from "@/lib/accounting/http";
import { receiptsQueue } from "@/lib/accounting/receivables-reports";

export const GET = accountingRoute(null, () => receiptsQueue());
