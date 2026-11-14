// Readiness review P1-4: a deal's value follows its quotations. `Opportunity.amount` = the grand total of the deal's
// current ACCEPTED quotation (highest revision), else of its latest ISSUED one, PLUS its live direct orders («طلب مباشر»,
// the snapshot on each quotation-less link of an order that is not Cancelled / Rejected) — the same figures
// collections.ts `collectionSummary` collects against.
//
// Soon batch round 2 (owner decision, B): a deal whose quotations were all REJECTED or EXPIRED (none ACCEPTED or
// ISSUED) is worth 0.00 plus its live direct orders — the rejected offer is not pipeline value. Nothing is lost: the
// deal page and card read «آخر عرض مرفوض: X ⃁» from the Quote table (lastClosedQuote), the deal's activity log gets
// an entry (decideQuote → noteQuoteClosed), and a new ISSUED revision refills the amount on its own. A deal with no
// quotation at all and no direct order keeps the amount typed by hand.
//
// Called after a quotation is issued, accepted / rejected / expired or revised, and after a direct order joins or
// leaves a deal; the migration 20261220090000_soon_batch backfills existing deals with the same rule.
import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient;
const DEAD = ["Cancelled", "Rejected"];
const CLOSED = ["REJECTED", "EXPIRED"] as const;
const cents = (v: { toString(): string } | null | undefined) => Math.round(Number(v?.toString() ?? 0) * 100);

/** Pure: the deal's amount from its figures (halalas in, "0.00" out), or null to keep the typed amount. */
export function dealAmountFrom(f: { live: number | null; direct: number[]; closedQuotes: number }): string | null {
  if (f.live === null && f.direct.length === 0 && f.closedQuotes === 0) return null;
  const total = (f.live ?? 0) + f.direct.reduce((t, x) => t + x, 0);
  return (total / 100).toFixed(2);
}

export async function syncDealAmount(tx: Tx, opportunityId: string | null | undefined): Promise<string | null> {
  if (!opportunityId) return null;
  const accepted = await tx.quote.findFirst({ where: { opportunityId, status: "ACCEPTED" }, orderBy: { revision: "desc" }, select: { grandTotal: true } });
  const quote = accepted ?? await tx.quote.findFirst({ where: { opportunityId, status: "ISSUED" }, orderBy: [{ issuedAt: "desc" }, { revision: "desc" }], select: { grandTotal: true } });
  const direct = await tx.opportunityOrder.findMany({
    where: { opportunityId, quoteId: null, directGross: { not: null }, order: { status: { notIn: DEAD } } },
    select: { directGross: true },
  });
  const closedQuotes = quote ? 0 : await tx.quote.count({ where: { opportunityId, status: { in: [...CLOSED] } } });
  const amount = dealAmountFrom({ live: quote ? cents(quote.grandTotal) : null, direct: direct.map((r) => cents(r.directGross)), closedQuotes });
  if (amount === null) return null;
  await tx.opportunity.update({ where: { id: opportunityId }, data: { amount } });
  return amount;
}

/** The deal of a quotation (null for «مسار المحاسب» quotations with no deal). */
export async function dealOfQuote(tx: Tx, quoteId: string): Promise<string | null> {
  return (await tx.quote.findUnique({ where: { id: quoteId }, select: { opportunityId: true } }))?.opportunityId ?? null;
}

export type ClosedQuote = { id: string; quoteNumber: string; revision: number; status: string; grandTotal: string; currency: string; at: string | null };

/**
 * «آخر عرض مرفوض»: the deal's latest REJECTED / EXPIRED quotation — shown while the deal has no ACCEPTED or ISSUED one
 * (null otherwise, and when there is none). Read from the Quote table, never stored on the deal.
 */
