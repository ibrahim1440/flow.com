import { financeHandler } from "@/lib/finance/server/http";
import { readJson } from "@/lib/finance/server/context";
import { decideApproval } from "@/lib/finance/server/approvals";

export const POST = financeHandler(undefined, async ({ actor, scope, request, params }) => decideApproval(actor, scope, params.id, await readJson(request)));
