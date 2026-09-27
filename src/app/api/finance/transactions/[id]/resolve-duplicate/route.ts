import { financeHandler } from "@/lib/finance/server/http";
import { readJson, reqStr } from "@/lib/finance/server/context";
import { resolveDuplicate } from "@/lib/finance/server/transactions";

export const POST = financeHandler("txn_enter", async ({ actor, scope, request, params }) => resolveDuplicate(actor, scope, params.id, reqStr((await readJson(request)).keepId, "Recorded line", 40)));