export async function lastClosedQuote(db: Pick<Tx, "quote">, opportunityId: string): Promise<ClosedQuote | null> {
  const live = await db.quote.count({ where: { opportunityId, status: { in: ["ACCEPTED", "ISSUED"] } } });
  if (live) return null;
  const q = await db.quote.findFirst({
    where: { opportunityId, status: { in: [...CLOSED] } },
    orderBy: [{ rejectedAt: { sort: "desc", nulls: "last" } }, { issuedAt: { sort: "desc", nulls: "last" } }, { revision: "desc" }],
    select: { id: true, quoteNumber: true, revision: true, status: true, grandTotal: true, currency: true, rejectedAt: true, validUntil: true },
  });
  if (!q) return null;
  return {
    id: q.id, quoteNumber: q.quoteNumber ?? "" /* closed: always numbered (Quote_number_issued_check) */, revision: q.revision, status: q.status, grandTotal: q.grandTotal.toFixed(2), currency: q.currency,
    at: (q.rejectedAt ?? q.validUntil)?.toISOString() ?? null,
  };
}

/** The same for many deals at once (the board and the lists): opportunityId → the closed quotation shown. */
export async function lastClosedQuotes(db: Pick<Tx, "quote">, opportunityIds: string[]): Promise<Map<string, { quoteNumber: string; grandTotal: string; status: string }>> {
  const out = new Map<string, { quoteNumber: string; grandTotal: string; status: string }>();
  if (!opportunityIds.length) return out;
  const rows = await db.quote.findMany({
    where: { opportunityId: { in: opportunityIds }, status: { in: ["ACCEPTED", "ISSUED", ...CLOSED] } },
    orderBy: [{ rejectedAt: { sort: "desc", nulls: "last" } }, { issuedAt: { sort: "desc", nulls: "last" } }, { revision: "desc" }],
    select: { opportunityId: true, status: true, quoteNumber: true, grandTotal: true },
  });
  const live = new Set(rows.filter((r) => r.status === "ACCEPTED" || r.status === "ISSUED").map((r) => r.opportunityId));
  for (const r of rows) {
    if (!r.opportunityId || live.has(r.opportunityId) || out.has(r.opportunityId)) continue;
    out.set(r.opportunityId, { quoteNumber: r.quoteNumber ?? "" /* issued or later: numbered */, grandTotal: r.grandTotal.toFixed(2), status: r.status });
  }
  return out;
}

/**
 * The deal's activity log after a quotation was rejected or expired and the deal was left without a live one: what was
 * offered, and what the deal is now worth. Once per quotation (sourceKey deal-quote-closed:<quoteId>); a system record
 * (never edited — /api/sales/activities/[id]).
 */
export async function noteQuoteClosed(tx: Tx, input: { quoteId: string; actorId: string; at?: Date }): Promise<void> {
  const q = await tx.quote.findUnique({ where: { id: input.quoteId }, select: { opportunityId: true, quoteNumber: true, status: true, grandTotal: true, rejectionNote: true } });
  if (!q?.opportunityId || !(CLOSED as readonly string[]).includes(q.status)) return;
  const live = await tx.quote.count({ where: { opportunityId: q.opportunityId, status: { in: ["ACCEPTED", "ISSUED"] } } });
  if (live) return;
  const key = `deal-quote-closed:${input.quoteId}`;
  if (await tx.activity.findFirst({ where: { sourceKey: key }, select: { id: true } })) return;
  const deal = await tx.opportunity.findUnique({ where: { id: q.opportunityId }, select: { amount: true } });
  const word = q.status === "REJECTED" ? "رُفض" : "انتهت صلاحية";
  await tx.activity.create({
    data: {
      type: "NOTE", opportunityId: q.opportunityId, ownerId: input.actorId, completedAt: input.at ?? new Date(), sourceKey: key,
      subject: `${word} عرض السعر ${q.quoteNumber} (${q.grandTotal.toFixed(2)} ⃁)`,
      body: `قيمة الصفقة صارت ${deal?.amount?.toFixed(2) ?? "0.00"} ⃁ — لا عرض سعر قائم.${q.rejectionNote ? `\nسبب الرفض: ${q.rejectionNote}` : ""}`,
    },
  });
}

