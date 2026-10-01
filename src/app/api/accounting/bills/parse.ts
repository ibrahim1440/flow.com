import { AccountingError } from "@/lib/accounting/errors";
import type { BillInput, BillLineInput } from "@/lib/accounting/payables-service";

export function parseBillBody(b: Record<string, unknown>): BillInput {
  if (!Array.isArray(b.lines)) throw new AccountingError("lines must be a list.", 400);
  const s = (v: unknown, f: string) => { if (v !== undefined && v !== null && typeof v !== "string") throw new AccountingError(`${f} must be text.`, 400); return (v as string | undefined) ?? undefined; };
  const lines: BillLineInput[] = b.lines.map((raw, i) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    for (const k of ["quantity", "unitPrice"]) if (typeof l[k] !== "string" && typeof l[k] !== "number") throw new AccountingError(`Line ${i + 1}: ${k} is required.`, 400);
    return {
      kind: l.kind === "STOCK_RECEIPT" || l.kind === "STOCK_RETURN" || l.kind === "STOCK_PRICE_ADJUSTMENT" ? l.kind : "EXPENSE",
      accountId: s(l.accountId, `Line ${i + 1} account`), description: s(l.description, `Line ${i + 1} description`),
      quantity: l.quantity as string, unitPrice: l.unitPrice as string,
      taxCategoryId: s(l.taxCategoryId, `Line ${i + 1} tax category`) ?? null, costCenterId: s(l.costCenterId, `Line ${i + 1} cost centre`) ?? null,
      invDocumentId: s(l.invDocumentId, `Line ${i + 1} supplier return`) ?? null, invDocLineId: s(l.invDocLineId, `Line ${i + 1} receipt line`) ?? null,
    };
  });
  return {
    supplierId: s(b.supplierId, "supplierId") ?? "", supplierInvoiceNo: s(b.supplierInvoiceNo, "supplierInvoiceNo") ?? "",
    billDate: s(b.billDate, "billDate") ?? "", dueDate: s(b.dueDate, "dueDate") ?? null, branchId: s(b.branchId, "branchId") ?? null,
    description: s(b.description, "description") ?? null, purchaseObligationId: s(b.purchaseObligationId, "purchaseObligationId") ?? null, lines,
    kind: b.kind === "CREDIT_NOTE" ? "CREDIT_NOTE" : "BILL", originalBillId: s(b.originalBillId, "originalBillId") ?? null, reason: s(b.reason, "reason") ?? null,
  };
}
