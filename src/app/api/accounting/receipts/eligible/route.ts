import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { customerOpenDeal } from "@/lib/services/sales/collections";
import { receiptAbilities } from "@/lib/services/sales/receipts";
import { Decimal } from "@/lib/services/commissions/engine";

/**
 * GET /api/accounting/receipts/eligible?q= — the issued invoices a receipt with no deal may be recorded against: open
 * (what is applied and what is pending deducted), each with whether its customer has an open deal (then Sales records the
 * collection on the deal — the form says so and offers nothing). The accountant's record duty only.
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("accounting");
  if (error) return error;
  if (!receiptAbilities(user.permissions).record) return NextResponse.json({ error: "لا تملك صلاحية تسجيل سند القبض.", errorEn: "Not permitted.", code: "NO_PRIVILEGE" }, { status: 403 });
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const invoiceId = url.searchParams.get("invoiceId");
  try {
    // The invoice carries its customer's id (no relation): a search by name matches the customers first.
    const byName = q ? (await prisma.customer.findMany({ where: { OR: [{ name: { contains: q, mode: "insensitive" } }, { nameAr: { contains: q } }] }, select: { id: true }, take: 200 })).map((c) => c.id) : [];
    const invoices = await prisma.salesInvoice.findMany({
      where: {
        status: "ISSUED", kind: { in: ["INVOICE", "DEBIT_NOTE"] },
        ...(invoiceId ? { id: invoiceId } : {}),
        ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { customerId: { in: byName } }] } : {}),
      },
      orderBy: [{ issueDate: "asc" }], take: 200,
      select: { id: true, number: true, issueDate: true, dueDate: true, grandTotal: true, currency: true, customerId: true },
    });
    const customers = new Map((await prisma.customer.findMany({ where: { id: { in: [...new Set(invoices.map((i) => i.customerId))] } }, select: { id: true, name: true, nameAr: true } })).map((c) => [c.id, c]));
    const ids = invoices.map((i) => i.id);
    const [applied, pending] = ids.length ? await Promise.all([
      prisma.arApplication.groupBy({ by: ["invoiceId"], where: { invoiceId: { in: ids }, status: "APPLIED" }, _sum: { amount: true } }),
      prisma.salesCollection.groupBy({ by: ["invoiceId"], where: { invoiceId: { in: ids }, status: "PENDING_VERIFICATION" }, _sum: { amountGross: true } }),
    ]) : [[], []];
    const deals = new Map<string, { id: string; title: string } | null>();
    const out = [];
    for (const i of invoices) {
      const open = new Decimal(i.grandTotal.toString()).minus(new Decimal((applied.find((a) => a.invoiceId === i.id)?._sum.amount ?? 0).toString())).minus(new Decimal((pending.find((p) => p.invoiceId === i.id)?._sum.amountGross ?? 0).toString()));
      if (open.lessThanOrEqualTo(0)) continue;
      if (!deals.has(i.customerId)) deals.set(i.customerId, await customerOpenDeal(prisma, i.customerId));
      out.push({ id: i.id, number: i.number, issueDate: i.issueDate?.toISOString().slice(0, 10) ?? null, dueDate: i.dueDate?.toISOString().slice(0, 10) ?? null, total: new Decimal(i.grandTotal.toString()).toFixed(2), open: open.toFixed(2), currency: i.currency, customer: customers.get(i.customerId) ?? { id: i.customerId, name: "—", nameAr: null }, openDeal: deals.get(i.customerId) ?? null });
    }
    return NextResponse.json({ invoices: out });
  } catch (err) {
    return handleDomainError(err);
  }
}
