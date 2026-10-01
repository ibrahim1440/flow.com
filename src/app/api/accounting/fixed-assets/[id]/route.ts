import { accountingRoute, body } from "@/lib/accounting/http";
import { saveAsset } from "@/lib/accounting/fixed-assets-service";
import { assetDetail } from "@/lib/accounting/fixed-assets-queries";

export const GET = accountingRoute(null, async ({ params }) => assetDetail(params.id));
/** Edit a draft asset. */
export const PATCH = accountingRoute("fa_prepare", async ({ user, params, request }) => saveAsset(await body(request), user.id, params.id));
