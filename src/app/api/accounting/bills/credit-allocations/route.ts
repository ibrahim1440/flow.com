import { accountingRoute, body } from "@/lib/accounting/http";
import { allocateSupplierCredit } from "@/lib/accounting/payables-service";

// Apply a posted supplier credit note to an open bill of the same supplier.
export const POST = accountingRoute("ap_bill_post", async ({ user, request }) => allocateSupplierCredit(await body(request), user.id), 201);
