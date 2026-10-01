import { accountingRoute } from "@/lib/accounting/http";
import { cancelYearEnd } from "@/lib/accounting/year-end-service";

export const POST = accountingRoute("year_close_prepare", async ({ user, params }) => cancelYearEnd(params.id, user.id));
