import { accountingRoute, body } from "@/lib/accounting/http";
import { requestDisposalReversal } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_prepare", async ({ user, params, request }) => requestDisposalReversal(params.id, user.id, (await body(request)).reason));
