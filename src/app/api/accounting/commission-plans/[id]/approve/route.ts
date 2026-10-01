import { accountingRoute } from "@/lib/accounting/http";
import { approveCommissionPlanVersion } from "@/lib/accounting/policy-service";

// Approves a plan version for LEDGER POSTING only; the sales engine's rates are untouched.
export const POST = accountingRoute("policy_approve", ({ user, params }) => approveCommissionPlanVersion(params.id, user.id));
