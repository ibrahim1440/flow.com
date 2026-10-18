import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { requestConfigChange } from "@/lib/hr/services/config-change";

// F2: an account-map change is REQUESTED; another policy manager approves it (/api/hr/config-changes).
export const POST = hrHandler(async ({ actor, request }) => requestConfigChange(actor, "ACCOUNT_MAP_SET", await readJson(request)), { status: 202 });
