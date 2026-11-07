// POST /api/sales/direct-sale/[orderId]/discount-approval — a supervisor approves or refuses the discount of a «بيع مباشر»
// waiting for it (the approvals inbox). Body: { decision: "APPROVE" | "REJECT", note?, expected?: { discountPercent?, grandTotal? } }.
// The quotation discount's privilege and gate: sales › quote_approve_discount through `requireSub` (verified individual and
// a recent step-up, 401 REAUTH_REQUIRED). Scoped like the quotation route: a caller who does not see all sales decides only
// on orders of customers in their book. Rules and writes: decideDirectSaleDiscount (services/sales/direct-sale.ts).
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { AccountingError } from "@/lib/accounting/errors";
import { invError } from "@/lib/services/invoicing/refusals";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { decideDirectSaleDiscount } from "@/lib/services/sales/direct-sale";

type Params = { params: Promise<{ orderId: string }> };
const figure = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "quote_approve_discount");
  if (error) return error;
  const { orderId } = await params;
  let b: Record<string, unknown>;
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const decision = typeof b.decision === "string" ? b.decision.toUpperCase() : "";
  if (decision !== "APPROVE" && decision !== "REJECT") return NextResponse.json({ error: "decision must be APPROVE or REJECT." }, { status: 400 });
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") return NextResponse.json({ error: "note must be text." }, { status: 400 });
  try {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { customerId: true } });
    if (!o || (!seesAllSales(user.permissions) && !(await customerInScope(user, o.customerId)))) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    const e = b.expected && typeof b.expected === "object" ? (b.expected as Record<string, unknown>) : null;
    const r = await decideDirectSaleDiscount({
      orderId, decision, note: typeof b.note === "string" ? b.note : null, actor: { id: user.id, name: user.name },
      expected: e ? { discountPercent: figure(e.discountPercent), grandTotal: figure(e.grandTotal) } : undefined,
      ctx: auditFromRequest(request, user.id),
    });
    return NextResponse.json(r);
  } catch (err) {
    if (err instanceof AccountingError) return invError(err);
    return handleDomainError(err);
  }
}
