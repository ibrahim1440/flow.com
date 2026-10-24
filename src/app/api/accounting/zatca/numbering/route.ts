import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { seriesCounters, setSeriesStart } from "@/lib/zatca/egs";
import { zatcaError } from "@/lib/zatca/refusals";

/**
 * PUT /api/accounting/zatca/numbering { series, nextNumber } — the cut-over from the previous invoicing system: the
 * series continues after its last number (e.g. INV, 317 after Qoyod's INV316). Only while the series has issued
 * nothing here (the database refuses it after). Admin + accounting › zatca_onboard + step-up.
 */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("accounting", "zatca_onboard");
  if (error) return error;
  const refused = await requireAdminAction(user, "accounting.zatca_onboard", { stepUp: true });
  if (refused) return refused;
  try {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const r = await setSeriesStart({ series: b.series, nextNumber: b.nextNumber }, auditFromRequest(request, user.id, "numbering cut-over"));
    return NextResponse.json({ result: r, counters: await seriesCounters() });
  } catch (err) {
    return zatcaError(err);
  }
}
