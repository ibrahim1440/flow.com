// «بيع مباشر» (D10, owner-approved design 6 Nov 2026) — the customer buys now, without a quotation.
//
// ONE server transaction composes the existing services, nothing re-implemented:
//   1. the order               createOrderWithNumber (create-order.ts) — SKU lines, whole units, credit hold, numbering lock
//   2. the deal                linkDirectOrderDeal (direct-order-deal.ts) — the customer's newest open deal, else one opened
//                              for the order (WON); a linked OPEN deal is then WON here (owner decision D1)
//   3. the invoice DRAFT        draftFromOrderIn (invoicing/service.ts) — the catalogue price, VAT on the server
//   4. the invoice request      requestInvoiceIn (invoicing/requests.ts) — the accountant's queue; they issue it for ZATCA
//   5. an audit row             DIRECT_SALE_CREATED
// Preparation runs after the commit, as for every order (POST /api/orders).
//
// Idempotent through the client's requestKey: the invoice draft carries `direct-sale:<key>` (SalesInvoice.requestKey is
// unique) and a transaction-scoped advisory lock on the key serialises two taps, so the second waits for the first and
// replays it — never two orders, never two invoices. No migration: every column used exists.
//
// Prices are never taken from the client: the SKU's catalogue price × the ordered units, VAT at the standard rate, the
// same arithmetic the deal snapshot (priceDirectOrder) and the invoice draft (priceInvoice) use.
//
// Scope (owner decisions D3 / 5): a scoped rep sells only to a customer in their own book that HAS an account owner. A
// pool customer is the supervisor's: hidden from the rep's list and refused like any customer outside the book (404),
// even with orders › unassigned_customers — a direct sale opens a deal and an invoice, which that order deliberately does not.
import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { audit } from "@/lib/hr/core";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { emitAutomationEvent } from "@/lib/automation/emit";
import { resolveOrderLines, createOrderWithNumber, type RawOrderLine } from "@/lib/services/orders/create-order";
import { autoPrepareOrder } from "@/lib/services/orders/preparation";
import { draftFromOrderIn } from "@/lib/services/invoicing/service";
import { requestInvoiceIn } from "@/lib/services/invoicing/requests";
import { DEFAULT_VAT_RATE } from "@/lib/services/invoicing/pricing";
import { linkDirectOrderDeal, priceDirectOrder } from "./direct-order-deal";
import { winOnAcceptedQuote } from "./lifecycle";
import { submitCollection } from "./collections";
import { syncDealAmount } from "./deal-amount";
import { DISCOUNT_MAX } from "./discount-limits";
import { discountThreshold } from "./quote-settings";
import { notify } from "@/lib/notifications/notify";
import { isSimpleMode } from "@/lib/simple-mode";
import { appendOrderActivity, lockOrderLifecycleResources } from "@/lib/services/order-operations";
import { assertSalesAllowed } from "@/lib/services/customers/credit-db";
import { customerInScope } from "./customer-access";
import { customersScopedToOwner, ownedCustomerWhere, seesAllSales } from "./scope";
import { hasTerms, mayOverrideTax, parseHeader, priceTerms, termsApproval, type SaleTerms } from "./direct-sale-terms";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export const DIRECT_SALE_WIN_REASON = "تلقائي: بيع مباشر";
/** Namespace of the per-key advisory lock (beside 7761 production, 7763 roasting, 7764 order numbers). */
const DIRECT_SALE_LOCK_NAMESPACE = 7771;
export const MAX_DIRECT_SALE_LINES = 50;

export type DirectSaleActor = { id: string; name: string; role?: string | null; permissions: Permissions | Record<string, unknown> };

const r2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const refuse = (status: number, code: string, ar: string, en: string, extra: Record<string, unknown> = {}) =>
  ({ _appCode: status, code, message: ar, errorAr: ar, error: ar, errorEn: en, ...extra });

/** `direct-sale:<key>` — the invoice draft's request key. The client key: 8–100 of [A-Za-z0-9_-] (a UUID fits). */
export function directSaleRequestKey(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(raw)) {
    throw refuse(400, "REQUEST_KEY_REQUIRED", "مفتاح الطلب ناقص أو غير صالح.", "requestKey is missing or invalid.");
  }
  return `direct-sale:${raw}`;
}

/** Merge repeated SKUs and refuse anything that is not a whole positive number of one SKU. Pure. */
export function normaliseLines(raw: unknown): { productSkuId: string; quantityUnits: number }[] {
  if (!Array.isArray(raw) || raw.length === 0) throw refuse(400, "NO_LINES", "أضف صنف واحد على الأقل.", "Add at least one item.");
  if (raw.length > MAX_DIRECT_SALE_LINES) throw refuse(400, "TOO_MANY_LINES", `الحد ${MAX_DIRECT_SALE_LINES} صنف.`, `At most ${MAX_DIRECT_SALE_LINES} items.`);
  const byId = new Map<string, number>();
  for (const l of raw as RawOrderLine[]) {
    const id = typeof l?.productSkuId === "string" ? l.productSkuId.trim() : "";
    const units = Number(l?.quantityUnits);
    if (!id) throw refuse(400, "LINE_INVALID", "اختر الصنف.", "Choose the product.");
    if (!Number.isInteger(units) || units <= 0 || units > 100000) throw refuse(400, "QTY_INVALID", "الكمية لازم رقم صحيح أكبر من صفر.", "Quantity must be a whole number above zero.");
    byId.set(id, (byId.get(id) ?? 0) + units);
  }
  return [...byId].map(([productSkuId, quantityUnits]) => ({ productSkuId, quantityUnits }));
}

