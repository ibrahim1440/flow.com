import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { PRINT_NOT_CERTIFIED_CODE, PRINT_NOT_CERTIFIED_MESSAGE, printStatus } from "@/lib/print/certification";

export const dynamic = "force-dynamic";

/**
 * Whether label printing (the PRINT_CERTIFIED gate) and plain document printing
 * (PRINT_DOCUMENTS_ENABLED) are enabled on this deployment. Any signed-in
 * user may ask; the screens use it to disable their print actions with the explanation. It is a
 * convenience for the UI only — every printing endpoint enforces the gate itself.
 */
export async function GET() {
  const { error } = await requireAuth();
  if (error) return error;
  // `certified`: label printing (PRINT_CERTIFIED, A-8). `documents`: plain A4 document printing
  // (PRINT_DOCUMENTS_ENABLED, or implied by PRINT_CERTIFIED).
  const { certified, documents } = printStatus();
  return NextResponse.json(
    certified ? { certified: true, documents } : { certified: false, documents, code: PRINT_NOT_CERTIFIED_CODE, message: { ...PRINT_NOT_CERTIFIED_MESSAGE } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
