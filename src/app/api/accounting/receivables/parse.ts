import { AccountingError } from "@/lib/accounting/errors";
import type { SalesDocInput, SalesLineInput } from "@/lib/accounting/receivables-service";

export function parseSalesBody(b: Record<string, unknown>): SalesDocInput & { kind?: "INVOICE" | "CREDIT_NOTE"; originalInvoiceId?: string | null; debitNoteOfId?: string | null } {
  if (!Array.isArray(b.lines)) throw new AccountingError("lines must be a list.", 400);
  const s = (v: unknown, f: string) => { if (v !== undefined && v !== null && typeof v !== "string") throw new AccountingError(`${f} must be text.`, 400); return (v as string | undefined) ?? undefined; };
  const lines: SalesLineInput[] = b.lines.map((raw, i) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    for (const k of ["quantity", "unitPrice"]) if (typeof l[k] !== "string" && typeof l[k] !== "number") throw new AccountingError(`Line ${i + 1}: ${k} is required.`, 400);
    return {
      accountId: s(l.accountId, `Line ${i + 1} account`) ?? null, productSkuId: s(l.productSkuId, "productSkuId") ?? null, orderItemId: s(l.orderItemId, "orderItemId") ?? null,
      description: s(l.description, `Line ${i + 1} description`) ?? null, quantity: l.quantity as string, unitPrice: l.unitPrice as string,
      discountPercent: (typeof l.discountPercent === "string" || typeof l.discountPercent === "number") ? l.discountPercent : undefined,
      taxCategoryId: s(l.taxCategoryId, `Line ${i + 1} tax category`) ?? null, costCenterId: s(l.costCenterId, `Line ${i + 1} cost centre`) ?? null,
      stockTreatment: l.stockTreatment === "GOODS" || l.stockTreatment === "NON_STOCK" ? l.stockTreatment : null,
      invItemId: s(l.invItemId, `Line ${i + 1} inventory item`) ?? null, unit: s(l.unit, `Line ${i + 1} unit`) ?? null,
    };
  });
  return {
    kind: b.kind === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE", originalInvoiceId: s(b.originalInvoiceId, "originalInvoiceId") ?? null, debitNoteOfId: s(b.debitNoteOfId, "debitNoteOfId") ?? null,
    customerId: s(b.customerId, "customerId") ?? "", issueDate: s(b.issueDate, "issueDate") ?? "", supplyDate: s(b.supplyDate, "supplyDate") ?? null,
    dueDate: s(b.dueDate, "dueDate") ?? null, orderId: s(b.orderId, "orderId") ?? null, branchId: s(b.branchId, "branchId") ?? null,
    description: s(b.description, "description") ?? null, reason: s(b.reason, "reason") ?? null, lines,
    fulfilmentLocationId: s(b.fulfilmentLocationId, "fulfilmentLocationId") ?? null,
    creditType: b.creditType === "RETURN_OF_GOODS" || b.creditType === "PRICE_ADJUSTMENT" ? b.creditType : null,
    customerReturnId: s(b.customerReturnId, "customerReturnId") ?? null, replacesInvoiceId: s(b.replacesInvoiceId, "replacesInvoiceId") ?? null,
  };
}
