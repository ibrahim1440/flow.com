import { accountingRoute, query } from "@/lib/accounting/http";
import { generalLedger } from "@/lib/accounting/reports";
import { AccountingError } from "@/lib/accounting/errors";
import { range } from "../params";

export const GET = accountingRoute(null, async ({ request }) => {
  const q = query(request);
  const accountId = q.get("accountId");
  if (!accountId) throw new AccountingError("accountId is required.", 400);
  const r = await generalLedger({ ...range(q), accountId, page: Number(q.get("page")) || 1, pageSize: Number(q.get("pageSize")) || 100 });
  if (!r) throw new AccountingError("Account not found.", 404);
  return r;
});
