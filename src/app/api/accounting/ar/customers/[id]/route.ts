import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { abilities, canViewInvoices } from "@/lib/services/invoicing/access";
import { inScope } from "@/lib/services/invoicing/http";
import { customerAr } from "@/lib/services/invoicing/ar";
import { invError, refuseInv } from "@/lib/services/invoicing/refusals";
import { m2 } from "@/lib/services/invoicing/pricing";

type Ctx = { params: Promise<{ id: string }> };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/accounting/ar/customers/:id?from&to&asOf — «كشف حساب العميل»: the open items, the unapplied receipts and
 * credits, the aging, and the statement of account (opening, moves with running balance, closing). Read-only.
 */
export async function GET(request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions)) return forbidden();
  try {
    const { id } = await params;
    const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true, name: true, nameAr: true, vatNumber: true, creditLimit: true, paymentTermsDays: true, accountOwnerId: true, city: true } });
    if (!customer || !(await inScope(user, id))) return NextResponse.json({ error: "غير موجود.", errorEn: "Not found.", code: "NOT_FOUND" }, { status: 404 });
    const q = new URL(request.url).searchParams;
    const from = q.get("from"), to = q.get("to"), asOf = q.get("asOf");
    if ([from, to, asOf].some((x) => x && !DAY.test(x))) throw refuseInv("BAD_INPUT", "Dates are YYYY-MM-DD.", "التواريخ بصيغة YYYY-MM-DD.");
    const ar = await customerAr(prisma, id, { from, to, asOf: asOf ?? undefined });
    const s = ar.statement;
    return NextResponse.json({
      customer: { ...customer, creditLimit: customer.creditLimit ? m2(customer.creditLimit) : null },
      asOf: ar.asOf,
      open: ar.open.map((o) => ({ ...o, total: m2(o.total), applied: m2(o.applied), open: m2(o.open) })),
      credits: ar.credits.map((c) => ({ ...c, amount: m2(c.amount), applied: m2(c.applied), unapplied: m2(c.unapplied) })),
      aging: Object.fromEntries(Object.entries(ar.aging).map(([k, v]) => [k, typeof v === "number" ? v : m2(v)])),
      statement: { from, to, opening: m2(s.opening), closing: m2(s.closing), totalDebit: m2(s.totalDebit), totalCredit: m2(s.totalCredit), rows: s.rows.map((r) => ({ ...r, debit: m2(r.debit), credit: m2(r.credit), balance: m2(r.balance) })) },
      applications: ar.applications.map((a) => ({ ...a, amount: m2(a.amount), appliedDate: a.appliedDate.toISOString().slice(0, 10) })),
      can: abilities(user.permissions),
    });
  } catch (err) {
    return invError(err);
  }
}
