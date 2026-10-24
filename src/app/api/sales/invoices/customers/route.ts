import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { canCreateInvoices, canViewInvoices } from "@/lib/services/invoicing/access";
import { scopedCustomerIds } from "@/lib/services/invoicing/http";
import { invError } from "@/lib/services/invoicing/refusals";

/**
 * GET /api/sales/invoices/customers?q= — the invoice editor's customer picker: the buyer particulars an invoice
 * prefills (name, VAT number, CR, city, address, payment terms). Invoices viewers / creators, in their scope.
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canCreateInvoices(user.permissions) && !canViewInvoices(user.permissions)) return forbidden();
  try {
    const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 80);
    const scope = await scopedCustomerIds(user);
    const rows = await prisma.customer.findMany({
      where: { ...(scope ? { id: { in: scope } } : {}), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { nameAr: { contains: q } }, { vatNumber: { contains: q } }] } : {}) },
      orderBy: { name: "asc" }, take: 50,
      select: { id: true, name: true, nameAr: true, vatNumber: true, commercialRegNo: true, city: true, address: true, phone: true, paymentTermsDays: true },
    });
    return NextResponse.json({ items: rows });
  } catch (err) {
    return invError(err);
  }
}
