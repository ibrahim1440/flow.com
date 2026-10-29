// Sales invoicing A2 — the ledger postings of the sales documents and receipts, through the A1 posting engine
// only (postEntry / reverseEntry, by role, inside the operational transaction, idempotent per source event, a
// no-op before activation and go-live). docs/accounting/POSTING-CONTRACT.md §1.2 and §4 list the same tables.
//
//   sales · SALES_INVOICE · ISSUED          Dr AR (party) gross            / Cr SALES_REVENUE (item) net per line, Cr VAT_OUTPUT VAT
//   sales · DEBIT_NOTE    · ISSUED          the same as an invoice
//   sales · CREDIT_NOTE   · ISSUED          Dr SALES_RETURNS net per line, Dr VAT_OUTPUT VAT / Cr AR (party) gross
//   «بيع أصل ثابت» line (WP-F)              its net Cr FA_DISPOSAL_CLEARING instead of SALES_REVENUE (a credit note on it: Dr)
//   sales · COLLECTION    · RECEIVED        Dr the deposit account (WP-D) | CASH | BANK | CARD_CLEARING amount / Cr AR (party) applied at receipt, Cr CUSTOMER_ADVANCES (party) rest
//   sales · COLLECTION    · APPLIED.<appId> Dr CUSTOMER_ADVANCES (party) / Cr AR (party)            — a later application of a posted receipt
//   sales · COLLECTION    · UNAPPLIED.<appId> Dr AR / Cr CUSTOMER_ADVANCES                         — undoing an application made at receipt
//   receipt reversed                        reverseEntry of every still-posted entry of the receipt (RECEIVED, APPLIED, UNAPPLIED)
// The VAT line is the document's E-10 VAT (one figure per document, rounded per category on the total), so the
// ledger equals the invoice totals ZATCA will see. COGS is NOT posted here: inventory · DELIVERY · COGS belongs to
// A3, at delivery (COGS_HOOK below names it).
import type { Prisma } from "@/generated/prisma/client";
import { postEntry, reverseEntry, type PostEntryResult, type PostingLineInput } from "@/lib/accounting/posting-engine";
import { Decimal, ZERO } from "@/lib/accounting/money";

type Tx = Prisma.TransactionClient;

/** A3 hook (not posted by A2): the cost of goods shipped is posted with the delivery, by the inventory module. */
export const COGS_HOOK = { module: "inventory", type: "DELIVERY", event: "COGS", owner: "A3" } as const;

export const INVOICE_SOURCE_TYPE = { INVOICE: "SALES_INVOICE", CREDIT_NOTE: "CREDIT_NOTE", DEBIT_NOTE: "DEBIT_NOTE" } as const;

type DocForPosting = {
  id: string; kind: "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE"; number: string; customerId: string; issueDate: string;
  /** «الموقع»: the document's location, stamped on every line of its entry. */
  branchId?: string | null;
  grandTotal: Decimal; taxTotal: Decimal;
  /** `clearing`: a «بيع أصل ثابت» line (or a credit note's line on one): its net posts to FA_DISPOSAL_CLEARING. */
  lines: { lineNet: Decimal; productSkuId: string | null; description: string; clearing?: boolean }[];
};

/** The lines of a document's entry (pure). Lines without an amount are dropped; same-SKU lines are merged. */
export function documentEntryLines(doc: DocForPosting, existingSkus: Set<string>): PostingLineInput[] {
  const party = { type: "CUSTOMER" as const, id: doc.customerId };
  const credit = doc.kind === "CREDIT_NOTE";
  const revenueRole = credit ? "SALES_RETURNS" : "SALES_REVENUE";
  const bySku = new Map<string, { amount: Decimal; sku: string | null; description: string }>();
  const clearing: PostingLineInput[] = [];
  for (const l of doc.lines) {
    if (l.lineNet.lessThanOrEqualTo(0)) continue;
    if (l.clearing) {
      // BATCH 22 WP-F: an asset sale is not revenue (IAS 16.68) — the line net waits in the clearing account until the
      // register's disposal debits it and books the gain or loss against the net book value.
      clearing.push({ role: "FA_DISPOSAL_CLEARING", ...(credit ? { debit: l.lineNet } : { credit: l.lineNet }), description: l.description.slice(0, 200), dims: { party } });
      continue;
    }
    const sku = l.productSkuId && existingSkus.has(l.productSkuId) ? l.productSkuId : null;
    const key = sku ?? `line:${bySku.size}`;
    const cur = bySku.get(key) ?? { amount: ZERO, sku, description: l.description };
    cur.amount = cur.amount.plus(l.lineNet);
    bySku.set(key, cur);
  }
  const revenue: PostingLineInput[] = [...bySku.values()].map((r) => ({
    role: revenueRole, ...(credit ? { debit: r.amount } : { credit: r.amount }),
    description: r.description.slice(0, 200),
    dims: { party, ...(r.sku ? { item: { type: "PRODUCT_SKU" as const, id: r.sku } } : {}) },
  }));
  const vat: PostingLineInput[] = doc.taxTotal.greaterThan(0) ? [{ role: "VAT_OUTPUT", ...(credit ? { debit: doc.taxTotal } : { credit: doc.taxTotal }), dims: { party } }] : [];
  const ar: PostingLineInput = { role: "AR", ...(credit ? { credit: doc.grandTotal } : { debit: doc.grandTotal }), dims: { party } };
  return credit ? [...revenue, ...clearing, ...vat, ar] : [ar, ...revenue, ...clearing, ...vat];
}

