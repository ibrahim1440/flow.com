import { accountingRoute, query } from "@/lib/accounting/http";
import { balanceSheet } from "@/lib/accounting/reports";
import { range } from "../params";

export const GET = accountingRoute(null, ({ request }) => {
  const r = range(query(request));
  return balanceSheet({ asOf: r.to, includeProvisional: r.includeProvisional });
});
