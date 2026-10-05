import { accountingRoute } from "@/lib/accounting/http";
import { applyChartTemplate } from "@/lib/accounting/setup-service";

// Loads the template chart into an EMPTY chart only (refused otherwise).
export const POST = accountingRoute("coa_manage", ({ user }) => applyChartTemplate(user.id), 201);
