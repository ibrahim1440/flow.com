import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { previewReconciliation } from "@/lib/finance/server/reconciliation";

export const POST = financeHandler(undefined, async ({ scope, request }) => { const b = await readJson(request); return previewReconciliation(scope, String(b.cashAccountId ?? ""), String(b.statementDate ?? ""), b.statementBalance); });
