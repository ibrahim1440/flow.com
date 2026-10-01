import { accountingRoute, body } from "@/lib/accounting/http";
import { requestYearReopen } from "@/lib/accounting/year-end-service";

export const POST = accountingRoute("year_close_prepare", async ({ user, params, request }) => requestYearReopen(params.id, user.id, (await body(request)).reason));
