import { accountingRoute, query } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { stockCard } from "@/lib/accounting/inventory-reports";
import { range } from "../../../reports/params";

export const GET = accountingRoute(null, ({ request }) => {
  const q = query(request); const id = q.get("itemId");
  if (!id) throw new AccountingError("Choose an item.", 400);
  const { from, to } = range(q);
  return stockCard(id, from, to, q.get("locationId"));
});
