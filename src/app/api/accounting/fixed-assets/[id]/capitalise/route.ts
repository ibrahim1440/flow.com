import { accountingRoute } from "@/lib/accounting/http";
import { capitaliseAsset } from "@/lib/accounting/fixed-assets-service";

// Approve and capitalise (not one's own asset).
export const POST = accountingRoute("fa_approve", async ({ user, params }) => capitaliseAsset(params.id, user.id));