export const PAYMENT_CHOICES = ["CASH", "CARD", "BANK_TRANSFER", "CREDIT"] as const;
export type PaymentChoice = (typeof PAYMENT_CHOICES)[number];
/** The collection's method for a paid-now choice (D20: «تحويل بنكي» — owner decision, option 2, the receipt optional). */
export const collectionMethodOf = (m: Exclude<PaymentChoice, "CREDIT">) => (m === "CASH" ? "CASH" : m === "CARD" ? "POS_CARD" : "BANK_TRANSFER") as "CASH" | "POS_CARD" | "BANK_TRANSFER";
/** «كاش» / «شبكة» / «تحويل بنكي» / «آجل» — the order's activity line. */
export const paymentLabelAr = (m: PaymentChoice) => (m === "CASH" ? "كاش" : m === "CARD" ? "شبكة" : m === "BANK_TRANSFER" ? "تحويل بنكي" : "آجل");
/** The transfer's reference (optional, D20): trimmed, at most 100 characters; only kept for a bank transfer. */
export function parseTransferReference(raw: unknown, method: PaymentChoice): string | null {
  if (method !== "BANK_TRANSFER" || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  if (t.length > 100) throw refuse(400, "REFERENCE_TOO_LONG", "رقم الحوالة طويل — اكتب 100 حرف بالكثير.", "The transfer reference may not exceed 100 characters.");
  return t;
}

/** The sale's discount, % of every line (0 – DISCOUNT_MAX, 2 dp). Pure. Above the quotation threshold (configurable,
 *  quote-settings.ts) it needs sales › quote_approve_discount: without it the sale WAITS for a supervisor (owner decision,
 *  6 Nov 2026: «تشتغل مثل عرض السعر») — `needsApproval`. */
export function parseDiscount(raw: unknown, threshold: Prisma.Decimal, mayApprove: boolean): { percent: Prisma.Decimal; needsApproval: boolean } {
  if (raw === undefined || raw === null || raw === "") return { percent: new Prisma.Decimal(0), needsApproval: false };
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) throw refuse(400, "DISCOUNT_INVALID", "الخصم لازم رقم من 0 وفوق.", "The discount must be a number of 0 or more.");
  const d = new Prisma.Decimal(n.toFixed(2));
  if (d.greaterThan(DISCOUNT_MAX)) throw refuse(400, "DISCOUNT_TOO_HIGH", `أعلى خصم ${DISCOUNT_MAX}٪ — صحّح السعر بدل الخصم.`, `The discount may not exceed ${DISCOUNT_MAX}%.`);
  return { percent: d, needsApproval: d.greaterThan(threshold) && !mayApprove };
}

export type DirectSaleQuote = {
  lines: { productSkuId: string; skuCode: string; name: string; unitPrice: string; quantityUnits: number; lineGross: string; lineNet: string }[];
  subtotal: string; discountPercent: string; discount: string; net: string; vatPercent: string; tax: string; gross: string;
  threshold: number; max: number;
};

/**
 * The server's price of a direct sale — what step 2 shows and what «إرسال» commits. Active SKUs with a catalogue price
 * only; a SKU without one is refused (NO_PRICE) rather than sold at zero.
 */
export async function priceDirectSale(db: Db, raw: unknown, discountPercent: Prisma.Decimal = new Prisma.Decimal(0)): Promise<DirectSaleQuote> {
  const lines = normaliseLines(raw);
  const skus = await db.productSKU.findMany({
    where: { id: { in: lines.map((l) => l.productSkuId) } },
    select: { id: true, skuCode: true, name: true, nameAr: true, price: true, isActive: true, product: { select: { productNameAr: true, productNameEn: true } } },
  });
  const byId = new Map(skus.map((s) => [s.id, s]));
  const out: DirectSaleQuote["lines"] = [];
  for (const l of lines) {
    const s = byId.get(l.productSkuId);
    if (!s || !s.isActive) throw refuse(400, "SKU_UNAVAILABLE", "صنف غير متاح للبيع.", "A product is not available for sale.", { productSkuId: l.productSkuId });
    if (!(s.price > 0)) throw refuse(409, "NO_PRICE", `«${s.nameAr || s.name || s.skuCode}» ما له سعر في قائمة الأسعار.`, `"${s.skuCode}" has no list price.`, { productSkuId: l.productSkuId });
    const unit = new Prisma.Decimal(s.price.toFixed(2));
    // The invoice line's arithmetic (pricing.ts priceInvoiceLine): gross, less the discount rounded per line.
    const gross = r2(unit.times(l.quantityUnits));
    const net = gross.minus(r2(gross.times(discountPercent).dividedBy(100)));
    out.push({
      productSkuId: s.id, skuCode: s.skuCode, name: s.nameAr || s.name || s.product.productNameAr || s.product.productNameEn,
      unitPrice: unit.toFixed(2), quantityUnits: l.quantityUnits, lineGross: gross.toFixed(2), lineNet: net.toFixed(2),
    });
  }
  const subtotal = out.reduce((t, l) => t.plus(l.lineGross), new Prisma.Decimal(0));
  const net = out.reduce((t, l) => t.plus(l.lineNet), new Prisma.Decimal(0));
  // VAT once on the taxable total (E-10, the invoice's rule) — equal to priceDirectOrder's when there is no discount.
  const tax = r2(net.times(DEFAULT_VAT_RATE).dividedBy(100));
  void priceDirectOrder;
  return {
    lines: out, subtotal: subtotal.toFixed(2), discountPercent: discountPercent.toFixed(2), discount: subtotal.minus(net).toFixed(2),
    net: net.toFixed(2), vatPercent: DEFAULT_VAT_RATE, tax: tax.toFixed(2), gross: net.plus(tax).toFixed(2),
    threshold: Number((await discountThreshold(db)).toString()), max: DISCOUNT_MAX,
  };
}

/** May this actor make a direct sale at all: take orders and prepare invoices. */
export const mayApproveDiscount = (permissions: Permissions | Record<string, unknown>) => hasSubPrivilege(permissions as Permissions, "sales", "quote_approve_discount");

export function mayDirectSell(permissions: Permissions | Record<string, unknown>): boolean {
  const p = permissions as Permissions;
  return hasSubPrivilege(p, "orders", "create") && hasSubPrivilege(p, "sales", "invoices_create");
}

