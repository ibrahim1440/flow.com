import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireInvoiceDuty } from "@/lib/services/invoicing/guard";

/** The sales categories a draft's line may carry (the active product categories) — for whoever writes an invoice draft. */
export async function GET() {
  const { error } = await requireInvoiceDuty("invoices_create");
  if (error) return error;
  const categories = await prisma.catalogCategory.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { nameAr: "asc" }], select: { id: true, nameAr: true, nameEn: true } });
  return NextResponse.json({ categories });
}
