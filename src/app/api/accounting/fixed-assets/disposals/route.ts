import { accountingRoute, body } from "@/lib/accounting/http";
import { createDisposal } from "@/lib/accounting/fixed-assets-service";

export const POST = accountingRoute("fa_prepare", async ({ user, request }) => createDisposal(await body(request), user.id), 201);
