import { accountingRoute } from "@/lib/accounting/http";
import { discardProfile } from "@/lib/accounting/einvoice/service";

export const POST = accountingRoute("einv_profile_prepare", async ({ user, params }) => discardProfile(params.id, user.id));
