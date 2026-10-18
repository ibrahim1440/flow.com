import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { requestConfigChange } from "@/lib/hr/services/config-change";

// P-2: a payroll control attestation is REQUESTED; another policy manager approves it, attesting
// (POST /api/hr/config-changes/[id]/decide with expected + attested: true). Nothing is applied here.
export const POST = hrHandler(async ({ actor, request }) => requestConfigChange(actor, "PAYROLL_CONTROL_ATTEST", await readJson(request)), { status: 202 });
