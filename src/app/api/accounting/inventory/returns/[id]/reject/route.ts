import { accountingRoute, body } from "@/lib/accounting/http";
import { rejectCustomerReturn } from "@/lib/accounting/customer-returns";

export const POST = accountingRoute("inv_doc_approve", async ({ user, params, request }) => rejectCustomerReturn(params.id, user.id, String((await body(request)).reason ?? "")));