/** The customer check (D3): in the actor's book; a pool customer gets its own code so the screen can say «اطلب من مشرفك». */
export async function assertDirectSaleCustomer(db: Db, actor: DirectSaleActor, customerId: unknown): Promise<string> {
  if (typeof customerId !== "string" || !customerId.trim()) throw refuse(400, "CUSTOMER_REQUIRED", "اختر العميل.", "Choose the customer.");
  const id = customerId.trim();
  const row = await db.customer.findUnique({ where: { id }, select: { accountOwnerId: true } });
  // Owner decision 5: a pool customer (no account owner) is the supervisor's — a scoped rep never sees or sells to one,
  // even one they hold an old deal on. The same 404 as a customer outside the book: nothing to tell apart.
  if (row && !row.accountOwnerId && customersScopedToOwner(actor)) throw refuse(404, "CUSTOMER_NOT_IN_BOOK", "العميل غير موجود أو غير مسند لك.", "Customer not found or not assigned to you.");
  if (row && await customerInScope(actor, id, db)) return id;
  throw refuse(404, "CUSTOMER_NOT_IN_BOOK", "العميل غير موجود أو غير مسند لك.", "Customer not found or not assigned to you.");
}

/** Step 1 / 2 data: the customers the actor may sell to (a scoped rep: their book, never the pool) and the sellable
 *  SKUs (active, with a list price). */
export async function directSaleOptions(actor: DirectSaleActor, q: string, onlyId?: string | null) {
  const term = q.trim().slice(0, 80);
  const digits = term.replace(/\D/g, "");
  const scoped = customersScopedToOwner(actor);
  const nameMatch = term ? { OR: [{ name: { contains: term, mode: "insensitive" as const } }, { nameAr: { contains: term, mode: "insensitive" as const } }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])] } : {};
  const [customers, products] = await Promise.all([
    prisma.customer.findMany({
      where: { AND: [onlyId ? { id: onlyId } : nameMatch, scoped ? { AND: [ownedCustomerWhere(actor.id), { accountOwnerId: { not: null } }] } : {}] },
      orderBy: { name: "asc" }, take: 20,
      select: { id: true, name: true, nameAr: true, city: true, orders: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } },
    }),
    prisma.productSKU.findMany({
      where: { isActive: true, price: { gt: 0 } }, orderBy: [{ product: { productNameEn: "asc" } }, { weightGrams: "asc" }], take: 300,
      select: { id: true, skuCode: true, name: true, nameAr: true, price: true, product: { select: { productNameAr: true, productNameEn: true } } },
    }),
  ]);
  // D22 (أبو فهد B2): for the customer chosen, the open deals the sale may join — the rep's own (or any, with the all-sales
  // view: the same scope the link checks); the page asks «تربطه بصفقة؟» whenever there is one.
  const deals = onlyId && customers.length ? await prisma.opportunity.findMany({
    where: { customerId: onlyId, outcome: "OPEN", ...(seesAllSales(actor.permissions) ? {} : { ownerId: actor.id }) },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 20,
    select: { id: true, title: true, amount: true, createdAt: true, stage: { select: { nameAr: true, nameEn: true } }, _count: { select: { quotes: true, samples: true } }, quotes: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } },
  }) : [];
  return {
    customers: customers.map((c) => ({ id: c.id, name: c.name, nameAr: c.nameAr, city: c.city, lastOrderAt: c.orders[0]?.createdAt.toISOString() ?? null })),
    deals: deals.map((d) => ({ id: d.id, title: d.title, amount: d.amount == null ? null : d.amount.toFixed(2), createdAt: d.createdAt.toISOString(), stageAr: d.stage.nameAr, stageEn: d.stage.nameEn, quotes: d._count.quotes, samples: d._count.samples, quoteAt: d.quotes[0]?.createdAt.toISOString() ?? null })),
    products: products.map((p) => ({ id: p.id, skuCode: p.skuCode, name: p.nameAr || p.name || p.product.productNameAr || p.product.productNameEn, price: p.price.toFixed(2) })),
    can: {
      approveDiscount: mayApproveDiscount(actor.permissions),
      taxOverride: mayOverrideTax(actor.permissions),
      collect: hasSubPrivilege(actor.permissions as Permissions, "sales", "collection_submit"),
      threshold: Number((await discountThreshold(prisma)).toString()), max: DISCOUNT_MAX,
    },
  };
}

export type DirectSaleResult = {
  replayed: boolean;
  order: { id: string; orderNumber: number; status: string };
  /** PENDING: waiting for a supervisor's approval of the discount — no deal won, no invoice, no collection yet. */
  discountApproval: "NONE" | "PENDING" | "APPROVED";
  opportunityId: string | null;
  /** The deal the sale landed on (D22 done screen «الصفقة: «…» صارت رابحة»): joined = an existing open deal, now WON. */
  deal: { id: string; title: string; joined: boolean } | null;
  invoice: { id: string; requested: boolean; warnings: unknown[] } | null;
  totals: { net: string; tax: string; gross: string; discountPercent: string };
  payment: { method: PaymentChoice; collectionId: string | null };
};

/** What the sale's own audit row says (written in the sale's transaction): its key, payment and note — and, for a sale
 *  made on the tax invoice page (D22), its terms (the latest: a resubmit after a refusal records the new ones). */
type SaleRecord = { requestKey: string; payment: PaymentChoice; note: string | null; customerId: string; reference: string | null; terms: SaleTerms | null };
async function saleRecord(tx: Tx, orderId: string): Promise<SaleRecord | null> {
  const row = await tx.hrAuditLog.findFirst({ where: { action: "DIRECT_SALE_CREATED", entityType: "Order", entityId: orderId }, orderBy: { createdAt: "asc" }, select: { after: true } });
  const a = row?.after as (Partial<SaleRecord> & { terms?: SaleTerms }) | null;
  if (!a?.requestKey || !a.payment || !a.customerId) return null;
  let terms = a.terms ?? null;
  if (terms) {
    const re = await tx.hrAuditLog.findFirst({ where: { action: "DIRECT_SALE_RESUBMITTED", entityType: "Order", entityId: orderId }, orderBy: { createdAt: "desc" }, select: { after: true } });
    const t = (re?.after as { terms?: SaleTerms } | null)?.terms;
    // The deal choice is the sale's, made once (a resubmit re-prices the lines only).
    if (t) terms = { ...t, ...(terms.dealId !== undefined ? { dealId: terms.dealId } : {}) };
  }
  return { requestKey: a.requestKey, payment: a.payment, note: a.note ?? null, customerId: a.customerId, reference: a.reference ?? null, terms };
}

