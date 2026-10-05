import { accountingRoute } from "@/lib/accounting/http";
import { discardPolicyDraft } from "@/lib/accounting/policy-service";

export const DELETE = accountingRoute("policy_prepare", ({ user, params }) => discardPolicyDraft(params.id, user.id));
