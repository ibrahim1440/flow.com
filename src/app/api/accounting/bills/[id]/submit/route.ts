import { accountingRoute } from "@/lib/accounting/http";
import { submitBill } from "@/lib/accounting/payables-service";

export const POST = accountingRoute("ap_bill_create", ({ user, params }) => submitBill(params.id, user.id));
