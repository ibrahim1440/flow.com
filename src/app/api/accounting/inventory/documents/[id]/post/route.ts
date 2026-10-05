import { accountingRoute } from "@/lib/accounting/http";
import { postInvDoc } from "@/lib/accounting/inventory-service";

export const POST = accountingRoute("inv_doc_post", ({ user, params }) => postInvDoc(params.id, user.id));
