import { accountingRoute, body } from "@/lib/accounting/http";
import { decideYearReopen } from "@/lib/accounting/year-end-service";

export const POST = accountingRoute("year_close_approve", async ({ user, params, request }) => decideYearReopen(params.id, user.id, (await body(request)).approve === true));
