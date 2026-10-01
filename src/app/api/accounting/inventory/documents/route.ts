import { accountingRoute, body, query } from "@/lib/accounting/http";
import { createInvDoc } from "@/lib/accounting/inventory-service";
import { listInvDocs } from "@/lib/accounting/inventory-queries";
import { AccountingError } from "@/lib/accounting/errors";

export const GET = accountingRoute(null, ({ request }) => listInvDocs(query(request)));
export const POST = accountingRoute("inv_doc_create", async ({ user, request }) => {
  const b = await body(request);
  if (b.type === "SALE_ISSUE") throw new AccountingError("Cost of sales is created by posting the sales invoice.", 400);
  return createInvDoc({ ...b, sourceType: undefined, sourceId: undefined }, user.id);
}, 201);