/** The sale's price as the rest of the code reads it — the wizard's (catalogue × one discount) or the invoice page's terms. */
type SalePrice = { lines: { productSkuId: string; quantityUnits: number }[]; subtotal: string; discount: string; discountPercent: string; net: string; tax: string; gross: string };
async function priceSale(tx: Db, orderId: string, discountPercent: Prisma.Decimal, terms: SaleTerms | null): Promise<SalePrice> {
  if (terms) return (await priceTerms(tx, terms.lines, await discountThreshold(tx))).quote;
  return priceDirectSale(tx, await orderLines(tx as Tx, orderId), discountPercent);
}

/** A pending (or refused) direct sale's figures now — the approvals inbox shows them (wizard or invoice page). */
export async function pricePendingSale(db: Db, orderId: string, percent: Prisma.Decimal): Promise<SalePrice & { lines: { productSkuId: string; quantityUnits: number; name?: string }[] }> {
  const sale = await saleRecord(db as Tx, orderId);
  return priceSale(db, orderId, percent, sale?.terms ?? null);
}

/** The order's lines as a direct-sale cart (SKU + units). */
async function orderLines(tx: Tx, orderId: string) {
  const items = await tx.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" }, select: { productSkuId: true, quantityUnits: true } });
  return items.filter((i) => i.productSkuId && i.quantityUnits).map((i) => ({ productSkuId: i.productSkuId!, quantityUnits: i.quantityUnits! }));
}

/**
 * The sale proper, inside the caller's transaction: the deal (linked, WON — D1), the discounted snapshot, the invoice
 * DRAFT priced with the discount and requested to the accountant, and the cash / card collection by the rep (owner
 * decision 2). Run at «إرسال» for a sale that needs no approval, or at the supervisor's approval for one that did — the
 * rep is always the actor (the deal, the request and the collection are the rep's).
 */
async function completeSale(tx: Tx, input: { orderId: string; orderNumber: number; customerId: string; rep: DirectSaleActor; key: string; discountPercent: Prisma.Decimal; method: PaymentChoice; reference?: string | null; note: string | null; ctx: AuditContext; now: Date; terms?: SaleTerms | null }) {
  const { orderId, rep, key, method } = input;
  const terms = input.terms ?? null;
  const priced = await priceSale(tx, orderId, input.discountPercent, terms);
  // The customer's open deals as they stand BEFORE the sale (the link re-syncs a joined deal's amount), so a cancelled
  // order can put the one it joins back exactly — outcome, stage and amount (D1 revert, gate L2).
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true } });
  // Gate H2: the customer is the one the sale was made for, and still one the rep may sell to (never the pool) — checked
  // again here, so nothing done to the order while it waited can carry the sale to another customer.
  if (order.customerId !== input.customerId) throw refuse(409, "CUSTOMER_CHANGED", "عميل الطلب تغيّر من بعد البيع — ألغِه وسوّ بيع جديد.", "The order's customer changed after the sale — cancel it and make a new sale.");
  await assertDirectSaleCustomer(tx, rep, order.customerId);
  // Gate M3: the credit hold is checked again when the sale completes (approval / resubmit come later than «إرسال»).
  await assertSalesAllowed(tx, order.customerId, input.now);
  // «order.created» (automation: e.g. an «order received» WhatsApp) only once it is a sale — never while it waits for its
  // discount approval (gate round 3).
  await emitAutomationEvent(tx, { eventType: "order.created", subjectType: "Order", subjectId: orderId, actorId: rep.id });
  const before = await tx.opportunity.findMany({ where: { customerId: order.customerId, outcome: "OPEN" }, select: { id: true, outcome: true, stageId: true, amount: true } });
  // D22 (أبو فهد B2): a sale from the invoice page links the deal the rep chose — or a new WON one — never one picked for him.
  // A chosen deal closed while the sale waited for its approval: a new deal (the audit row says so: dealCreated).
  let chosen: string | null | undefined = terms?.dealId;
  if (chosen) {
    const d = await tx.opportunity.findUnique({ where: { id: chosen }, select: { outcome: true, customerId: true } });
    if (!d || d.outcome !== "OPEN" || d.customerId !== order.customerId) chosen = null;
  }
  const link = await linkDirectOrderDeal(tx, { orderId, actor: rep, mode: "create", ...(chosen !== undefined ? { chosenOpportunityId: chosen, noAutoPick: true } : {}) });
  const opportunityId = link.opportunityId || null;
  let priorDeal: { id: string; outcome: string; stageId: string; amount: string | null } | null = null;
  if (opportunityId && !link.created) {
    const d = before.find((x) => x.id === opportunityId);
    if (d) priorDeal = { id: d.id, outcome: d.outcome, stageId: d.stageId, amount: d.amount == null ? null : d.amount.toString() };
    // D1: the sale is the customer's commitment — a joined deal that was still OPEN is won now (an auto deal already is).
    await winOnAcceptedQuote(tx, opportunityId, rep.id, DIRECT_SALE_WIN_REASON);
  }
  // The discount: the deal link's snapshot is what the customer owes — the discounted value, VAT included.
  // D22: a sale priced on the invoice page differs from the catalogue line by line — its snapshot is its own total too.
  if (opportunityId && (input.discountPercent.greaterThan(0) || terms)) {
    await tx.opportunityOrder.updateMany({ where: { orderId, opportunityId }, data: { directGross: priced.gross, directTax: priced.tax } });
    if (link.created) await tx.opportunity.update({ where: { id: opportunityId }, data: { amount: priced.gross } });
    else await syncDealAmount(tx, opportunityId);
  }
  const draft = await draftFromOrderIn(tx, orderId, key, { ...input.ctx, actorId: rep.id }, priced.discountPercent, terms ? { lines: terms.lines, header: terms.header } : undefined);
  const req = await requestInvoiceIn(tx, draft.id, input.note, { ...input.ctx, actorId: rep.id }, input.now);
  let collectionId: string | null = null;
  if (method !== "CREDIT") {
    if (!opportunityId) throw refuse(409, "NO_DEAL", "ما انربط الطلب بصفقة، فما ينسجل التحصيل.", "The order has no deal to collect against.");
    const c = await submitCollection(tx, {
      opportunityId, amountGross: new Prisma.Decimal(priced.gross), currency: "SAR", collectedAt: input.now,
      paymentMethod: collectionMethodOf(method), referenceNumber: method === "BANK_TRANSFER" ? input.reference ?? null : null, note: `بيع مباشر — طلب #${input.orderNumber}`,
      idempotencyKey: key, submittedById: rep.id,
      // P0 G1: the sale's own order (not the deal's first) — its invoice is the one this money pays.
      orderId,
    });
    collectionId = c.collectionId;
  }
  await audit(tx, {
    action: "DIRECT_SALE_COMPLETED", entityType: "Order", entityId: orderId, actorId: input.ctx.actorId,
    after: { opportunityId, dealCreated: link.created, priorDeal, invoiceId: draft.id, requestKey: key, subtotal: priced.subtotal, discountPercent: priced.discountPercent, net: priced.net, tax: priced.tax, gross: priced.gross, payment: method, collectionId },
  });
  return { priced, opportunityId, invoice: { id: draft.id, requested: true, warnings: req.warnings }, collectionId };
}

