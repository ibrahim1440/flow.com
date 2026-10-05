import { accountingRoute, body, str } from "@/lib/accounting/http";
import { listMappings, setMapping } from "@/lib/accounting/setup-service";

export const GET = accountingRoute(null, () => listMappings());

export const PUT = accountingRoute("mapping_manage", async ({ user, request }) => {
  const b = await body(request);
  return setMapping(str(b.role, "role")!, str(b.accountId, "accountId")!, user.id);
});
