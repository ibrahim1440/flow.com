import { NextResponse } from "@/lib/api-response";
import { requireModule, requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { getCostingSettings, setAbnormalThreshold } from "@/lib/accounting/ops/valuation";

/** The costing policy: the abnormal roast-loss threshold (% of green; empty = every loss is normal). */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  return NextResponse.json(await getCostingSettings());
}

export async function PUT(request: Request) {
  const { user, error } = await requireSub("accounting", "settings_manage");
  if (error) return error;
  const refused = await requirePrivilegedAction(user, "accounting.costing_settings", { stepUp: true });
  if (refused) return refused;
  try {
    const b = await jsonBody(request);
    return NextResponse.json(await setAbnormalThreshold(b.abnormalRoastLossPct, auditFromRequest(request, user.id, "costing policy"), b.abnormalUseProductLimit));
  } catch (err) {
    return acctError(err);
  }
}
