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
    const sp = new URL(request.url).searchParams;
    const q = (sp.get("q") ?? "").trim().slice(0, 80);
    // D22: `?id=` — one customer (the invoice page opened from the customer, «بيع مباشر» / «إرسال عيّنة»), in the same scope.
    const id = (sp.get("id") ?? "").trim().slice(0, 64);
    const scope = await scopedCustomerIds(user);
    if (id && scope && !scope.includes(id)) return NextResponse.json({ items: [] });
    const rows = await prisma.customer.findMany({
      where: { ...(id ? { id } : scope ? { id: { in: scope } } : {}), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { nameAr: { contains: q } }, { vatNumber: { contains: q } }] } : {}) },
      orderBy: { name: "asc" }, take: 50,
      select: { id: true, name: true, nameAr: true, vatNumber: true, commercialRegNo: true, city: true, address: true, phone: true, paymentTermsDays: true, unifiedNumber: true, nationalBuildingNo: true, nationalStreet: true, nationalDistrict: true, nationalCity: true, nationalPostalCode: true, nationalAdditionalNo: true },
    });
    return NextResponse.json({ items: rows });
  } catch (err) {
    return invError(err);
  }
}
