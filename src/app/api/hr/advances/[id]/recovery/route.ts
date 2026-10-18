import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { requestRecovery } from "@/lib/hr/services/advance-recovery";

// P-2 finding 2: request a RESCHEDULE or COLLECTION; nothing changes until another person approves.
export const POST = hrHandler(async ({ actor, request, params, today }) => requestRecovery(actor, params.id, await readJson(request), today), { status: 202 });
