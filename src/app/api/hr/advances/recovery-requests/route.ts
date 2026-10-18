import { hrHandler } from "@/lib/hr/http";
import { listRecoveryRequests } from "@/lib/hr/services/advance-recovery";

export const GET = hrHandler(async ({ actor, query }) => listRecoveryRequests(actor, { status: query.get("status") }));
