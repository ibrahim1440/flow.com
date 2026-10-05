import { accountingRoute } from "@/lib/accounting/http";
import { discardDisposal } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_prepare", async ({ user, params }) => discardDisposal(params.id, user.id));