async function notifyPending(tx: Tx, order: { id: string; orderNumber: number; customerId: string }, percent: Prisma.Decimal, actorId: string) {
  const c = await tx.customer.findUnique({ where: { id: order.customerId }, select: { name: true, nameAr: true, accountOwnerId: true } });
  await notify(tx, {
    event: "sales.direct_discount_pending", dedupeKey: `${order.id}:${percent.toFixed(2)}`,
    actorId, entity: { type: "Order", id: order.id },
    facts: { orderNumber: order.orderNumber, percent: percent.toDecimalPlaces(2).toString(), customerName: c ? c.nameAr || c.name : "", orderId: order.id },
    scopeOwners: [c?.accountOwnerId],
  });
}

/** The deal a completed sale landed on (its DIRECT_SALE_COMPLETED row), for the done screen. */
async function saleDeal(tx: Tx, orderId: string): Promise<DirectSaleResult["deal"]> {
  const row = await tx.hrAuditLog.findFirst({ where: { action: "DIRECT_SALE_COMPLETED", entityType: "Order", entityId: orderId }, orderBy: { createdAt: "desc" }, select: { after: true } });
  const a = row?.after as { opportunityId?: string | null; dealCreated?: boolean } | null;
  if (!a?.opportunityId) return null;
  const d = await tx.opportunity.findUnique({ where: { id: a.opportunityId }, select: { id: true, title: true } });
  return d ? { id: d.id, title: d.title, joined: !a.dealCreated } : null;
}

/** A replayed key: the sale as it stands now. */
async function describeSale(tx: Tx, orderId: string, method: PaymentChoice, repId: string, key: string): Promise<DirectSaleResult> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, orderNumber: true, status: true, discountApprovalStatus: true, requestedDiscountPercent: true, opportunityLinks: { select: { opportunityId: true }, take: 1 } } });
  const inv = await tx.salesInvoice.findUnique({ where: { requestKey: key }, select: { id: true, requestedAt: true, taxTotal: true, grandTotal: true, lineExtensionTotal: true } });
  const pending = o.discountApprovalStatus === "PENDING" || o.discountApprovalStatus === "REJECTED";
  const priced = inv ? null : await priceSale(tx, orderId, new Prisma.Decimal((o.requestedDiscountPercent ?? 0).toString()), (await saleRecord(tx, orderId))?.terms ?? null);
  return {
    replayed: true, order: { id: o.id, orderNumber: o.orderNumber, status: o.status },
    discountApproval: pending ? "PENDING" : o.discountApprovalStatus === "APPROVED" ? "APPROVED" : "NONE",
    opportunityId: o.opportunityLinks[0]?.opportunityId ?? null,
    deal: await saleDeal(tx, orderId),
    invoice: inv ? { id: inv.id, requested: !!inv.requestedAt, warnings: [] } : null,
    totals: inv ? { net: inv.lineExtensionTotal.toString(), tax: inv.taxTotal.toString(), gross: inv.grandTotal.toString(), discountPercent: (o.requestedDiscountPercent ?? 0).toString() }
      : { net: priced!.net, tax: priced!.tax, gross: priced!.gross, discountPercent: priced!.discountPercent },
    payment: { method, collectionId: (await tx.salesCollection.findUnique({ where: { submittedById_idempotencyKey: { submittedById: repId, idempotencyKey: key } }, select: { id: true } }))?.id ?? null },
  };
}

/**
 * «تربطه بصفقة؟» (D22, أبو فهد B2): "" / null / absent = «لا — صفقة جديدة» (a new WON deal); otherwise an OPEN deal of this
 * customer the rep may work (theirs, or any with the all-sales view) — another rep's or no such deal: the same 404.
 */
