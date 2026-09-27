import { accountingRoute } from "@/lib/accounting/http";
import { postBill } from "@/lib/accounting/payables-service";

export const POST = accountingRoute("ap_bill_post", ({ user, params }) => postBill(params.id, user.id));
