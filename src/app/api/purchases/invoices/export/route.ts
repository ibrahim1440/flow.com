import { acctError, qp } from "@/lib/accounting/http";
import { csvResponse, requireApRead } from "@/lib/accounting/ops/http";
import { listInvoices } from "@/lib/accounting/ops/ap";
import { riyadhStamp } from "@/lib/inventory/csv";

/** GET /api/purchases/invoices/export?status=&supplierId=&from=&to=&q= — the invoices tab as CSV (the same filters). */
export async function GET(request: Request) {
  const { error } = await requireApRead();
  if (error) return error;
  try {
    const r = await listInvoices({ status: qp(request, "status"), supplierId: qp(request, "supplierId"), from: qp(request, "from"), to: qp(request, "to"), q: qp(request, "q"), take: 1000 });
    return csvResponse(`purchase-invoices-${riyadhStamp(new Date()).slice(0, 10)}`,
      ["number", "supplier", "supplier_ref", "invoice_date", "due_date", "status", "received", "net_sar", "vat_sar", "total_sar", "paid_sar", "remaining_sar"],
      r.rows.map((x) => [x.number, x.supplierName, x.supplierRef, x.invoiceDate, x.dueDate, x.status, x.received ? "yes" : "no", x.netTotal, x.vatTotal, x.grossTotal, x.paidTotal, x.outstanding]));
  } catch (err) {
    return acctError(err);
  }
}
