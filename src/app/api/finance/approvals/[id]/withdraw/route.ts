import { financeHandler } from "@/lib/finance/server/http";
import { cancelApproval } from "@/lib/finance/server/approvals";

export const POST = financeHandler(undefined, ({ actor, params }) => cancelApproval(actor, params.id));