async function chosenDeal(tx: Tx, actor: DirectSaleActor, customerId: string, raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw refuse(400, "DEAL_INVALID", "الصفقة غير صحيحة.", "Invalid deal.");
  const d = await tx.opportunity.findFirst({ where: { id: raw, customerId, ...(seesAllSales(actor.permissions) ? {} : { ownerId: actor.id }) }, select: { id: true, outcome: true } });
  if (!d) throw refuse(404, "DEAL_NOT_FOUND", "الصفقة غير موجودة لهذا العميل.", "Deal not found for this customer.");
  if (d.outcome !== "OPEN") throw refuse(409, "DEAL_CLOSED", "الصفقة مقفلة — اختر صفقة مفتوحة أو «صفقة جديدة».", "The deal is closed — choose an open deal or a new one.");
  return d.id;
}

/** «إرسال». Throws `{ _appCode, code, errorAr }` refusals (handleDomainError maps them). */
export async function createDirectSale(
  input: { customerId: unknown; lines: unknown; requestKey: unknown; note?: unknown; discountPercent?: unknown; payment?: unknown; reference?: unknown; invoice?: unknown; opportunityId?: unknown },
  actor: DirectSaleActor,
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<DirectSaleResult> {
  if (!mayDirectSell(actor.permissions)) throw refuse(403, "FORBIDDEN", "ما عندك صلاحية البيع المباشر.", "You may not make a direct sale.");
  const key = directSaleRequestKey(input.requestKey);
  const customerId = await assertDirectSaleCustomer(prisma, actor, input.customerId);
  // D22: from the tax invoice page — the lines carry their own price / discount / VAT (direct-sale-terms.ts); the approval
  // is decided on the highest line's effective discount inside the transaction. The wizard: one discount on every line.
  const termsMode = hasTerms(input);
  const header = termsMode ? parseHeader(input.invoice) : null;
  let { percent: discountPercent, needsApproval } = termsMode ? { percent: new Prisma.Decimal(0), needsApproval: false } : parseDiscount(input.discountPercent, await discountThreshold(prisma), mayApproveDiscount(actor.permissions));
  const method = (PAYMENT_CHOICES as readonly string[]).includes(String(input.payment)) ? input.payment as PaymentChoice : null;
  if (!method) throw refuse(400, "PAYMENT_REQUIRED", "اختر طريقة الدفع: كاش أو شبكة أو تحويل بنكي أو آجل.", "Choose how the customer pays: cash, card, bank transfer or on account.");
  const reference = parseTransferReference(input.reference, method);
  if (method !== "CREDIT" && !hasSubPrivilege(actor.permissions as Permissions, "sales", "collection_submit")) {
    throw refuse(403, "COLLECTION_FORBIDDEN", "ما عندك صلاحية تسجيل تحصيل — اختر «آجل».", "You may not record a collection — choose on account.");
  }

  const result = await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    // Two taps with one key queue here; the second finds the first sale's audit row below and replays it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DIRECT_SALE_LOCK_NAMESPACE}, hashtext(${key}))`;
    const hit = await tx.hrAuditLog.findFirst({ where: { action: "DIRECT_SALE_CREATED", after: { path: ["requestKey"], equals: key } }, select: { entityId: true, after: true } });
    if (hit) {
      const a = hit.after as { customerId?: string; payment?: PaymentChoice } | null;
      if (a?.customerId !== customerId) throw refuse(409, "REQUEST_KEY_REUSED", "مفتاح الطلب مستخدم لعملية ثانية.", "This requestKey belongs to another sale.");
      return describeSale(tx, hit.entityId, a.payment ?? method, actor.id, key);
    }

    let terms: SaleTerms | null = null;
    let priced: SalePrice;
    if (termsMode) {
      const threshold = await discountThreshold(tx);
      // D22 (owner, option 1): S at the default rate unless the rep holds sales › invoice_tax_override (else 400 TAX_LOCKED).
      const t = await priceTerms(tx, input.lines, threshold, "0", mayOverrideTax(actor.permissions));
      ({ percent: discountPercent, needsApproval } = termsApproval(t.quote, threshold, mayApproveDiscount(actor.permissions)));
      terms = { lines: t.terms, header: header!, dealId: await chosenDeal(tx, actor, customerId, input.opportunityId) };
      priced = t.quote;
    } else {
      priced = await priceDirectSale(tx, input.lines, discountPercent);
    }
    const resolved = await resolveOrderLines(tx, priced.lines.map((l) => ({ productSkuId: l.productSkuId, quantityUnits: l.quantityUnits })));
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) || null : null;
    const order = await createOrderWithNumber(tx, { customerId, notes: ["بيع مباشر", note].filter(Boolean).join(" — "), ownerId: actor.id, channel: "DIRECT_SALE" }, resolved, false);
    if (needsApproval) {
      // Gate H1: the legacy pre-preparation status — the automatic preparation never runs from it, and every other order
      // path refuses the order while it waits (services/orders/discount-hold.ts).
      await tx.order.update({ where: { id: order.id }, data: { status: "Waiting Approval", discountApprovalStatus: "PENDING", requestedDiscountPercent: discountPercent.toFixed(2) } });
      order.status = "Waiting Approval";
    }
    await appendOrderActivity(tx, {
      orderId: order.id, type: "DIRECT_SALE", authorId: actor.id, authorName: actor.name,
      message: `بيع مباشر · ${paymentLabelAr(method)}${needsApproval ? ` · خصم ${discountPercent.toString()}٪ بانتظار موافقة المشرف` : ""}`,
      metadata: { payment: method, discountPercent: priced.discountPercent, pending: needsApproval },
    });
    await audit(tx, {
      action: "DIRECT_SALE_CREATED", entityType: "Order", entityId: order.id, actorId: actor.id,
      after: { orderNumber: order.orderNumber, customerId, requestKey: key, payment: method, reference, note, discountPercent: priced.discountPercent, pending: needsApproval, subtotal: priced.subtotal, gross: priced.gross, lines: priced.lines.length, ...(terms ? { terms, source: "INVOICE_PAGE" } : {}) } as unknown as Prisma.InputJsonValue,
    });
    if (needsApproval) {
      await notifyPending(tx, { id: order.id, orderNumber: order.orderNumber, customerId }, discountPercent, actor.id);
      return {
        replayed: false, order: { id: order.id, orderNumber: order.orderNumber, status: order.status }, discountApproval: "PENDING", opportunityId: null, deal: null, invoice: null,
        totals: { net: priced.net, tax: priced.tax, gross: priced.gross, discountPercent: priced.discountPercent }, payment: { method, collectionId: null },
      } satisfies DirectSaleResult;
    }
    const done = await completeSale(tx, { orderId: order.id, orderNumber: order.orderNumber, customerId, rep: actor, key, discountPercent, method, reference, note, ctx, now, terms });
    return {
      replayed: false, order: { id: order.id, orderNumber: order.orderNumber, status: order.status }, discountApproval: "NONE", opportunityId: done.opportunityId, deal: await saleDeal(tx, order.id), invoice: done.invoice,
      totals: { net: done.priced.net, tax: done.priced.tax, gross: done.priced.gross, discountPercent: done.priced.discountPercent }, payment: { method, collectionId: done.collectionId },
    } satisfies DirectSaleResult;
  }, TX_OPTS);

  // Preparation, as for every order — but not while the sale waits for its discount approval (it is not a sale yet).
  if (!result.replayed && result.discountApproval !== "PENDING") {
    const prepared = await autoPrepareOrder(result.order.id, "order_created", { id: actor.id, name: actor.name });
    if (prepared?.order?.status) result.order.status = prepared.order.status;
  }
  return result;
}

