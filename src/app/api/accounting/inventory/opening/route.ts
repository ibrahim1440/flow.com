import { NextResponse } from "@/lib/api-response";
import { requireModule, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { openingPreview, saveOpeningCosts } from "@/lib/accounting/ops/valuation";

/** The opening inventory valuation: on-hand now × the cost it would use (owner-entered, else the last known). */
export async function GET() {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json(await openingPreview());
  } catch (err) {
    return acctError(err);
  }
}

/** Save the owner's unit costs: { costs: [{ kind, entityId, unitCost | null }] }. Before the opening is posted. */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("accounting", "opening_balance");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    await saveOpeningCosts(b.costs, auditFromRequest(request, user.id, "opening inventory costs"));
    return NextResponse.json(await openingPreview());
  } catch (err) {
    return acctError(err);
  }
}
