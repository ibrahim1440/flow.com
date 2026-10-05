import { accountingRoute } from "@/lib/accounting/http";
import { submitAsset } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_prepare", async ({ user, params }) => submitAsset(params.id, user.id));
