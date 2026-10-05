import { accountingRoute } from "@/lib/accounting/http";
import { approveProfile } from "@/lib/accounting/einvoice/service";

export const POST = accountingRoute("einv_profile_approve", async ({ user, params }) => approveProfile(params.id, user.id));
