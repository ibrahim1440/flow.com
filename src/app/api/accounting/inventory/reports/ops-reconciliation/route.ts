import { accountingRoute } from "@/lib/accounting/http";
import { opsReconciliation } from "@/lib/accounting/ops-integration";

// Operational quantities against the accounts per linked item: detects exceptions, re-enters nothing.
export const GET = accountingRoute(null, () => opsReconciliation());
