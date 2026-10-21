import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { PRINT_NOT_CERTIFIED_CODE, PRINT_NOT_CERTIFIED_MESSAGE, isPrintCertified } from "@/lib/print/certification";

export const dynamic = "force-dynamic";

/**
 * Whether label printing is enabled on this deployment (the PRINT_CERTIFIED gate). Any signed-in
 * user may ask; the screens use it to disable their print actions with the explanation. It is a
 * convenience for the UI only — every printing endpoint enforces the gate itself.
 */
export async function GET() {
  const { error } = await requireAuth();
  if (error) return error;
  const certified = isPrintCertified();
  return NextResponse.json(
    certified ? { certified: true } : { certified: false, code: PRINT_NOT_CERTIFIED_CODE, message: { ...PRINT_NOT_CERTIFIED_MESSAGE } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
