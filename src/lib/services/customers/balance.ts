// The customer's balance as one figure, for every screen that shows it (the customer file's «الرصيد المستحق» and the
// deal page's customer panel — release item I-44): the receivables ledger's balance owed once the customer has an
// issued invoice and the viewer may read invoices (invoicing/ar.ts invoiceCreditFigures, council gate S5); otherwise
// the accepted quotations of the deals the viewer sees less their approved collections, labelled «عروض مقبولة لم
// تُفوتر» (customers/aggregates.ts outstandingBalance). One implementation, so the two screens cannot disagree.
import type { PrismaClient } from "@/generated/prisma/client";
import { Decimal, acceptedDocumentPerDeal, outstandingBalance } from "./aggregates";
import { invoiceCreditFigures } from "@/lib/services/invoicing/ar";

type Db = Pick<PrismaClient, "salesInvoice" | "salesCollection" | "quote" | "arApplication">;

/** The AR balance owed, or null when the viewer may not read invoices or the customer has no issued invoice. */
export async function arBalanceOwed(db: Db, customerId: string, canReadInvoices: boolean, now: Date): Promise<Decimal | null> {
  if (!canReadInvoices) return null;
  if ((await db.salesInvoice.count({ where: { customerId, status: "ISSUED" } })) === 0) return null;
  return (await invoiceCreditFigures(db as never, [customerId], now)).get(customerId)?.outstanding ?? null;
}

export type CustomerBalance = {
  /** Accepted quotations of the deals in scope less their approved collections («عروض مقبولة لم تُفوتر»). */
  outstanding: string; documents: number; openDocuments: number; currency: "SAR";
  basis: "ACCEPTED_NOT_INVOICED";
  /** The balance owed from the receivables ledger, once invoiced (null otherwise). */
  ar: { outstanding: string; basis: "RECEIVABLES" } | null;
};

/**
 * The balance over the deals `dealWhere` lets the viewer see (the caller's owner scope, `{}` for everyone), for a
 * screen that does not already hold the deals' accepted quotations and collections (the customer file computes the
 * same `outstandingBalance` from the rows it lists).
 */
export async function customerBalance(
  db: Db, customerId: string, dealWhere: Record<string, unknown>, canReadInvoices: boolean, now: Date,
): Promise<CustomerBalance> {
  const quotes = await db.quote.findMany({
    where: { status: "ACCEPTED", opportunity: { customerId, ...dealWhere } },
    select: { id: true, opportunityId: true, revision: true, grandTotal: true },
  });
  const accepted = acceptedDocumentPerDeal(quotes);
  const dealIds = [...new Set(accepted.map((q) => q.opportunityId))];
  const approved = dealIds.length
    ? await db.salesCollection.findMany({ where: { opportunityId: { in: dealIds }, status: "APPROVED" }, select: { opportunityId: true, amountGross: true } })
    : [];
  const b = outstandingBalance(
    accepted.map((q) => ({ opportunityId: q.opportunityId, grandTotal: new Decimal(q.grandTotal.toString()) })),
    approved.map((c) => ({ opportunityId: c.opportunityId ?? "", amountGross: new Decimal(c.amountGross.toString()) })),
  );
  const ar = await arBalanceOwed(db, customerId, canReadInvoices, now);
  return {
    outstanding: b.outstanding.toFixed(2), documents: b.documents, openDocuments: b.openDocuments, currency: "SAR",
    basis: "ACCEPTED_NOT_INVOICED",
    ar: ar ? { outstanding: ar.toFixed(2), basis: "RECEIVABLES" } : null,
  };
}
