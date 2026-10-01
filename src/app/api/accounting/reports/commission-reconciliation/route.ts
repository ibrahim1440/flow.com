import { accountingRoute } from "@/lib/accounting/http";
import { commissionReconciliation } from "@/lib/accounting/reports";

export const GET = accountingRoute(null, () => commissionReconciliation());
