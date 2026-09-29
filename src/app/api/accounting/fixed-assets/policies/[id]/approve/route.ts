import { accountingRoute } from "@/lib/accounting/http";
import { approveClassPolicy } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_approve", async ({ user, params }) => approveClassPolicy(params.id, user.id));
