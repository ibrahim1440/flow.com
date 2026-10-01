import { accountingRoute, body } from "@/lib/accounting/http";
import { receiveCustomerReturn } from "@/lib/accounting/customer-returns";

// The warehouse confirms the goods arrived, with its evidence.
export const POST = accountingRoute("inv_return_receive", async ({ user, params, request }) => receiveCustomerReturn(params.id, await body(request), user.id));
