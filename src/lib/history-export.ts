/**
 * Rows of the history page's orders and inventory CSV exports (GET /api/export).
 *
 * Small-fixes batch B1/B2: the two columns were read from fields the API never returns —
 * "VAT Status" from `vatStatus` (the order's field is `vatInvoiceStatus`) and "Arrival Date" from
 * `arrivalDate` (the green lot's field is `receivedDate`) — so every row carried an empty VAT status
 * and an invalid arrival date. Pure, so the mapping is tested without a browser.
 */
import { formatDate } from "@/lib/utils";

type ExportOrder = {
  orderNumber: number; createdAt: string; paymentStatus: string; vatInvoiceStatus: string;
  customer?: { name?: string | null } | null;
  items?: { beanTypeName: string; quantityKg: number; productionStatus: string; deliveryStatus: string; deliveredQty: number; remainingQty: number }[];
};
type ExportGreenLot = {
  serialNumber: string; beanType: string; country: string; region?: string | null; quantityKg: number; receivedDate: string | null;
};

export function orderExportRows(orders: ExportOrder[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const o of orders) {
    for (const item of o.items || []) {
      rows.push({
        "Order #": o.orderNumber,
        Customer: o.customer?.name || "",
        "Order Date": formatDate(o.createdAt),
        "Payment Status": o.paymentStatus,
        "VAT Status": o.vatInvoiceStatus ?? "",
        "Bean Type": item.beanTypeName,
        "Quantity (kg)": item.quantityKg,
        "Production Status": item.productionStatus,
        "Delivery Status": item.deliveryStatus,
        "Delivered (kg)": item.deliveredQty,
        "Remaining (kg)": item.remainingQty,
      });
    }
  }
  return rows;
}

export function inventoryExportRows(lots: ExportGreenLot[]): Record<string, unknown>[] {
  return lots.map((g) => ({
    "S/N": g.serialNumber,
    "Bean Type": g.beanType,
    Country: g.country,
    Region: g.region || "",
    "Quantity (kg)": g.quantityKg,
    "Arrival Date": g.receivedDate ? formatDate(g.receivedDate) : "",
  }));
}
