import { accountingRoute } from "@/lib/accounting/http";
import { approveYearEnd } from "@/lib/accounting/year-end-service";

export const POST = accountingRoute("year_close_approve", async ({ user, params }) => approveYearEnd(params.id, user.id));
