import { accountingRoute } from "@/lib/accounting/http";
import { discardRun } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_prepare", async ({ user, params }) => discardRun(params.id, user.id));
