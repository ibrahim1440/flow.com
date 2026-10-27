import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { csvResponseHeaders, riyadhStamp, toCsv } from "@/lib/inventory/csv";
import { parsePeriod, parseSort, periodStart, sortPurchases } from "@/lib/inventory/purchases-query";

/**
 * GET /api/purchases/export?period=30|90|365|all&sort=newest|oldest|cost|qty&q= — the purchase register
 * as CSV (UTF-8 with BOM), the same period, sort and search as the page. Inventory module, read-only
 * (the same access as GET /api/purchases). Phase 2 adds reversed (yes / no) and the linked purchase invoice's number and
 * status (a cancelled invoice stays and shows as CANCELLED).
 */
export async function GET(request: Request) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  const sp = new URL(request.url).searchParams;
  const period = parsePeriod(sp.get("period"));
  const start = periodStart(period);
  const q = (sp.get("q") ?? "").trim().toLowerCase();
  try {
    const rows = await prisma.purchaseRecord.findMany({
      where: start ? { purchaseDate: { gte: start } } : undefined,
      orderBy: [{ purchaseDate: "desc" }, { createdAt: "desc" }],
      take: 10_000,
      include: { supplier: true },
    });
    const beanIds = [...new Set(rows.map((r) => r.itemId).filter((x): x is string => !!x))];
    const beans = beanIds.length ? await prisma.greenBean.findMany({ where: { id: { in: beanIds } }, select: { id: true, beanType: true, beanTypeAr: true, serialNumber: true } }) : [];
    const bean = new Map(beans.map((b) => [b.id, b]));
    const matching = q
      ? rows.filter((p) => {
          const b = p.itemId ? bean.get(p.itemId) : undefined;
          return `${p.supplier.name} ${b?.beanType ?? ""} ${b?.beanTypeAr ?? ""} ${b?.serialNumber ?? ""} ${p.notes ?? ""}`.toLowerCase().includes(q);
        })
      : rows;
    const sorted = sortPurchases(matching, parseSort(sp.get("sort")));
    // Phase 2: whether the receipt was reversed, and the purchase invoice it belongs to (a live one over a cancelled one).
    const ids = sorted.map((p) => p.id);
    const [links, reversals] = ids.length
      ? await Promise.all([
          prisma.supplierInvoiceLine.findMany({ where: { purchaseRecordId: { in: ids } }, select: { purchaseRecordId: true, invoice: { select: { number: true, status: true } } } }),
          prisma.costMove.findMany({ where: { sourceType: "GRN", sourceId: { in: ids }, sourceEvent: "REVERSED" }, select: { sourceId: true } }),
        ])
      : [[], []];
    const reversed = new Set(reversals.map((m) => m.sourceId));
    const invoiceOf = (id: string) => {
      const l = links.filter((x) => x.purchaseRecordId === id);
      return (l.find((x) => x.invoice.status !== "CANCELLED") ?? l[0])?.invoice ?? null;
    };
    const csv = toCsv(
      ["purchase_date", "supplier", "supplier_contact", "type", "green_coffee", "green_coffee_ar", "lot", "quantity_kg", "cost_per_kg_sar", "total_cost_sar", "notes", "recorded_at_riyadh", "purchase_id", "reversed", "invoice_number", "invoice_status"],
      sorted.map((p) => {
        const b = p.itemId ? bean.get(p.itemId) : undefined;
        return [p.purchaseDate.toISOString().slice(0, 10), p.supplier.name, p.supplier.contact, p.type, b?.beanType, b?.beanTypeAr, b?.serialNumber, p.quantity, p.costPerUnit, p.totalCost, p.notes, riyadhStamp(p.createdAt), p.id, reversed.has(p.id) ? "yes" : "no", invoiceOf(p.id)?.number, invoiceOf(p.id)?.status];
      }),
    );
    return new Response(csv, { headers: { ...csvResponseHeaders(`purchases-${period}-${riyadhStamp(new Date()).slice(0, 10)}.csv`), "X-Export-Rows": String(sorted.length) } });
  } catch (err) {
    return handlePrismaError(err);
  }
}
