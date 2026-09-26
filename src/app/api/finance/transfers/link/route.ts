import { financeHandler } from "@/lib/finance/server/http";
import { readJson, reqStr } from "@/lib/finance/server/context";
import { linkTransfer } from "@/lib/finance/server/transactions";

export const POST = financeHandler("txn_enter", async ({ actor, scope, request }) => { const b = await readJson(request); return linkTransfer(actor, scope, reqStr(b.idA, "First line", 40), reqStr(b.idB, "Second line", 40)); });
