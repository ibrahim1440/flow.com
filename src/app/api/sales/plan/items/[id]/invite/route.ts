import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { PlanError, inviteItem, riyadhIso } from "@/lib/services/sales/plans";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/plan/items/:id/invite — D17 «أرسل الدعوة»: the caller's planned meeting (a day, a time and colleagues) is
 * sent to the colleagues — an appointment of the caller's that they see in «يومي», the calendar and the bell.
 */
export async function POST(_request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const { id } = await params;
    const appointmentId = await prisma.$transaction((tx) => inviteItem(tx, user.id, id, riyadhIso(new Date())));
    return NextResponse.json({ ok: true, appointmentId });
  } catch (e) {
    if (e instanceof PlanError) return NextResponse.json({ error: e.ar, errorEn: e.message, code: e.code }, { status: e.status });
    return handleDomainError(e);
  }
}
