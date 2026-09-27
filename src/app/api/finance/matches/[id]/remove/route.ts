import { financeHandler } from "@/lib/finance/server/http";
import { readJson, reqStr } from "@/lib/finance/server/context";
import { removeMatch } from "@/lib/finance/server/transactions";

export const POST = financeHandler("txn_enter", async ({ actor, scope, request, params }) => removeMatch(actor, scope, params.id, reqStr((await readJson(request)).reason, "Reason", 500)));
