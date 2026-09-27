import { financeHandler } from "@/lib/finance/server/http";
import { prisma } from "@/lib/db";
import { collectionSuggestion, linkSalesCollection } from "@/lib/finance/server/transactions";
import { readJson, reqStr } from "@/lib/finance/server/context";

/** The Sales collection linked to this receipt, or the suggested one (nothing is linked by a GET). */
export const GET = financeHandler(undefined, ({ scope, params }) => collectionSuggestion(prisma, scope, params.id));

export const POST = financeHandler("txn_enter", async ({ actor, scope, request, params }) => linkSalesCollection(actor, scope, params.id, reqStr((await readJson(request)).collectionId, "Collection", 40)), 201);
