import { accountingRoute } from "@/lib/accounting/http";
import { approvePolicy } from "@/lib/accounting/policy-service";

export const POST = accountingRoute("policy_approve", ({ user, params }) => approvePolicy(params.id, user.id));
