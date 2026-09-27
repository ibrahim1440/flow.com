import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { previewImport } from "@/lib/finance/server/transactions";

export const POST = financeHandler("txn_enter", async ({ actor, scope, request }) => previewImport(actor, scope, await readJson(request)));
