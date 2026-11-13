// POST /api/customers/credit-overrides/[id]/withdraw — gate R7: the requester withdraws their own PENDING over-limit
// request («اسحب الطلب»). Anyone else: 404 (nobody learns another rep's request exists); not pending: 409.
import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { withdrawCreditOverride } from "@/lib/services/customers/credit-limit";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await withdrawCreditOverride({ id: user.id, permissions: user.permissions } as never, id));
  } catch (err) {
    return handleDomainError(err);
  }
}
