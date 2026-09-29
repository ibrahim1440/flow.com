import { prisma } from "@/lib/db";
import { accountingRoute, body } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { auditAccounting } from "@/lib/accounting/audit";

const FIELDS = ["street", "buildingNo", "district", "city", "postalCode", "countryCode"] as const;
// A customer's structured national address for e-invoicing (standard invoices need it).
export const PUT = accountingRoute("ar_invoice_create", async ({ user, params, request }) => {
  const b = await body(request);
  const addr: Record<string, string> = {};
  for (const k of FIELDS) { const v = typeof b[k] === "string" ? (b[k] as string).trim() : ""; if (v) addr[k] = v.slice(0, 120); }
  if (!addr.countryCode) addr.countryCode = "SA";
  const before = await prisma.customer.findUnique({ where: { id: params.id }, select: { nationalAddress: true } });
  if (!before) throw new AccountingError("Customer not found.", 404);
  return prisma.$transaction(async (tx) => {
    const c = await tx.customer.update({ where: { id: params.id }, data: { nationalAddress: addr } });
    await auditAccounting(tx, { action: "customer.national_address", entityType: "customer", entityId: params.id, userId: user.id, before: before.nationalAddress, after: addr });
    return { id: c.id, nationalAddress: c.nationalAddress };
  });
});
