import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { requestConfigChange } from "@/lib/hr/services/config-change";

// P-2 / E-1: confirming a leave type that is still a proposal is REQUESTED; another policy manager
// approves it (/api/hr/config-changes). Until then it is a proposal and payroll refuses to use it.
export const POST = hrHandler(async ({ actor, request, params }) => requestConfigChange(actor, "LEAVE_TYPE_CONFIRM", { ...(await readJson(request)), leaveTypeId: params.id }), { status: 202 });
