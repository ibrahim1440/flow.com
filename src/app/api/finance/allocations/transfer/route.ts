import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { requestCategoryTransfer } from "@/lib/finance/server/allocation";

export const POST = financeHandler("allocate", async ({ actor, scope, request }) => requestCategoryTransfer(actor, scope, await readJson(request)), 201);
