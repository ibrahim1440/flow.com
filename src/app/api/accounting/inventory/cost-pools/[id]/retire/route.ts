import { accountingRoute } from "@/lib/accounting/http";
import { retireCostPool } from "@/lib/accounting/conversion-costs";

export const POST = accountingRoute("inv_doc_approve", ({ user, params }) => retireCostPool(params.id, user.id));
