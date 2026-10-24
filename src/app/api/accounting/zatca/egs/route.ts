import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { createEgs } from "@/lib/zatca/egs";
import { zatcaError } from "@/lib/zatca/refusals";

/**
 * POST /api/accounting/zatca/egs — a new EGS unit (environment, name, branch, location, industry, invoice types):
 * the server generates its secp256k1 key pair (the private key is stored encrypted, never returned) and its CSR.
 * Admin + accounting › zatca_onboard + step-up.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "zatca_onboard");
  if (error) return error;
  const refused = await requireAdminAction(user, "accounting.zatca_onboard", { stepUp: true });
  if (refused) return refused;
  try {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json({ egs: await createEgs(b as never, auditFromRequest(request, user.id, "EGS unit created")) }, { status: 201 });
  } catch (err) {
    return zatcaError(err);
  }
}
