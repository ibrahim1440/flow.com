import { accountingRoute } from "@/lib/accounting/http";
import { submitInvDoc } from "@/lib/accounting/inventory-service";

export const POST = accountingRoute("inv_doc_create", ({ user, params }) => submitInvDoc(params.id, user.id));