export async function postDocumentIssued(tx: Tx, doc: DocForPosting, actorId: string): Promise<PostEntryResult> {
  const skuIds = [...new Set(doc.lines.map((l) => l.productSkuId).filter((x): x is string => !!x))];
  const existing = skuIds.length ? new Set((await tx.productSKU.findMany({ where: { id: { in: skuIds } }, select: { id: true } })).map((s) => s.id)) : new Set<string>();
  const memo = { INVOICE: "فاتورة ضريبية", CREDIT_NOTE: "إشعار دائن", DEBIT_NOTE: "إشعار مدين" }[doc.kind];
  return postEntry(tx, {
    source: { module: "sales", type: INVOICE_SOURCE_TYPE[doc.kind], id: doc.id, event: "ISSUED" },
    date: doc.issueDate,
    memo: `${memo} ${doc.number}`,
    createdBy: actorId,
    defaultBranchId: doc.branchId ?? null,
    lines: documentEntryLines(doc, existing),
  });
}

/** The cash-side role of a receipt by its method. */
export function receiptRole(method: string): "CASH" | "BANK" | "CARD_CLEARING" {
  if (method === "CASH") return "CASH";
  if (method === "POS_CARD") return "CARD_CLEARING";
  return "BANK";
}

export function receiptEntryLines(r: { amount: Decimal; appliedAtReceipt: Decimal; method: string; customerId: string; depositAccountId?: string | null }): PostingLineInput[] {
  const party = { type: "CUSTOMER" as const, id: r.customerId };
  const rest = r.amount.minus(r.appliedAtReceipt);
  // «سند قبض» (BATCH22 WP-D): the deposit account the accountant chose at confirmation, else the method's role account.
  const cash: PostingLineInput = r.depositAccountId ? { accountId: r.depositAccountId, debit: r.amount, dims: { party } } : { role: receiptRole(r.method), debit: r.amount, dims: { party } };
  return [
    cash,
    ...(r.appliedAtReceipt.greaterThan(0) ? [{ role: "AR", credit: r.appliedAtReceipt, dims: { party } }] : []),
    ...(rest.greaterThan(0) ? [{ role: "CUSTOMER_ADVANCES", credit: rest, dims: { party } }] : []),
  ];
}

export async function postReceiptReceived(tx: Tx, r: { collectionId: string; amount: Decimal; appliedAtReceipt: Decimal; method: string; depositAccountId?: string | null; customerId: string; date: string; ref: string; memo?: string | null; sodBypass?: boolean; branchId?: string | null }, actorId: string) {
  return postEntry(tx, {
    defaultBranchId: r.branchId ?? null,
    source: { module: "sales", type: "COLLECTION", id: r.collectionId, event: "RECEIVED" },
    date: r.date, memo: `${r.ref.startsWith("RCT-") ? "سند قبض" : "تحصيل من العميل"} ${r.ref}${r.memo ? ` — ${r.memo}` : ""}`.slice(0, 500), createdBy: actorId,
    ...(r.sodBypass ? { sodBypass: true } : {}),
    // A receipt dated in a closed month posts on the first day of the next open one (the memo keeps its date).
    whenPeriodNotOpen: "nextOpenPeriod",
    lines: receiptEntryLines(r),
  });
}

export async function postApplication(tx: Tx, a: { applicationId: string; collectionId: string; customerId: string; amount: Decimal; date: string; invoiceNumber: string; branchId?: string | null }, actorId: string, event: "APPLIED" | "UNAPPLIED") {
  const party = { type: "CUSTOMER" as const, id: a.customerId };
  const lines: PostingLineInput[] = event === "APPLIED"
    ? [{ role: "CUSTOMER_ADVANCES", debit: a.amount, dims: { party } }, { role: "AR", credit: a.amount, dims: { party } }]
    : [{ role: "AR", debit: a.amount, dims: { party } }, { role: "CUSTOMER_ADVANCES", credit: a.amount, dims: { party } }];
  return postEntry(tx, {
    source: { module: "sales", type: "COLLECTION", id: a.collectionId, event: `${event}.${a.applicationId}` },
    date: a.date,
    memo: `${event === "APPLIED" ? "تخصيص تحصيل على" : "إلغاء تخصيص تحصيل من"} ${a.invoiceNumber}`.slice(0, 500),
    createdBy: actorId, whenPeriodNotOpen: "nextOpenPeriod", lines, defaultBranchId: a.branchId ?? null,
  });
}

/** Has this source event been posted (an engine entry exists)? */
export async function postedEntry(tx: Tx, sourceType: string, sourceId: string, event: string) {
  return tx.journalEntry.findFirst({ where: { sourceModule: "sales", sourceType, sourceId, sourceEvent: event, idempotencyKey: { not: null } }, select: { id: true, status: true } });
}

/** Reverse every still-posted engine entry of a receipt (RECEIVED and every APPLIED / UNAPPLIED). */
export async function reverseReceiptEntries(tx: Tx, collectionId: string, reason: string, actorId: string): Promise<string[]> {
  const entries = await tx.journalEntry.findMany({
    where: { sourceModule: "sales", sourceType: "COLLECTION", sourceId: collectionId, status: "POSTED", type: { not: "REVERSAL" }, idempotencyKey: { not: null } },
    orderBy: { createdAt: "asc" }, select: { id: true },
  });
  const out: string[] = [];
  for (const e of entries) out.push((await reverseEntry(tx, { entryId: e.id, reason, actorId })).entryId);
  return out;
}
