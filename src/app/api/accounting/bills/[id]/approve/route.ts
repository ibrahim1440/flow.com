import { accountingRoute } from "@/lib/accounting/http";
import { approveBill } from "@/lib/accounting/payables-service";

export const POST = accountingRoute("ap_bill_approve", ({ user, params }) => approveBill(params.id, user.id));
