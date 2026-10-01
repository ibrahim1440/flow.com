import { accountingRoute, body } from "@/lib/accounting/http";
import { ignoreOpsEvent } from "@/lib/accounting/ops-integration";

export const POST = accountingRoute("inv_doc_approve", async ({ user, params, request }) => ignoreOpsEvent(params.id, user.id, String((await body(request)).reason ?? "")));
