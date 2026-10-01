import { accountingRoute } from "@/lib/accounting/http";
import { approveCustomerReturn } from "@/lib/accounting/customer-returns";

export const POST = accountingRoute("inv_doc_approve", ({ user, params }) => approveCustomerReturn(params.id, user.id));
