import { accountingRoute } from "@/lib/accounting/http";
import { lockFiscalPeriod } from "@/lib/accounting/fiscal-period-service";

const handler = accountingRoute("period_lock", ({ user, params }) => lockFiscalPeriod(params.id, user.id));
export const POST = handler;
export const PATCH = handler;
