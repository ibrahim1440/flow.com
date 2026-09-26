import { financeHandler } from "@/lib/finance/server/http";
import { resolveVarianceNote } from "@/lib/finance/server/budgets";

export const POST = financeHandler("budget_prepare", ({ actor, scope, params }) => resolveVarianceNote(actor, scope, params.id));
