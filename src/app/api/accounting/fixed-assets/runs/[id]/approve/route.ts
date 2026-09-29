import { accountingRoute } from "@/lib/accounting/http";
import { approveRun } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_approve", async ({ user, params }) => approveRun(params.id, user.id));
