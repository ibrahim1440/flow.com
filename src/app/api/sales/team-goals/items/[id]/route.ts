import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { removeItem } from "@/lib/services/sales/plans";

/** DELETE /api/sales/team-goals/items/:id — the supervisor removes an item THEY (the management) put in a rep's plan. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireSub("sales", "lead_assign");
  if (error) return error;
  try {
    const { id } = await params;
    const item = await prisma.salesPlanItem.findUnique({ where: { id }, select: { source: true, kind: true } });
    if (!item || item.source !== "ADMIN" || item.kind === "GOAL") return NextResponse.json({ error: "غير موجود.", errorEn: "Not found." }, { status: 404 });
    await prisma.$transaction((tx) => removeItem(tx, id, user.id));
    return NextResponse.json({ ok: true });
  } catch (e) { return handleDomainError(e); }
}
