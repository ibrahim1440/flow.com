import { accountingRoute, body } from "@/lib/accounting/http";
import { productionDraftFromRoastingBatch } from "@/lib/accounting/inventory-service";

export const POST = accountingRoute("inv_doc_create", async ({ user, params, request }) => productionDraftFromRoastingBatch(params.batchId, await body(request), user.id), 201);