// ── the discount approval (same approvers, same inbox and same rules as a quotation's discount) ─────────────────────

async function repOf(tx: Tx, employeeId: string | null): Promise<DirectSaleActor> {
  const e = employeeId ? await tx.employee.findUnique({ where: { id: employeeId }, select: { id: true, name: true, role: true, permissions: true, active: true } }) : null;
  if (!e || !e.active) throw refuse(409, "REP_INACTIVE", "صاحب الطلب غير نشط — ما يقدر يكمل البيع.", "The order's owner is inactive.");
  const perms = typeof e.permissions === "string" ? JSON.parse(e.permissions) : e.permissions;
  return { id: e.id, name: e.name, role: e.role, permissions: perms as Permissions };
}

/**
 * The supervisor's decision on a PENDING direct sale (sales › quote_approve_discount, checked by the route with its
 * step-up). Four eyes unless SIMPLE MODE; a refusal needs a reason; `expected` (the figures the approver was shown) must
 * still hold. APPROVE: the sale completes as the rep's (completeSale) and preparation starts. REJECT: the order waits for
 * the rep — resubmit at or under the threshold (resubmitDirectSale) or cancel it; nothing else is written.
 */
export async function decideDirectSaleDiscount(input: { orderId: string; decision: "APPROVE" | "REJECT"; note: string | null; actor: { id: string; name: string }; expected?: { discountPercent?: string | null; grandTotal?: string | null }; ctx: AuditContext; now?: Date }) {
  const now = input.now ?? new Date();
  const out = await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, input.ctx);
    // Gate L3: the canonical lock order of cancel (allocations → lots → lines, then the Order row), so approve ∥ cancel
    // queue instead of deadlocking.
    await lockOrderLifecycleResources(tx, input.orderId);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE`;
    const o = await tx.order.findUnique({ where: { id: input.orderId }, select: { id: true, orderNumber: true, status: true, ownerId: true, customerId: true, discountApprovalStatus: true, requestedDiscountPercent: true } });
    if (!o) throw refuse(404, "NOT_FOUND", "الطلب غير موجود.", "Order not found.");
    if (o.discountApprovalStatus !== "PENDING" || ["Cancelled", "Rejected"].includes(o.status)) throw refuse(409, "NOT_PENDING", "الطلب ما ينتظر موافقة خصم.", "This order is not waiting for a discount approval.");
    if (!isSimpleMode() && o.ownerId === input.actor.id) throw refuse(403, "SELF_APPROVAL", "ما تعتمد خصم على طلبك أنت.", "You cannot approve a discount on your own sale.");
    const note = (input.note ?? "").trim().slice(0, 1000);
    if (input.decision === "REJECT" && note.length < 3) throw refuse(400, "REASON_REQUIRED", "اكتب سبب الرفض.", "Give the reason for the refusal.");
    const percent = new Prisma.Decimal((o.requestedDiscountPercent ?? 0).toString());
    const terms = (await saleRecord(tx, o.id))?.terms ?? null;
    // A refusal must stay possible when the order can no longer be priced (gate L4); an approval needs the price.
    const priced = await priceSale(tx, o.id, percent, terms).catch((e) => { if (input.decision === "APPROVE") throw e; return null; });
    if (input.expected && ((input.expected.discountPercent && new Prisma.Decimal(input.expected.discountPercent).toFixed(2) !== percent.toFixed(2)) || (input.expected.grandTotal && priced && input.expected.grandTotal !== priced.gross))) {
      throw refuse(409, "STALE_REQUEST", "تغيّر الطلب من بعد ما فتحته — حدّث الصفحة.", "The order changed since you opened it — refresh.");
    }
    const sale = await saleRecord(tx, o.id);
    if (!sale) throw refuse(409, "NOT_A_DIRECT_SALE", "الطلب ما هو بيع مباشر.", "This order is not a direct sale.");
    // أبو فهد B2: an approved TRANSFER has its collection only now, with no receipt — the rep is told where to add it.
    let receiptDue: { dealId: string } | null = null;
    if (input.decision === "REJECT") {
      await tx.order.update({ where: { id: o.id }, data: { discountApprovalStatus: "REJECTED", discountRejectedById: input.actor.id, discountRejectedAt: now, discountRejectionNote: note } });
      await appendOrderActivity(tx, { orderId: o.id, type: "DIRECT_SALE", authorId: input.actor.id, authorName: input.actor.name, message: `الخصم انرفض: ${note}`, metadata: { decision: "REJECT", percent: percent.toFixed(2) } });
    } else {
      await tx.order.update({ where: { id: o.id }, data: { status: o.status === "Waiting Approval" ? "Waiting Preparation Review" : o.status, discountApprovalStatus: "APPROVED", discountApprovedById: input.actor.id, discountApprovedAt: now } });
      await appendOrderActivity(tx, { orderId: o.id, type: "DIRECT_SALE", authorId: input.actor.id, authorName: input.actor.name, message: `اعتُمد الخصم ${percent.toString()}٪`, metadata: { decision: "APPROVE", percent: percent.toFixed(2) } });
      const done = await completeSale(tx, { orderId: o.id, orderNumber: o.orderNumber, customerId: sale.customerId, rep: await repOf(tx, o.ownerId), key: sale.requestKey, discountPercent: percent, method: sale.payment, reference: sale.reference, note: sale.note, ctx: input.ctx, now, terms: sale.terms });
      if (sale.payment === "BANK_TRANSFER" && done.opportunityId && done.collectionId) receiptDue = { dealId: done.opportunityId };
    }
    await audit(tx, { action: input.decision === "APPROVE" ? "DIRECT_SALE_DISCOUNT_APPROVED" : "DIRECT_SALE_DISCOUNT_REJECTED", entityType: "Order", entityId: o.id, actorId: input.actor.id, after: { percent: percent.toFixed(2), gross: priced?.gross ?? null, note: note || null } });
    await notify(tx, {
      event: "sales.direct_discount_decided", dedupeKey: `${o.id}:${input.decision}:${now.toISOString()}`,
      actorId: input.actor.id, entity: { type: "Order", id: o.id },
      facts: { orderNumber: o.orderNumber, decision: input.decision, note: note || null, orderId: o.id, threshold: (await discountThreshold(tx)).toString(), receiptDealId: receiptDue?.dealId ?? null },
      people: { orderOwner: o.ownerId },
    });
    return { state: input.decision === "APPROVE" ? "APPROVED" as const : "REJECTED" as const, orderId: o.id, ownerId: o.ownerId };
  }, TX_OPTS);
  if (out.state === "APPROVED") await autoPrepareOrder(out.orderId, "order_created", { id: input.actor.id, name: input.actor.name });
  return { state: out.state };
}

/** The rep after a refusal: send it again with a new discount — at or under the threshold it completes now; above it, it
 *  waits for a supervisor again. Only the order's owner, only from REJECTED. */
export async function resubmitDirectSale(input: { orderId: string; discountPercent: unknown; actor: DirectSaleActor; ctx: AuditContext; now?: Date }) {
  const now = input.now ?? new Date();
  const out = await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, input.ctx);
    await lockOrderLifecycleResources(tx, input.orderId);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE`;
    const o = await tx.order.findUnique({ where: { id: input.orderId }, select: { id: true, orderNumber: true, status: true, ownerId: true, customerId: true, discountApprovalStatus: true } });
    if (!o || o.ownerId !== input.actor.id) throw refuse(404, "NOT_FOUND", "الطلب غير موجود.", "Order not found.");
    if (o.discountApprovalStatus !== "REJECTED" || ["Cancelled", "Rejected"].includes(o.status)) throw refuse(409, "NOT_REJECTED", "الطلب ما انرفض خصمه.", "This order's discount was not refused.");
    const sale = await saleRecord(tx, o.id);
    if (!sale) throw refuse(409, "NOT_A_DIRECT_SALE", "الطلب ما هو بيع مباشر.", "This order is not a direct sale.");
    // D22: a sale made on the invoice page gets the new discount on every line (its prices / VAT stay), re-priced as terms.
    let percent: Prisma.Decimal; let needsApproval: boolean; let terms: SaleTerms | null = null;
    if (sale.terms) {
      const threshold = await discountThreshold(tx);
      const d = parseDiscount(input.discountPercent, new Prisma.Decimal(DISCOUNT_MAX), true).percent.toFixed(2);
      const t = await priceTerms(tx, sale.terms.lines.map((l) => ({ ...l, discountPercent: d })), threshold);
      ({ percent, needsApproval } = termsApproval(t.quote, threshold, mayApproveDiscount(input.actor.permissions)));
      terms = { lines: t.terms, header: sale.terms.header };
    } else {
      ({ percent, needsApproval } = parseDiscount(input.discountPercent, await discountThreshold(tx), mayApproveDiscount(input.actor.permissions)));
    }
    if (needsApproval) {
      await tx.order.update({ where: { id: o.id }, data: { discountApprovalStatus: "PENDING", requestedDiscountPercent: percent.toFixed(2) } });
      await notifyPending(tx, o, percent, input.actor.id);
    } else {
      await tx.order.update({ where: { id: o.id }, data: { status: o.status === "Waiting Approval" ? "Waiting Preparation Review" : o.status, discountApprovalStatus: "NONE", requestedDiscountPercent: null } });
      await completeSale(tx, { orderId: o.id, orderNumber: o.orderNumber, customerId: sale.customerId, rep: input.actor, key: sale.requestKey, discountPercent: percent, method: sale.payment, reference: sale.reference, note: sale.note, ctx: input.ctx, now, terms });
    }
    await appendOrderActivity(tx, { orderId: o.id, type: "DIRECT_SALE", authorId: input.actor.id, authorName: input.actor.name, message: needsApproval ? `أُعيد الإرسال بخصم ${percent.toString()}٪ — بانتظار موافقة المشرف` : `أُعيد الإرسال بخصم ${percent.toString()}٪`, metadata: { resubmit: true, percent: percent.toFixed(2) } });
    await audit(tx, { action: "DIRECT_SALE_RESUBMITTED", entityType: "Order", entityId: o.id, actorId: input.actor.id, after: { percent: percent.toFixed(2), pending: needsApproval, ...(terms ? { terms } : {}) } as unknown as Prisma.InputJsonValue });
    return { pending: needsApproval, orderId: o.id };
  }, TX_OPTS);
  if (!out.pending) await autoPrepareOrder(out.orderId, "order_created", { id: input.actor.id, name: input.actor.name });
  return { discountApproval: out.pending ? "PENDING" as const : "NONE" as const };
}
