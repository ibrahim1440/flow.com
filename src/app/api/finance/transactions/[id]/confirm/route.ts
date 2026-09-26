import { financeHandler } from "@/lib/finance/server/http";
import { confirmPending } from "@/lib/finance/server/transactions";

export const POST = financeHandler("txn_enter", ({ actor, scope, params }) => confirmPending(actor, scope, params.id));
