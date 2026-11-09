import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { PlanError, editRecurrence, riyadhIso, stopRecurrence } from "@/lib/services/sales/plans";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/sales/plan/recurrences/:id { weekday?, plannedTime?, untilDay?, label? } | { stop: true } — D17 «خطتي ← المتكرر»: change
 * one of the caller's weekly rules from next week, or stop it (this week's item stays; the weeks ahead go).
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { stop?: unknown; weekday?: unknown; plannedTime?: unknown; untilDay?: unknown; label?: unknown };
    const today = riyadhIso(new Date());
    await prisma.$transaction((tx) => (body.stop === true ? stopRecurrence(tx, user.id, id, today) : editRecurrence(tx, user.id, id, body, today)));
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof PlanError) return NextResponse.json({ error: e.ar, errorEn: e.message, code: e.code }, { status: e.status });
    return handleDomainError(e);
  }
}
