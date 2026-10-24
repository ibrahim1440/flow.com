import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { renewCsid, requestComplianceCsid, requestProductionCsid, revokeEgs, runComplianceChecks } from "@/lib/zatca/egs";
import { zatcaError } from "@/lib/zatca/refusals";

export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string; step: string }> };

/**
 * POST /api/accounting/zatca/egs/:id/:step — one onboarding step of an EGS unit:
 *   compliance-csid { otp }   the OTP from the Fatoora portal → the compliance CSID (the OTP is used once, never stored)
 *   compliance-checks         the signed samples of every registered document type → POST /compliance/invoices
 *   production-csid           → the production CSID
 *   renew { otp }             a new key + CSR → the renewed production CSID
 *   revoke { reason }         the unit stops signing (local)
 * Admin + accounting › zatca_onboard + step-up. Every call to ZATCA is logged without its secrets.
 */
export async function POST(request: Request, { params }: Ctx) {
  const { id, step } = await params;
  const { user, error } = await requireSub("accounting", "zatca_onboard");
  if (error) return error;
  const refused = await requireAdminAction(user, "accounting.zatca_onboard", { stepUp: true });
  if (refused) return refused;
  try {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const ctx = auditFromRequest(request, user.id, `EGS ${step}`);
    switch (step) {
      case "compliance-csid": return NextResponse.json({ egs: await requestComplianceCsid(id, b.otp, ctx) });
      case "compliance-checks": return NextResponse.json(await runComplianceChecks(id, ctx));
      case "production-csid": return NextResponse.json({ egs: await requestProductionCsid(id, ctx) });
      case "renew": return NextResponse.json({ egs: await renewCsid(id, b.otp, ctx) });
      case "revoke": return NextResponse.json({ egs: await revokeEgs(id, typeof b.reason === "string" ? b.reason : "", ctx) });
      default: return NextResponse.json({ error: "خطوة غير معروفة.", errorEn: "Unknown step.", code: "NOT_FOUND" }, { status: 404 });
    }
  } catch (err) {
    return zatcaError(err);
  }
}
