import { accountingRoute, body } from "@/lib/accounting/http";
import { setCategoryGl } from "@/lib/accounting/stage2-service";

export const PUT = accountingRoute("bank_posting_manage", async ({ user, request, params }) => {
  const b = await body(request);
  return setCategoryGl(params.id, typeof b.accountId === "string" && b.accountId ? b.accountId : null, user.id);
});
