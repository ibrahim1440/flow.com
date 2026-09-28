import { accountingRoute, body } from "@/lib/accounting/http";
import { rejectInvDoc } from "@/lib/accounting/inventory-service";

export const POST = accountingRoute("inv_doc_approve", async ({ user, params, request }) => rejectInvDoc(params.id, user.id, String((await body(request)).reason ?? "")));
