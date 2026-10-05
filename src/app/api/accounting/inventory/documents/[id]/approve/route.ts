import { accountingRoute } from "@/lib/accounting/http";
import { approveInvDoc } from "@/lib/accounting/inventory-service";

export const POST = accountingRoute("inv_doc_approve", ({ user, params }) => approveInvDoc(params.id, user.id));
