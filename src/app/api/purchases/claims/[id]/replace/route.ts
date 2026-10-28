import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { replaceClaim } from "@/lib/accounting/ops/supplier-claims";

type Params = { params: Promise<{ id: string }> };

/**
 * «استلام بضاعة بديلة» for an open claim — { quantity (≤ open), receivedDate?, locationId? }: received into stock at the
 * claim's unit cost (Dr inventory / Cr supplier claims, no VAT). The receiving duty: inventory › receive.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("inventory", "receive");
  if (error) return error;
  try {
    const b = await jsonBody(request);
    return NextResponse.json(await replaceClaim((await params).id, { quantity: b.quantity as string | number, receivedDate: (b.receivedDate as string | null) ?? null, locationId: (b.locationId as string | null) ?? null }, user, auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
