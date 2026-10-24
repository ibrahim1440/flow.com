import { NextResponse } from "@/lib/api-response";
import { requirePrivilegedAction, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { seedChart } from "@/lib/accounting/setup";
import { auditFromRequest } from "@/lib/accounting/audit";

/**
 * «تهيئة دليل الحسابات»: the default chart (roastery + café, KSA) into an EMPTY chart, with its role mapping.
 * Opt-in only (never automatic). `{ dryRun: true }` previews. Chart duty, verified individual, step-up.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "coa_manage");
  if (error) return error;
  try {
    const body = await jsonBody(request);
    if (body.dryRun === true) return NextResponse.json(await seedChart({ actorId: user.id }, { dryRun: true }));
    const refused = await requirePrivilegedAction(user, "accounting.coa_seed", { stepUp: true });
    if (refused) return refused;
    return NextResponse.json(await seedChart(auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
