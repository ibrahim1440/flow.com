import { accountingRoute, body } from "@/lib/accounting/http";
import { draftClassPolicy } from "@/lib/accounting/fixed-assets-service";

// Prepare a new depreciation policy version for a class (approved by someone else).
export const POST = accountingRoute("fa_setup", async ({ user, params, request }) => draftClassPolicy(params.id, await body(request), user.id), 201);
