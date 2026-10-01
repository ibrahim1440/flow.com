import { accountingRoute } from "@/lib/accounting/http";
import { postCustomerReturn } from "@/lib/accounting/customer-returns";

export const POST = accountingRoute("inv_doc_post", ({ user, params }) => postCustomerReturn(params.id, user.id));
