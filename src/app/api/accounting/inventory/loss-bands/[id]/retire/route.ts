import { accountingRoute } from "@/lib/accounting/http";
import { retireLossBand } from "@/lib/accounting/inventory-service";

export const POST = accountingRoute("inv_doc_approve", ({ user, params }) => retireLossBand(params.id, user.id));
