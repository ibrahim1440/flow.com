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
import { prisma } from "@/lib/db";
import { postEntry, reverseEntry, type PostEntryResult, type PostingLineInput } from "@/lib/accounting/posting-engine";
import { Decimal, ZERO } from "@/lib/accounting/money";
import { documentSalesActivity, salesRuleContext, type LineRuling } from "@/lib/accounting/sales-account-rules";
export { documentSalesActivity };

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
  /** `salesCategoryId`: the line's own sales category; `decided`: the general account by a recorded decision. */
  lines: { lineNet: Decimal; productSkuId: string | null; description: string; clearing?: boolean; salesCategoryId?: string | null; decided?: boolean; /** The activity a recorded decision was made for: it holds only while the document is still posted under it. */ decidedFor?: string | null }[];
};

/** What only the database knows about a document when it is posted: its channel, its sales activity and what the activity's rules give each line. */
export type DocPostingContext = { channel?: string | null; salesActivity?: string | null; rule?: (l: { skuId: string | null; categoryId: string | null }) => LineRuling };

/**
 * The lines of a document's entry (pure). Lines without an amount are dropped; lines of the same SKU and category are
 * merged. Revenue of an invoice or a debit note goes to the account the document's sales activity rules give the line
 * (its SKU's rule, else its category's — the line's own category or its SKU's product's — else the activity's), else
 * to SALES_REVENUE; a credit note always goes to SALES_RETURNS. Each revenue / returns line carries the channel, the
 * activity, the category and how its account was chosen — snapshots, written with the line. A line sent to a general
 * account by a recorded decision says so (ACTIVITY_DECISION / ROLE_DECISION).
 */
export function documentEntryLines(doc: DocForPosting, existingSkus: Set<string>, ctx: DocPostingContext = {}): PostingLineInput[] {
  const party = { type: "CUSTOMER" as const, id: doc.customerId };
  const credit = doc.kind === "CREDIT_NOTE";
  const revenueRole = credit ? "SALES_RETURNS" : "SALES_REVENUE";
  const groups = new Map<string, { amount: Decimal; sku: string | null; category: string | null; decided: boolean; description: string }>();
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
    const category = l.salesCategoryId ?? null;
    const key = sku ? `${sku}|${category ?? ""}|${l.decided ? 1 : 0}` : `line:${groups.size}`;
    const cur = groups.get(key) ?? { amount: ZERO, sku, category, decided: !!l.decided, description: l.description };
    cur.amount = cur.amount.plus(l.lineNet);
    groups.set(key, cur);
  }
  const channel = ctx.channel ?? null;
  const activity = ctx.salesActivity ?? null;
  const revenue: PostingLineInput[] = [...groups.values()].map((r) => {
    const ruling = ctx.rule?.({ skuId: r.sku, categoryId: r.category }) ?? null;
    const own = !credit ? ruling?.revenue ?? null : null;
    const byDecision = !credit && r.decided && !!ruling?.revenueUnmapped;
    const basis = own ? (byDecision ? "ACTIVITY_DECISION" as const : own.basis) : byDecision ? "ROLE_DECISION" as const : "ROLE" as const;
    const categoryId = ruling?.categoryId ?? r.category;
    return {
      ...(own ? { accountId: own.accountId } : { role: revenueRole }), accountBasis: basis,
      ...(categoryId ? { salesCategoryId: categoryId } : {}),
      ...(credit ? { debit: r.amount } : { credit: r.amount }),
      description: r.description.slice(0, 200),
      dims: { party, ...(r.sku ? { item: { type: "PRODUCT_SKU" as const, id: r.sku } } : {}), ...(channel ? { channel } : {}), ...(activity ? { salesActivity: activity } : {}) },
    };
  });
  const vat: PostingLineInput[] = doc.taxTotal.greaterThan(0) ? [{ role: "VAT_OUTPUT", ...(credit ? { debit: doc.taxTotal } : { credit: doc.taxTotal }), dims: { party } }] : [];
  const ar: PostingLineInput = { role: "AR", ...(credit ? { credit: doc.grandTotal } : { debit: doc.grandTotal }), dims: { party } };
  return credit ? [...revenue, ...clearing, ...vat, ar] : [ar, ...revenue, ...clearing, ...vat];
}

