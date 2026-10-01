import { accountingRoute } from "@/lib/accounting/http";
import { approveLossBand } from "@/lib/accounting/inventory-service";

export const POST = accountingRoute("inv_doc_approve", ({ user, params }) => approveLossBand(params.id, user.id));
