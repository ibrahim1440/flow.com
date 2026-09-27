import { accountingRoute, query, str } from "@/lib/accounting/http";
import { supplierStatement } from "@/lib/accounting/stage2-service";
import { range } from "../params";

export const GET = accountingRoute(null, async ({ request }) => {
  const q = query(request);
  const { from, to } = range(q);
  return supplierStatement(str(q.get("supplierId"), "supplierId")!, from, to);
});