export async function postDocumentIssued(tx: Tx, doc: DocForPosting, actorId: string): Promise<PostEntryResult> {
  const skuIds = [...new Set(doc.lines.map((l) => l.productSkuId).filter((x): x is string => !!x))];
  const existing = skuIds.length ? new Set((await tx.productSKU.findMany({ where: { id: { in: skuIds } }, select: { id: true } })).map((s) => s.id)) : new Set<string>();
  const memo = { INVOICE: "فاتورة ضريبية", CREDIT_NOTE: "إشعار دائن", DEBIT_NOTE: "إشعار مدين" }[doc.kind];
  const channel = await documentChannel(tx, doc.id);
  const salesActivity = await documentSalesActivity(tx, doc.id);
  const rules = await salesRuleContext(tx, { activity: salesActivity, skuIds });
  return postEntry(tx, {
    source: { module: "sales", type: INVOICE_SOURCE_TYPE[doc.kind], id: doc.id, event: "ISSUED" },
    date: doc.issueDate,
    memo: `${memo} ${doc.number}`,
    createdBy: actorId,
    defaultBranchId: doc.branchId ?? null,
    lines: documentEntryLines({ ...doc, lines: doc.lines.map((l) => ({ ...l, decided: !!l.decidedFor && l.decidedFor === salesActivity })) }, existing, { channel, salesActivity, rule: rules.forLine }),
  });
}

const CHANNEL_RE = /^[A-Z0-9_]{1,20}$/;
/**
 * The sales channel a document is posted with: a note takes the channel its ORIGINAL was posted with (the snapshot on
 * the original's revenue lines), so a return lands in the channel of its sale; otherwise the document's own channel,
 * else its order's. Null when none is recorded (the line then carries no channel — never a guess).
 */
export async function documentChannel(tx: Tx, invoiceId: string): Promise<string | null> {
  const doc = await tx.salesInvoice.findUnique({ where: { id: invoiceId }, select: { channel: true, orderId: true, originalInvoiceId: true } });
  if (!doc) return null;
  if (doc.originalInvoiceId) {
    const posted = await tx.journalEntryLine.findFirst({ where: { channel: { not: null }, journalEntry: { sourceType: "SALES_INVOICE", sourceId: doc.originalInvoiceId, sourceEvent: "ISSUED" } }, select: { channel: true } });
    if (posted?.channel) return posted.channel;
    const orig = await tx.salesInvoice.findUnique({ where: { id: doc.originalInvoiceId }, select: { channel: true, orderId: true } });
    if (orig) return ownChannel(tx, orig);
  }
  return ownChannel(tx, doc);
}
async function ownChannel(tx: Tx, d: { channel: string | null; orderId: string | null }): Promise<string | null> {
  const c = d.channel ?? (d.orderId ? (await tx.order.findUnique({ where: { id: d.orderId }, select: { channel: true } }))?.channel ?? null : null);
  return c && CHANNEL_RE.test(c) ? c : null;
}

export type UnmappedLine = { lineId: string; position: number; description: string; lineNet: string; productSkuId: string | null; salesCategoryId: string | null; reasonAr: string; reasonEn: string };

/**
 * The revenue lines of a document that no rule of their SKU or category covers in the document's sales activity, and
 * that carry no recorded decision: what is shown for review before the document is issued. A document with no
 * recorded activity has none (it posts to the general accounts as before); a credit note has none (sales returns).
 */
export async function unmappedRevenueLines(tx: Tx, invoiceId: string): Promise<UnmappedLine[]> {
  const doc = await tx.salesInvoice.findUnique({ where: { id: invoiceId }, select: { kind: true, lines: { orderBy: { position: "asc" }, select: { id: true, position: true, description: true, lineNet: true, productSkuId: true, salesCategoryId: true, kind: true, generalAccountAt: true, generalAccountActivity: true, originalLine: { select: { kind: true } } } } } });
  if (!doc || doc.kind === "CREDIT_NOTE") return [];
  const activity = await documentSalesActivity(tx, invoiceId);
  if (!activity) return [];
  const rules = await salesRuleContext(tx, { activity, skuIds: doc.lines.map((l) => l.productSkuId) });
  const out: UnmappedLine[] = [];
  for (const l of doc.lines) {
    if (l.kind === "FIXED_ASSET_SALE" || l.originalLine?.kind === "FIXED_ASSET_SALE" || (l.generalAccountAt && l.generalAccountActivity === activity) || !new Decimal(l.lineNet).greaterThan(0)) continue;
    const r = rules.forLine({ skuId: l.productSkuId, categoryId: l.salesCategoryId });
    if (!r.revenueUnmapped) continue;
    const [reasonAr, reasonEn] = !r.categoryId ? ["البند بلا تصنيف مبيعات", "the line has no sales category"] : ["لا قاعدة لتصنيفه في هذا النشاط", "its category has no rule in this activity"];
    out.push({ lineId: l.id, position: l.position, description: l.description, lineNet: new Decimal(l.lineNet).toFixed(2), productSkuId: l.productSkuId, salesCategoryId: r.categoryId, reasonAr, reasonEn });
  }
  return out;
}

