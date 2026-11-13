// GET /api/customers/[id]/exposure — P1 ERR-02 «كم على العميل؟»: the ONE figure every screen shows (services/customers/
// exposure.ts): the receivable from the accounting AR (issued invoices − receipts − credit notes, with what is overdue),
// approved orders not yet invoiced (separately — not a debt, counted in the limit), the limit and what is used, and the
// accepted quotations not yet ordered («عروض مقبولة», not counted). Plus the caller's own open / approved over-limit
// requests for this customer. For whoever can see the customer (a rep: their own book only — 404 otherwise).
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { customerFiguresVisible, customerInScope } from "@/lib/services/sales/customer-access";
import { customerExposure, exposureJson } from "@/lib/services/customers/exposure";
import { expireCreditOverrides } from "@/lib/services/customers/credit-limit";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireAnyModule("customers", "orders", "sales");
  if (error) return error;
  const { id } = await params;
  // Owner M6: the figures only for a customer assigned to the rep (everyone else who sees all customers: yes).
  if (!(await customerInScope(user, id)) || !(await customerFiguresVisible(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const now = new Date();
    const out = await prisma.$transaction(async (tx) => {
      await expireCreditOverrides(tx, now);
      const e = (await customerExposure(tx, [id], now)).get(id);
      if (!e) return null;
      const mine = await tx.creditLimitOverride.findMany({
        where: { customerId: id, requestedById: user.id, status: { in: ["PENDING", "APPROVED"] } }, orderBy: { requestedAt: "desc" },
        select: { id: true, status: true, kind: true, amount: true, requestedAt: true, expiresAt: true, decisionNote: true },
      });
      return { ...exposureJson(e), overrides: mine.map((o) => ({ ...o, amount: o.amount.toFixed(2) })) };
    });
    if (!out) return NextResponse.json({ error: "العميل غير موجود.", errorEn: "Not found" }, { status: 404 });
    return NextResponse.json(out);
  } catch (err) {
    return handleDomainError(err);
  }
}
