import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { listLeaveTypes } from "@/lib/hr/services/leave";
import { requestConfigChange } from "@/lib/hr/services/config-change";

export const GET = hrHandler(async ({  }) => listLeaveTypes());
// F2: a new leave type is REQUESTED; another policy manager approves it (/api/hr/config-changes).
export const POST = hrHandler(async ({ actor, request }) => requestConfigChange(actor, "LEAVE_TYPE_CREATE", await readJson(request)), { status: 202 });