/** The review list: every DRAFT invoice / debit note posted under a sales activity that has unmapped revenue lines. */
export async function unmappedDraftLines() {
  const drafts = await prisma.salesInvoice.findMany({ where: { status: "DRAFT", kind: { in: ["INVOICE", "DEBIT_NOTE"] } }, orderBy: { createdAt: "desc" }, take: 300, select: { id: true, kind: true, createdAt: true, customerId: true, orderId: true } });
  const out: { invoiceId: string; kind: string; createdAt: Date; customerId: string; orderId: string | null; activity: string | null; lines: UnmappedLine[] }[] = [];
  for (const d of drafts) {
    const res = await prisma.$transaction(async (tx) => ({ lines: await unmappedRevenueLines(tx, d.id), activity: await documentSalesActivity(tx, d.id) }));
    if (res.lines.length) out.push({ invoiceId: d.id, kind: d.kind, createdAt: d.createdAt, customerId: d.customerId, orderId: d.orderId, activity: res.activity, lines: res.lines });
  }
  const customers = out.length ? await prisma.customer.findMany({ where: { id: { in: [...new Set(out.map((o) => o.customerId))] } }, select: { id: true, name: true, nameAr: true } }) : [];
  const orders = out.some((o) => o.orderId) ? await prisma.order.findMany({ where: { id: { in: out.map((o) => o.orderId).filter((x): x is string => !!x) } }, select: { id: true, orderNumber: true } }) : [];
  return out.map((o) => { const c = customers.find((x) => x.id === o.customerId); return { ...o, customer: c?.nameAr || c?.name || "", orderNumber: orders.find((x) => x.id === o.orderId)?.orderNumber ?? null }; });
}

/** The cash-side role of a receipt by its method. */
export function receiptRole(method: string): "CASH" | "BANK" | "CARD_CLEARING" {
  if (method === "CASH") return "CASH";
  if (method === "POS_CARD") return "CARD_CLEARING";
  return "BANK";
}

/**
 * The RECEIVED entry: Dr the deposit account; Cr AR for what the receipt settles now — the invoices it was applied to
 * at approval plus `toOpening`, the part that pays the customer's opening balance (./ar.ts) — and Cr customer
 * advances for the rest.
 */
export function receiptEntryLines(r: { amount: Decimal; appliedAtReceipt: Decimal; toOpening?: Decimal; method: string; customerId: string; depositAccountId?: string | null }): PostingLineInput[] {
  const party = { type: "CUSTOMER" as const, id: r.customerId };
  const toAr = r.appliedAtReceipt.plus(r.toOpening ?? 0);
  const rest = r.amount.minus(toAr);
  // «سند قبض» (BATCH22 WP-D): the deposit account the accountant chose at confirmation, else the method's role account.
  const cash: PostingLineInput = r.depositAccountId ? { accountId: r.depositAccountId, debit: r.amount, dims: { party } } : { role: receiptRole(r.method), debit: r.amount, dims: { party } };
  return [
    cash,
    ...(toAr.greaterThan(0) ? [{ role: "AR", credit: toAr, dims: { party } }] : []),
    ...(rest.greaterThan(0) ? [{ role: "CUSTOMER_ADVANCES", credit: rest, dims: { party } }] : []),
  ];
}

export async function postReceiptReceived(tx: Tx, r: { collectionId: string; amount: Decimal; appliedAtReceipt: Decimal; toOpening?: Decimal; method: string; depositAccountId?: string | null; customerId: string; date: string; ref: string; memo?: string | null; sodBypass?: boolean; branchId?: string | null }, actorId: string) {
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
