import { accountingRoute, body } from "@/lib/accounting/http";
import { updateDraftInvDoc, deleteDraftInvDoc } from "@/lib/accounting/inventory-service";
import { invDocDetail } from "@/lib/accounting/inventory-queries";

export const GET = accountingRoute(null, ({ params }) => invDocDetail(params.id));
export const PATCH = accountingRoute("inv_doc_create", async ({ user, params, request }) => updateDraftInvDoc(params.id, await body(request), user.id));
export const DELETE = accountingRoute("inv_doc_create", ({ user, params }) => deleteDraftInvDoc(params.id, user.id));
