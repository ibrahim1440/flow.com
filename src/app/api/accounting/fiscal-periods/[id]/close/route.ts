import { accountingRoute } from "@/lib/accounting/http";
import { closeFiscalPeriod } from "@/lib/accounting/fiscal-period-service";

const handler = accountingRoute("period_close", ({ user, params }) => closeFiscalPeriod(params.id, user.id));
export const POST = handler;
export const PATCH = handler;
