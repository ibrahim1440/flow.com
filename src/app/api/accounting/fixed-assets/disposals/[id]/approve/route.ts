import { accountingRoute } from "@/lib/accounting/http";
import { approveDisposal } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_approve", async ({ user, params }) => approveDisposal(params.id, user.id));
