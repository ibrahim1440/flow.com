import { accountingRoute, body, query } from "@/lib/accounting/http";
import { createCustomerReturn, listCustomerReturns, returnableLines } from "@/lib/accounting/customer-returns";

export const GET = accountingRoute(null, ({ request }) => { const q = query(request); return q.get("returnableFor") ? returnableLines(q.get("returnableFor")!) : listCustomerReturns({ status: q.get("status"), invoiceId: q.get("invoiceId") }); });
export const POST = accountingRoute("inv_doc_create", async ({ user, request }) => createCustomerReturn(await body(request), user.id), 201);
