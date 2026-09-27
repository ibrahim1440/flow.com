import { accountingRoute, body, str } from "@/lib/accounting/http";
import { listPolicies, draftPolicy } from "@/lib/accounting/policy-service";

export const GET = accountingRoute(null, () => listPolicies());

export const POST = accountingRoute("policy_prepare", async ({ user, request }) => {
  const b = await body(request);
  return draftPolicy(str(b.key, "key")!, { statement: str(b.statement, "statement", { optional: true }) }, user.id);
}, 201);
