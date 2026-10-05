import { accountingRoute } from "@/lib/accounting/http";
import { approveCostPool } from "@/lib/accounting/conversion-costs";

export const POST = accountingRoute("inv_doc_approve", ({ user, params }) => approveCostPool(params.id, user.id));
