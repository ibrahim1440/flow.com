import { prisma } from "@/lib/db";
import { accountingRoute, query } from "@/lib/accounting/http";
import { receiptLines, openBillStockLines, saleLines, operationalSources, linkTargets } from "@/lib/accounting/inventory-queries";

/** Lists the document editor chooses from: receipt lines, open bill stock lines, sale lines, operational sources, suppliers, customers. */
export const GET = accountingRoute(null, async ({ request }) => {
  const q = query(request);
  const what = q.get("what");
  if (what === "receipt-lines") return receiptLines(q.get("supplierId"));
  if (what === "bill-lines") return openBillStockLines();
  if (what === "sale-lines") return saleLines(q.get("customerId"));
  if (what === "sources") return operationalSources();
  if (what === "link-targets") return linkTargets();
  if (what === "suppliers") return prisma.supplier.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, vatNumber: true }, take: 300 });
  if (what === "customers") return (await prisma.customer.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, nameAr: true }, take: 300 })).map((c) => ({ id: c.id, name: c.nameAr ?? c.name }));
  return [];
});
