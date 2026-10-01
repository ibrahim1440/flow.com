import { accountingRoute, body, str } from "@/lib/accounting/http";
import { rejectBill } from "@/lib/accounting/payables-service";

export const POST = accountingRoute("ap_bill_approve", async ({ user, request, params }) => rejectBill(params.id, user.id, str((await body(request)).reason, "reason")!));
