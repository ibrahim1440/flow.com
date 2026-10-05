import { accountingRoute } from "@/lib/accounting/http";
import { releaseSupplierCredit } from "@/lib/accounting/payables-service";

export const POST = accountingRoute("ap_bill_post", ({ user, params }) => releaseSupplierCredit(params.id, user.id));
