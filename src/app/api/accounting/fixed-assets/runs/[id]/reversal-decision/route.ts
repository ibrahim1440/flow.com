import { accountingRoute, body } from "@/lib/accounting/http";
import { decideRunReversal } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_approve", async ({ user, params, request }) => decideRunReversal(params.id, user.id, (await body(request)).approve === true));
