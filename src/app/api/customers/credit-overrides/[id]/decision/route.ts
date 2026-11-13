// POST /api/customers/credit-overrides/[id]/decision { decision: "APPROVE" | "REJECT", note } — P1 ERR-02: the supervisor's
// decision on an order over the credit limit (customers › sales_hold through `requireSub`: verified individual + a recent
// step-up). A documented reason either way; never the requester (refused in the service and by a CHECK).
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { decideCreditOverride } from "@/lib/services/customers/credit-limit";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  const { user, error } = await requireSub("customers", "sales_hold");
  if (error) return error;
  const { id } = await params;
  let b: Record<string, unknown>;
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  try {
    const r = await prisma.creditLimitOverride.findUnique({ where: { id }, select: { customerId: true } });
    if (!r || !(await customerInScope(user, r.customerId))) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    return NextResponse.json(await decideCreditOverride({ id: user.id, name: user.name, permissions: user.permissions }, id, { decision: typeof b.decision === "string" ? b.decision.toUpperCase() : b.decision, note: b.note }));
  } catch (err) {
    return handleDomainError(err);
  }
}
