import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { requestConfigChange } from "@/lib/hr/services/config-change";

// F2: switching HR accounting on/off is REQUESTED; another policy manager approves it (/api/hr/config-changes).
export const PUT = hrHandler(async ({ actor, request }) => requestConfigChange(actor, "ACCOUNTING_TOGGLE", await readJson(request)), { status: 202 });
