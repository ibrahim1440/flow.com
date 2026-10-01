import { accountingRoute, query } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { customerStatement } from "@/lib/accounting/receivables-reports";
import { range } from "../params";

export const GET = accountingRoute(null, ({ request }) => {
  const q = query(request);
  const id = q.get("customerId");
  if (!id) throw new AccountingError("Choose a customer.", 400);
  const { from, to } = range(q);
  return customerStatement(id, from, to);
});
