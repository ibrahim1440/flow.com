import { accountingRoute, body, str } from "@/lib/accounting/http";
import { reverseBill } from "@/lib/accounting/payables-service";

export const POST = accountingRoute("ap_bill_post", async ({ user, request, params }) => reverseBill(params.id, user.id, str((await body(request)).reason, "reason")!));
