import { accountingRoute, body } from "@/lib/accounting/http";
import { receiptDraftFromPurchase } from "@/lib/accounting/inventory-service";

export const POST = accountingRoute("inv_doc_create", async ({ user, params, request }) => receiptDraftFromPurchase(params.purchaseId, await body(request), user.id), 201);
