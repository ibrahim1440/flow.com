// POST /api/sales/invoices/[id]/draft-approval — P0 SEC-02 / C4: a supervisor approves or refuses the discount of a direct
// sale's / sample's invoice DRAFT that a rep edited above the threshold (the approvals inbox). Body: { decision, note? }.
// The quotation discount's privilege and gate: sales › quote_approve_discount through `requireSub` (verified individual and
// a recent step-up). Scoped to the caller's customers unless they see all sales. Rules: decideDraftApproval
// (services/invoicing/draft-control.ts) — four eyes unless SIMPLE MODE, and only on the terms that were asked about.
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { decideDraftApproval } from "@/lib/services/invoicing/draft-control";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  const { user, error } = await requireSub("sales", "quote_approve_discount");
  if (error) return error;
  const { id } = await params;
  let b: Record<string, unknown>;
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  try {
    const inv = await prisma.salesInvoice.findUnique({ where: { id }, select: { customerId: true } });
    if (!inv || (!seesAllSales(user.permissions) && !(await customerInScope(user, inv.customerId)))) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    return NextResponse.json(await decideDraftApproval({ id: user.id, name: user.name, permissions: user.permissions }, id, { decision: typeof b.decision === "string" ? b.decision.toUpperCase() : b.decision, note: b.note }));
  } catch (err) {
    return handleDomainError(err);
  }
}
