import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { requestConfigChange } from "@/lib/hr/services/config-change";
import { isPayrollLive } from "@/lib/hr/payroll-lock";

// Phase 1 payroll lock. GET: whether live payroll is on (read on every request; no pay data).
// PUT: REQUEST turning it on / off ({ payrollLive: boolean, reason }); another policy manager (another
// person) approves it (/api/hr/config-changes). Turning it on is refused while the readiness check
// (/api/hr/payroll/readiness) has any finding — at request and again at approval.
export const GET = hrHandler(async () => ({ payrollLive: await isPayrollLive() }));
export const PUT = hrHandler(async ({ actor, request }) => requestConfigChange(actor, "PAYROLL_LIVE_SET", await readJson(request)), { status: 202 });