/**
 * Lost-deal reporting (soon batch round 2): a deal lost after its quotation was rejected / expired is worth 0.00 on the
 * board, but what was LOST is the offer — its value is the last quotation's grand total. Every other deal keeps its
 * amount. Returns the rows with `amount` replaced where that applies.
 */
export async function withLostQuoteValue<T extends { id: string; amount: { toString(): string } }>(db: Pick<Tx, "quote">, rows: T[]): Promise<T[]> {
  const closed = await lastClosedQuotes(db, rows.map((r) => r.id));
  // Decimal arithmetic downstream accepts the decimal string (`a.plus("1150.00")`).
  return rows.map((r) => { const c = closed.get(r.id); return c ? { ...r, amount: c.grandTotal as unknown as T["amount"] } : r; });
}

/**
 * P2 SUSP-05 (owner decision أ): «صفقات كسبتها» on the performance dashboard is BEFORE VAT, like every other figure there.
 * `Opportunity.amount` is VAT-inclusive (a quotation's grand total, a direct sale's gross), so the won value is rebuilt by
 * the same rule as syncDealAmount, on net figures:
 *   the ACCEPTED quotation (highest revision), else the latest ISSUED one → its grand total − its tax total;
 *   + each live direct order of the deal → its invoices' taxable total (not cancelled), else its stored gross when no
 *     invoice exists yet (rare: the order was not invoiced) its stored gross − its stored tax (gate B3);
 *   a deal with neither keeps its typed amount (a hand-typed expected value carries no VAT breakdown).
 * Returns opportunityId → net (a decimal string).
 */
export async function dealNetValues(db: Pick<Tx, "quote" | "opportunityOrder" | "salesInvoice">, rows: { id: string; amount: { toString(): string } }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rows.length) return out;
  const ids = rows.map((r) => r.id);
  const quotes = await db.quote.findMany({
    where: { opportunityId: { in: ids }, status: { in: ["ACCEPTED", "ISSUED"] } },
    orderBy: [{ revision: "desc" }],
    select: { opportunityId: true, status: true, revision: true, issuedAt: true, grandTotal: true, taxTotal: true },
  });
  const direct = await db.opportunityOrder.findMany({
    where: { opportunityId: { in: ids }, quoteId: null, directGross: { not: null }, order: { status: { notIn: DEAD } } },
    select: { opportunityId: true, orderId: true, directGross: true, directTax: true },
  });
  const invoices = direct.length ? await db.salesInvoice.findMany({
    where: { orderId: { in: direct.map((d) => d.orderId) }, kind: "INVOICE", status: { not: "CANCELLED" } },
    select: { orderId: true, taxableTotal: true },
  }) : [];
  for (const r of rows) {
    const qs = quotes.filter((q) => q.opportunityId === r.id);
    const accepted = qs.filter((q) => q.status === "ACCEPTED").sort((a, b) => b.revision - a.revision)[0];
    const issued = qs.filter((q) => q.status === "ISSUED").sort((a, b) => (b.issuedAt?.getTime() ?? 0) - (a.issuedAt?.getTime() ?? 0) || b.revision - a.revision)[0];
    const q = accepted ?? issued;
    const ds = direct.filter((d) => d.opportunityId === r.id);
    if (!q && !ds.length) { out.set(r.id, (cents(r.amount) / 100).toFixed(2)); continue; }
    let total = q ? cents(q.grandTotal) - cents(q.taxTotal) : 0;
    for (const d of ds) {
      const inv = invoices.filter((i) => i.orderId === d.orderId);
      // Gate B3: no invoice yet → the stored gross LESS its stored tax (before VAT, like every other figure here).
      total += inv.length ? inv.reduce((t, i) => t + cents(i.taxableTotal), 0) : cents(d.directGross) - cents(d.directTax ?? 0);
    }
    out.set(r.id, (total / 100).toFixed(2));
  }
  return out;
}
