import { accountingRoute, body, str } from "@/lib/accounting/http";
import { unlockFiscalPeriod } from "@/lib/accounting/fiscal-period-service";

export const POST = accountingRoute("unlock_period", async ({ user, request, params }) => {
  const b = await body(request);
  return unlockFiscalPeriod(params.id, user.id, str(b.reason, "reason")!);
});
