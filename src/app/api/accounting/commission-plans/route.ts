import { accountingRoute } from "@/lib/accounting/http";
import { listCommissionPlanVersions } from "@/lib/accounting/policy-service";

export const GET = accountingRoute(null, () => listCommissionPlanVersions());
