import { accountingRoute, body } from "@/lib/accounting/http";
import { returnAsset } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_approve", async ({ user, params, request }) => returnAsset(params.id, user.id, (await body(request)).reason));
