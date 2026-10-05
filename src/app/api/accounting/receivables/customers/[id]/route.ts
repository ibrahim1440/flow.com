import { prisma } from "@/lib/db";
import { accountingRoute, body } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { advanceBalance, openInvoices, updateCustomerTaxData } from "@/lib/accounting/receivables-service";

export const GET = accountingRoute(null, async ({ params }) => {
  const c = await prisma.customer.findUnique({ where: { id: params.id } });
  if (!c) throw new AccountingError("Customer not found.", 404);
  const [open, adv] = await Promise.all([openInvoices(prisma, c.id), advanceBalance(prisma, c.id)]);
  return {
    id: c.id, name: c.nameAr ?? c.name, nameEn: c.name, vatNumber: c.vatNumber, crNumber: c.crNumber, paymentTermsDays: c.paymentTermsDays, creditLimit: c.creditLimit?.toFixed(2) ?? null,
    openInvoices: open.map((i) => ({ ...i, gross: i.gross.toFixed(2), open: i.open.toFixed(2) })), advance: adv.amount.toFixed(2), advanceVat: adv.vat.toFixed(2),
  };
});

export const PATCH = accountingRoute("ar_invoice_create", async ({ user, params, request }) => updateCustomerTaxData(params.id, await body(request), user.id));
