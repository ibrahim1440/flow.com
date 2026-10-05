import { accountingRoute, body } from "@/lib/accounting/http";
import { cancelAsset } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_approve", async ({ user, params, request }) => cancelAsset(params.id, user.id, (await body(request)).reason));
