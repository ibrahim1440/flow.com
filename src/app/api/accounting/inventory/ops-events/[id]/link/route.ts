import { accountingRoute, body } from "@/lib/accounting/http";
import { linkOpsEvent } from "@/lib/accounting/ops-integration";

export const POST = accountingRoute("inv_doc_approve", async ({ user, params, request }) => { const b = await body(request); return linkOpsEvent(params.id, String(b.documentId ?? ""), user.id, String(b.reason ?? "")); });
