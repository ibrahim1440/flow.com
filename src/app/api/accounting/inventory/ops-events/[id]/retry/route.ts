import { accountingRoute } from "@/lib/accounting/http";
import { retryOpsEvent } from "@/lib/accounting/ops-integration";

export const POST = accountingRoute("events_process", ({ user, params }) => retryOpsEvent(params.id, user.id));
