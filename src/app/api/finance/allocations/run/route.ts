import { financeHandler } from "@/lib/finance/server/http";
import { readJson, reqStr } from "@/lib/finance/server/context";
import { runAllocation } from "@/lib/finance/server/allocation";

export const POST = financeHandler("allocate", async ({ actor, scope, request }) => runAllocation(actor, scope, reqStr((await readJson(request)).txnId, "Receipt", 40)));
