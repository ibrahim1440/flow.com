// Sales invoicing A2 — the documents: drafts (manual, from an order, from a delivery), issue, cancel, credit and
// debit notes. Every write runs in one transaction with its ledger entry (./postings) and its audit context; the
// database re-checks the lifecycle, the numbering, the E-10 totals and the caps (20261103090000_sales_invoicing).
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { assertRolesMapped } from "@/lib/accounting/posting-engine";
import { getSettings } from "@/lib/accounting/setup";
import { sodDecision, sodPolicy } from "@/lib/accounting/sod";
import { emitAutomationEvent } from "@/lib/automation/emit";
import { MoneyError, ZERO } from "@/lib/accounting/money";
import {
  Decimal, addDays, issueProblems, parseBuyer, parseLines, priceInvoice, riyadhStamp, seriesFor,
  type BuyerParticulars, type CleanLine, type InvoiceFamily, type InvoiceKind, type NoteReason, NOTE_REASONS,
} from "./pricing";
import { readInvoiceSettings, sellerSnapshot } from "./settings";
import { postDocumentIssued } from "./postings";
import { refuseInv, refuseWith } from "./refusals";
import { signAtIssue, type SignedAtIssue } from "@/lib/zatca/pipeline";
import { defaultInvoiceBranch, orderBranchId, parseBranchId, sharedBranch } from "@/lib/accounting/locations";
import { notifyIssued, notifyRequested, writeRequestEvent } from "./request-events";
import { commercialChanges, correctionDiff } from "./request-math";

type Tx = Prisma.TransactionClient;
const D = (v: { toString(): string } | null | undefined) => new Decimal(v == null ? 0 : v.toString());
const dayOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const asDay = (v: unknown): string | null => (typeof v === "string" && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
const dateOf = (day: string | null) => (day ? new Date(`${day}T00:00:00Z`) : null);

export type Actor = { id: string; name?: string | null };

// ── reading ─────────────────────────────────────────────────────────────────────────────────────────

export const LINE_ORDER = [{ position: "asc" as const }, { id: "asc" as const }];

export async function loadDocument(db: Tx | typeof prisma, id: string) {
  return db.salesInvoice.findUnique({
    where: { id },
    include: {
      lines: { orderBy: LINE_ORDER },
      originalInvoice: { select: { id: true, number: true, kind: true, family: true, status: true, issueDate: true, grandTotal: true, customerId: true } },
      notesIssued: { select: { id: true, number: true, kind: true, status: true, issueDate: true, grandTotal: true, reasonCode: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      applications: { orderBy: { createdAt: "asc" } },
      creditApplications: { orderBy: { createdAt: "asc" } },
    },
  });
}
export type LoadedDocument = NonNullable<Awaited<ReturnType<typeof loadDocument>>>;

/** Invoiced (DRAFT + ISSUED invoices) quantity per order line, excluding one draft (when re-saving it). */
export async function invoicedPerOrderItem(db: Tx | typeof prisma, orderItemIds: string[], exceptInvoiceId?: string): Promise<Map<string, { drafted: Decimal; issued: Decimal }>> {
  const out = new Map<string, { drafted: Decimal; issued: Decimal }>();
  if (!orderItemIds.length) return out;
  const rows = await db.salesInvoiceLine.findMany({
    where: { orderItemId: { in: orderItemIds }, invoice: { kind: "INVOICE", status: { in: ["DRAFT", "ISSUED"] }, ...(exceptInvoiceId ? { id: { not: exceptInvoiceId } } : {}) } },
    select: { orderItemId: true, quantity: true, invoice: { select: { status: true } } },
  });
  for (const r of rows) {
    const cur = out.get(r.orderItemId!) ?? { drafted: ZERO, issued: ZERO };
    if (r.invoice.status === "ISSUED") cur.issued = cur.issued.plus(D(r.quantity)); else cur.drafted = cur.drafted.plus(D(r.quantity));
    out.set(r.orderItemId!, cur);
  }
  return out;
}

const orderedQty = (i: { quantityUnits: number | null; quantityKg: number }) => new Decimal(i.quantityUnits != null ? String(i.quantityUnits) : i.quantityKg.toFixed(3));
const deliveredQty = (i: { quantityUnits: number | null; deliveredUnits: number; deliveredQty: number }) => new Decimal(i.quantityUnits != null ? String(i.deliveredUnits) : i.deliveredQty.toFixed(3));

/** What an order has to invoice, line by line (the «إنشاء فاتورة من الطلب» screen and its server). */
export async function orderInvoicing(db: Tx | typeof prisma, orderId: string) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, orderNumber: true, customerId: true, status: true, ownerId: true,
      customer: { select: { id: true, name: true, nameAr: true, vatNumber: true, commercialRegNo: true, city: true, address: true, phone: true, paymentTermsDays: true, accountOwnerId: true } },
      items: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, beanTypeName: true, quantityKg: true, quantityUnits: true, deliveredUnits: true, deliveredQty: true, productSkuId: true,
          productSku: { select: { id: true, skuCode: true, name: true, nameAr: true, price: true, product: { select: { productNameEn: true, productNameAr: true } } } },
          deliveries: { orderBy: { date: "asc" }, select: { id: true, date: true, quantityUnits: true, quantityKg: true } },
        },
      },
      opportunityLinks: { select: { quoteId: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) return null;
  const quoteIds = order.opportunityLinks.map((l) => l.quoteId).filter((x): x is string => !!x);
  const quoteLines = quoteIds.length
    ? await db.quoteLine.findMany({ where: { quoteId: { in: quoteIds }, quote: { status: { in: ["ACCEPTED", "ISSUED"] } } }, select: { quoteId: true, productSkuId: true, unitPrice: true, discountPercent: true, taxRatePercent: true, unit: true } })
    : [];
  const invoiced = await invoicedPerOrderItem(db, order.items.map((i) => i.id));
  const invoicedDeliveries = new Set((await db.salesInvoiceLine.findMany({
    where: { deliveryId: { in: order.items.flatMap((i) => i.deliveries.map((d) => d.id)) }, invoice: { kind: "INVOICE", status: { in: ["DRAFT", "ISSUED"] } } },
    select: { deliveryId: true },
  })).map((r) => r.deliveryId!));
  const lines = order.items.map((i) => {
    const ordered = orderedQty(i);
    const delivered = deliveredQty(i);
    const inv = invoiced.get(i.id) ?? { drafted: ZERO, issued: ZERO };
    const remaining = Decimal.max(ordered.minus(inv.drafted).minus(inv.issued), ZERO);
    // The price: the accepted (or issued) quotation of the deal the order came from — the order snapshot of the
    // agreed price; else the catalogue price of the SKU; else none (entered on the draft).
    const q = quoteLines.find((x) => x.productSkuId && x.productSkuId === i.productSkuId);
    const skuPrice = i.productSku && i.productSku.price > 0 ? new Decimal(i.productSku.price.toFixed(2)) : null;
    const name = i.productSku ? (i.productSku.nameAr || i.productSku.name || i.productSku.product.productNameAr || i.productSku.product.productNameEn) : i.beanTypeName;
    const nameEn = i.productSku ? (i.productSku.name || i.productSku.product.productNameEn) : i.beanTypeName;
    return {
      orderItemId: i.id, description: name, descriptionEn: nameEn, skuCode: i.productSku?.skuCode ?? null, productSkuId: i.productSkuId,
      unit: i.quantityUnits != null ? "UNIT" as const : "KG" as const,
      ordered: ordered.toString(), delivered: delivered.toString(), drafted: inv.drafted.toString(), issued: inv.issued.toString(), remaining: remaining.toString(),
      deliveredNotInvoiced: Decimal.max(Decimal.min(delivered.minus(inv.drafted).minus(inv.issued), remaining), ZERO).toString(),
      deliveries: i.deliveries.map((d) => ({ id: d.id, date: dayOf(d.date), quantity: i.quantityUnits != null ? String(d.quantityUnits ?? 0) : d.quantityKg.toFixed(3), invoiced: invoicedDeliveries.has(d.id) })),
      price: q ? { source: "QUOTE" as const, unitPrice: D(q.unitPrice).toFixed(2), discountPercent: D(q.discountPercent).toFixed(2), taxRatePercent: D(q.taxRatePercent).toFixed(2) }
        : skuPrice ? { source: "SKU" as const, unitPrice: skuPrice.toFixed(2), discountPercent: "0.00", taxRatePercent: null }
          : { source: "NONE" as const, unitPrice: "0.00", discountPercent: "0.00", taxRatePercent: null },
    };
  });
  return { order: { id: order.id, orderNumber: order.orderNumber, customerId: order.customerId, status: order.status, ownerId: order.ownerId }, customer: order.customer, lines };
}

// ── drafts ──────────────────────────────────────────────────────────────────────────────────────────

function buyerFromCustomer(c: { name: string; nameAr: string | null; vatNumber: string | null; commercialRegNo: string | null; city: string | null; address: string | null; phone: string | null }): BuyerParticulars {
  return parseBuyer({}, { name: c.nameAr || c.name, nameEn: c.nameAr ? c.name : null, vatNumber: c.vatNumber, crNumber: c.commercialRegNo, city: c.city, address: c.address, phone: c.phone, countryCode: "SA" });
}

async function lockOrderItems(tx: Tx, ids: string[]) {
  if (!ids.length) return new Map<string, { id: string; orderId: string; quantityUnits: number | null; quantityKg: number }>();
  const rows = await tx.$queryRaw<{ id: string; orderId: string; quantityUnits: number | null; quantityKg: number }[]>`
    SELECT "id", "orderId", "quantityUnits", "quantityKg" FROM "OrderItem" WHERE "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`;
  return new Map(rows.map((r) => [r.id, r]));
}

/** Refuse a line set that would invoice more than an order line holds (the database checks it again at commit). */
async function assertNotOverInvoiced(tx: Tx, lines: CleanLine[], orderId: string | null, exceptInvoiceId?: string) {
  const ids = [...new Set(lines.map((l) => l.orderItemId).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const items = await lockOrderItems(tx, ids);
  const already = await invoicedPerOrderItem(tx, ids, exceptInvoiceId);
  for (const id of ids) {
    const it = items.get(id);
    if (!it || (orderId && it.orderId !== orderId)) throw refuseInv("BAD_INPUT", "An order line does not belong to the order.", "بند الطلب لا ينتمي إلى الطلب.");
    const want = lines.filter((l) => l.orderItemId === id).reduce((s, l) => s.plus(l.quantity), ZERO);
    const a = already.get(id) ?? { drafted: ZERO, issued: ZERO };
    const cap = orderedQty({ quantityUnits: it.quantityUnits, quantityKg: it.quantityKg });
    if (a.drafted.plus(a.issued).plus(want).greaterThan(cap)) {
      const left = Decimal.max(cap.minus(a.drafted).minus(a.issued), ZERO);
      throw refuseWith("OVER_INVOICED", { orderItemId: id, remaining: left.toString() }, `(order line ${id}: ${left.toString()} left)`);
    }
  }
}

function lineRows(lines: CleanLine[]) {
  let priced: ReturnType<typeof priceInvoice>;
  try {
    priced = priceInvoice(lines);
  } catch (e) {
    // Audit F-8: a line whose amounts exceed numeric(18,2) is a coded refusal, never a raw library error (a 500).
    if (e instanceof MoneyError) throw refuseInv("LINES_INVALID", "A line amount is too large.", "مبلغ أحد البنود أكبر من المسموح.");
    throw e;
  }
  return {
    priced,
    rows: lines.map((l, i) => ({
      position: i + 1, orderItemId: l.orderItemId, deliveryId: l.deliveryId, productSkuId: l.productSkuId, originalLineId: l.originalLineId,
      description: l.description, descriptionEn: l.descriptionEn, skuCode: l.skuCode, quantity: l.quantity.toFixed(3), unit: l.unit,
      unitPrice: l.unitPrice.toFixed(2), discountPercent: l.discountPercent.toFixed(2), discountAmount: priced.lines[i].discountAmount.toFixed(2),
      taxCategory: l.taxCategory, taxRatePercent: l.taxRatePercent.toFixed(2), exemptionReasonCode: l.exemptionReasonCode, exemptionReason: l.exemptionReason,
      lineNet: priced.lines[i].lineNet.toFixed(2), lineTax: priced.lines[i].lineTax.toFixed(2), lineTotal: priced.lines[i].lineTotal.toFixed(2),
      // «شامل؟» (WP-K): the typed gross, for audit (the database re-checks unitPrice against it).
      priceIncludesVat: l.priceIncludesVat, enteredGrossUnitPrice: l.enteredGrossUnitPrice?.toFixed(2) ?? null,
    })),
  };
}

function totalsData(p: ReturnType<typeof priceInvoice>) {
  return {
    lineExtensionTotal: p.lineExtensionTotal.toFixed(2), discountTotal: p.discountTotal.toFixed(2), taxableTotal: p.taxableTotal.toFixed(2),
    taxTotal: p.taxTotal.toFixed(2), grandTotal: p.grandTotal.toFixed(2), taxBreakdown: p.breakdown as unknown as Prisma.InputJsonValue,
  };
}

export type DraftInput = {
  kind?: InvoiceKind; family?: InvoiceFamily; customerId: string; orderId?: string | null; quoteId?: string | null;
  lines: unknown; buyer?: unknown; supplyDate?: unknown; supplyEndDate?: unknown; paymentTermsDays?: unknown; notes?: unknown;
  source?: "MANUAL" | "ORDER" | "DELIVERY"; requestKey?: string | null;
  /** «بيع أصل ثابت» (WP-F): the actor holds accounting › fixed_assets (only then may a line sell a fixed asset). */
  canSellAssets?: boolean;
  /** A4: an external order source (e.g. SALLA): one document per (channel, external order reference). */
  channel?: string | null; externalOrderRef?: string | null;
  /** «الموقع» (WP-B): the selling location (FinBranch id); absent = the order's, else the requester's (never the delivery's site). */
  branchId?: unknown;
};

/** A4: the external order source of a draft, validated (null = none). */
export function externalSource(channel: unknown, ref: unknown): { channel: string; externalOrderRef: string } | null {
  if (channel === undefined || channel === null || channel === "") return null;
  const c = typeof channel === "string" ? channel.trim().toUpperCase() : "";
  const r = typeof ref === "string" ? ref.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  if (!/^[A-Z0-9_]{1,20}$/.test(c) || r.length < 1 || r.length > 100) throw refuseInv("BAD_INPUT", "(channel: 1–20 capitals / digits / _; externalOrderRef: 1–100 characters)", "(القناة 1–20 حرفًا لاتينيًا كبيرًا أو رقمًا؛ مرجع الطلب الخارجي 1–100 حرف)");
  return { channel: c, externalOrderRef: r };
}

const termsOf = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 365 ? n : fallback;
};
const notesOf = (v: unknown) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, 2000) || null : null);

/** A new invoice DRAFT (kind INVOICE). Lines naming an order line are capped by what is left to invoice. */
export async function createDraft(input: DraftInput, ctx: AuditContext) {
  if (input.requestKey) {
    const hit = await prisma.salesInvoice.findUnique({ where: { requestKey: input.requestKey }, select: { id: true } });
    if (hit) return { id: hit.id, replayed: true };
  }
  const ext = externalSource(input.channel, input.externalOrderRef);
  if (ext) {
    const hit = await prisma.salesInvoice.findFirst({ where: { channel: ext.channel, externalOrderRef: ext.externalOrderRef }, select: { id: true } });
    if (hit) return { id: hit.id, replayed: true };
  }
  const { lines, problems } = parseLines(input.lines);
  if (problems.length) throw refuseWith("LINES_INVALID", { problems });
  assertAssetLinesAllowed(lines, !!input.canSellAssets);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    return insertDraft(tx, input, lines, ext, ctx);
  }, TX_OPTS).catch(async (e: { code?: string }) => {
    // Two requests for the same external order at once: the unique (channel, ref) lets one through; the other replays it.
    if (ext && e?.code === "P2002") {
      const hit = await prisma.salesInvoice.findFirst({ where: { channel: ext.channel, externalOrderRef: ext.externalOrderRef }, select: { id: true } });
      if (hit) return { id: hit.id, replayed: true };
    }
    throw e;
  });
}

/**
 * «المعاملات المتكررة»: a manual invoice DRAFT (no order, no external source) inside the CALLER'S transaction, under its
 * request key — the same key twice returns the first draft (replayed). The draft is only a draft: nothing is numbered,
 * signed, reported or posted until a person issues it. The caller sets the audit context.
 */
export async function createManualDraftIn(tx: Tx, input: Omit<DraftInput, "orderId" | "quoteId" | "channel" | "externalOrderRef" | "source"> & { requestKey: string }, ctx: AuditContext) {
  const hit = await tx.salesInvoice.findUnique({ where: { requestKey: input.requestKey }, select: { id: true } });
  if (hit) return { id: hit.id, replayed: true };
  const { lines, problems } = parseLines(input.lines);
  if (problems.length) throw refuseWith("LINES_INVALID", { problems });
  assertAssetLinesAllowed(lines, false);
  const r = await insertDraft(tx, { ...input, source: "MANUAL" }, lines, null, ctx);
  // «طلبات الفواتير» (WP-C): a recurring draft enters the accountant's queue by itself, requested by the schedule's preparer.
  await queueAutomaticDraft(tx, r.id, ctx.actorId);
  return r;
}

/**
 * «بيع أصل ثابت» (WP-F refinement 1): a line selling a fixed asset is the accountant's — it needs accounting ›
 * fixed_assets as well as invoices_create, so such an invoice never comes from a Sales request (or a recurring draft).
 */
function assertAssetLinesAllowed(lines: CleanLine[], canSellAssets: boolean) {
  if (!canSellAssets && lines.some((l) => l.kind === "FIXED_ASSET_SALE")) throw refuseInv("FA_LINE_ACCOUNTANT_ONLY");
}

/** An automatic draft (on delivery, recurring) enters the issuer's queue at once: REQUESTED by whoever caused it. */
async function queueAutomaticDraft(tx: Tx, id: string, actorId: string) {
  const at = new Date();
  const doc = await tx.salesInvoice.update({ where: { id }, data: { requestedAt: at, requestedById: actorId }, select: { id: true, customerId: true, grandTotal: true, buyer: true, orderId: true } });
  await writeRequestEvent(tx, { invoiceId: id, kind: "REQUESTED", actorId });
  await notifyRequested(tx, doc, actorId, at);
}

/**
 * «بيع أصل ثابت» × «الموقع» (WP-F refinement 5): the branch of the fixed assets a draft sells, when they all share one
 * (null: no sale line, or assets of different / no branches — the document's own location then applies).
 */
async function assetSaleBranch(tx: Tx, lines: CleanLine[]): Promise<string | null> {
  const ids = [...new Set(lines.filter((l) => l.kind === "FIXED_ASSET_SALE" && l.fixedAssetId).map((l) => l.fixedAssetId as string))];
  if (!ids.length) return null;
  const assets = await tx.fixedAsset.findMany({ where: { id: { in: ids } }, select: { branchId: true } });
  return assets.length === ids.length ? sharedBranch(assets.map((a) => a.branchId)) : null;
}

async function insertDraft(tx: Tx, input: DraftInput, lines: CleanLine[], ext: { channel: string; externalOrderRef: string } | null, ctx: AuditContext) {
  const customer = await tx.customer.findUnique({ where: { id: input.customerId }, select: { id: true, name: true, nameAr: true, vatNumber: true, commercialRegNo: true, city: true, address: true, phone: true, paymentTermsDays: true } });
  if (!customer) throw refuseInv("CUSTOMER_NOT_FOUND");
  if (input.orderId) {
    const o = await tx.order.findUnique({ where: { id: input.orderId }, select: { customerId: true } });
    if (!o) throw refuseInv("ORDER_NOT_FOUND");
    if (o.customerId !== customer.id) throw refuseInv("BAD_INPUT", "The order belongs to another customer.", "الطلب لعميل آخر.");
  } else if (lines.some((l) => l.orderItemId)) {
    throw refuseInv("BAD_INPUT", "Lines name order lines: give the order.", "البنود مرتبطة بطلب؛ حدّد الطلب.");
  }
  await assertNotOverInvoiced(tx, lines, input.orderId ?? null);
  const settings = await readInvoiceSettings(tx);
  const { priced, rows } = lineRows(lines);
  const given = await parseBranchId(tx, input.branchId);
  // «الموقع» (WP-B × WP-F refinement 5): a draft selling a fixed asset takes the asset's branch, so the gain or loss and
  // the depreciation land on the asset's site; otherwise the given location, else the default.
  const assetBranch = await assetSaleBranch(tx, lines);
  const branchId = assetBranch ?? (given !== undefined ? given : await defaultInvoiceBranch(tx, { orderId: input.orderId ?? null, actorId: ctx.actorId }));
  const created = await tx.salesInvoice.create({
    data: {
      kind: "INVOICE", family: input.family === "SIMPLIFIED" ? "SIMPLIFIED" : "STANDARD", status: "DRAFT",
      customerId: customer.id, orderId: input.orderId ?? null, quoteId: input.quoteId ?? null, branchId,
      buyer: parseBuyer(input.buyer, buyerFromCustomer(customer)) as unknown as Prisma.InputJsonValue,
      supplyDate: dateOf(asDay(input.supplyDate)), supplyEndDate: dateOf(asDay(input.supplyEndDate)),
      paymentTermsDays: termsOf(input.paymentTermsDays, customer.paymentTermsDays ?? settings.defaultTermsDays),
      notes: notesOf(input.notes), source: input.source ?? (input.orderId ? "ORDER" : "MANUAL"), requestKey: input.requestKey ?? null,
      channel: ext?.channel ?? null, externalOrderRef: ext?.externalOrderRef ?? null,
      createdById: ctx.actorId, ...totalsData(priced),
    },
    select: { id: true },
  });
  // The lines by their scalar ids (a fixed-asset sale line names its asset by id, like every other link of a line).
  await tx.salesInvoiceLine.createMany({ data: rows.map((r, i) => ({ ...r, ...saleColumns(lines[i]), invoiceId: created.id })) });
  return { id: created.id, replayed: false };
}

/** «إنشاء فاتورة من الطلب»: a draft of what is left to invoice (or only what was delivered and not invoiced). */
export async function draftFromOrder(orderId: string, opts: { basis?: "REMAINING" | "DELIVERED"; family?: InvoiceFamily; deliveryIds?: string[]; requestKey?: string | null }, ctx: AuditContext) {
  const facts = await orderInvoicing(prisma, orderId);
  if (!facts) throw refuseInv("ORDER_NOT_FOUND");
  const basis = opts.basis ?? "REMAINING";
  const lines = facts.lines.flatMap((l) => {
    let qty = new Decimal(basis === "DELIVERED" ? l.deliveredNotInvoiced : l.remaining);
    let deliveryId: string | null = null;
    if (opts.deliveryIds?.length) {
      const ds = l.deliveries.filter((d) => opts.deliveryIds!.includes(d.id) && !d.invoiced);
      if (!ds.length) return [];
      qty = Decimal.min(ds.reduce((s, d) => s.plus(d.quantity), ZERO), new Decimal(l.remaining));
      deliveryId = ds.length === 1 ? ds[0].id : null;
    }
    if (qty.lessThanOrEqualTo(0)) return [];
    return [{
      description: l.description, descriptionEn: l.descriptionEn, skuCode: l.skuCode, productSkuId: l.productSkuId, orderItemId: l.orderItemId, deliveryId,
      quantity: qty.toString(), unit: l.unit, unitPrice: l.price.unitPrice, discountPercent: l.price.discountPercent,
      taxCategory: "S", taxRatePercent: l.price.taxRatePercent ?? undefined,
    }];
  });
  if (!lines.length) throw refuseInv("NOTHING_TO_INVOICE");
  const settings = await readInvoiceSettings(prisma);
  void settings;
  const today = riyadhStamp(new Date()).day;
  const lastDelivery = facts.lines.flatMap((l) => l.deliveries.map((d) => d.date ?? "")).sort().at(-1) || null;
  return createDraft({
    customerId: facts.order.customerId, orderId, lines, family: opts.family,
    supplyDate: lastDelivery ?? today, source: opts.deliveryIds?.length ? "DELIVERY" : "ORDER", requestKey: opts.requestKey ?? null,
  }, ctx);
}

/**
 * ON_DELIVERY invoicing point: a recorded delivery opens (or extends) a DRAFT for what it shipped — one open
 * delivery draft per order. Called after the delivery committed; a failure never undoes the delivery (the
 * delivered quantity stays on «إنشاء فاتورة من الطلب»). Idempotent per delivery.
 */
export async function draftOnDelivery(deliveryId: string, actorId: string): Promise<{ id: string } | null> {
  const settings = await readInvoiceSettings(prisma);
  if (settings.invoicingPoint !== "ON_DELIVERY") return null;
  const dl = await prisma.delivery.findUnique({ where: { id: deliveryId }, select: { id: true, orderItem: { select: { orderId: true } } } });
  if (!dl) return null;
  const orderId = dl.orderItem.orderId;
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { actorId, reason: "invoicing point: on delivery" });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"sinv:order:" + orderId}, 0))`;
    if (await tx.salesInvoiceLine.findFirst({ where: { deliveryId, invoice: { status: { in: ["DRAFT", "ISSUED"] } } }, select: { id: true } })) return null;
    const facts = await orderInvoicing(tx, orderId);
    const l = facts?.lines.find((x) => x.deliveries.some((d) => d.id === deliveryId));
    const d = l?.deliveries.find((x) => x.id === deliveryId);
    if (!facts || !l || !d) return null;
    const qty = Decimal.min(new Decimal(d.quantity), new Decimal(l.remaining));
    if (qty.lessThanOrEqualTo(0)) return null;
    const line = parseLines([{ description: l.description, descriptionEn: l.descriptionEn, skuCode: l.skuCode, productSkuId: l.productSkuId, orderItemId: l.orderItemId, deliveryId, quantity: qty.toString(), unit: l.unit, unitPrice: l.price.unitPrice, discountPercent: l.price.discountPercent, taxCategory: "S", taxRatePercent: l.price.taxRatePercent ?? undefined }]).lines;
    await assertNotOverInvoiced(tx, line, orderId);
    const open = await tx.salesInvoice.findFirst({ where: { orderId, status: "DRAFT", kind: "INVOICE", source: "DELIVERY" }, orderBy: { createdAt: "desc" }, include: { lines: { orderBy: LINE_ORDER } } });
    if (open) {
      const all = [...open.lines.map(toClean), ...line];
      const { priced, rows } = lineRows(all);
      await tx.salesInvoiceLine.create({ data: { invoiceId: open.id, ...rows[rows.length - 1] } });
      await tx.salesInvoice.update({ where: { id: open.id }, data: { ...totalsData(priced), supplyDate: dateOf(d.date) } });
      return { id: open.id };
    }
    const customer = facts.customer;
    const { priced, rows } = lineRows(line);
    const created = await tx.salesInvoice.create({
      data: {
        kind: "INVOICE", family: "STANDARD", status: "DRAFT", customerId: customer.id, orderId, buyer: buyerFromCustomer(customer) as unknown as Prisma.InputJsonValue,
        supplyDate: dateOf(d.date), paymentTermsDays: customer.paymentTermsDays ?? settings.defaultTermsDays, source: "DELIVERY", requestKey: `delivery:${deliveryId}`,
        // Q-F4: the selling site (the order's location), never the site the delivery shipped from.
        branchId: await defaultInvoiceBranch(tx, { orderId, actorId }),
        createdById: actorId, ...totalsData(priced),
      },
      select: { id: true },
    });
    await tx.salesInvoiceLine.createMany({ data: rows.map((r) => ({ ...r, invoiceId: created.id })) });
    // «طلبات الفواتير» (WP-C): the delivery draft goes to the accountant's queue, requested by the dispatcher.
    await queueAutomaticDraft(tx, created.id, actorId);
    return { id: created.id };
  }, TX_OPTS);
}

/**
 * «بيع أصل ثابت» (WP-F): the sale-line columns of a stored row (kept outside lineRows / toClean on purpose: an ITEM line
 * takes the database defaults; a credit / debit note's lines are ITEM_ONLY).
 */
function saleColumns(l: CleanLine | undefined) {
  return l?.kind === "FIXED_ASSET_SALE" ? { kind: "FIXED_ASSET_SALE", fixedAssetId: l.fixedAssetId ?? null, disposalKind: l.disposalKind ?? "SALE" } : {};
}

/** A stored line back into the editor's shape. */
export function toClean(l: { description: string; descriptionEn: string | null; productSkuId: string | null; orderItemId: string | null; deliveryId: string | null; originalLineId: string | null; skuCode: string | null; quantity: { toString(): string }; unit: string; unitPrice: { toString(): string }; discountPercent: { toString(): string }; taxCategory: string; taxRatePercent: { toString(): string }; exemptionReasonCode: string | null; exemptionReason: string | null }): CleanLine {
  return {
    description: l.description, descriptionEn: l.descriptionEn, productSkuId: l.productSkuId, orderItemId: l.orderItemId, deliveryId: l.deliveryId, originalLineId: l.originalLineId,
    skuCode: l.skuCode, quantity: D(l.quantity), unit: l.unit === "KG" ? "KG" : "UNIT", unitPrice: D(l.unitPrice), discountPercent: D(l.discountPercent),
    taxCategory: l.taxCategory as CleanLine["taxCategory"], taxRatePercent: D(l.taxRatePercent), exemptionReasonCode: l.exemptionReasonCode, exemptionReason: l.exemptionReason,
    // A copy (a credit note's line, the issue re-check) is priced from the stored NET; the typed gross stays on the original.
    priceIncludesVat: false, enteredGrossUnitPrice: null,
  };
}

export async function lockDocument(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "SalesInvoice" WHERE "id" = ${id} FOR UPDATE`;
  if (!rows[0]) throw refuseInv("NOT_FOUND");
  return rows[0];
}

export type DraftPatch = { family?: unknown; lines?: unknown; buyer?: unknown; supplyDate?: unknown; supplyEndDate?: unknown; paymentTermsDays?: unknown; notes?: unknown; reasonCode?: unknown; reason?: unknown; branchId?: unknown };

/** Who is saving (the route passes the actor's abilities): an issuer may correct a requested draft (compliance only). */
export type DraftEditor = { canIssue: boolean; canSellAssets?: boolean };

const headerOf = (d: { family: string; buyer: unknown; supplyDate: Date | null; supplyEndDate: Date | null; paymentTermsDays: number | null; notes: string | null; reasonCode: string | null; reason: string | null }) => ({
  family: d.family, buyer: d.buyer, supplyDate: dayOf(d.supplyDate), supplyEndDate: dayOf(d.supplyEndDate), paymentTermsDays: d.paymentTermsDays, notes: d.notes, reasonCode: d.reasonCode, reason: d.reason,
});

/**
 * Save a draft (header and / or lines). Lines replace the draft's lines.
 * «طلب فاتورة ضريبية» (WP-C, council Q-F3): once requested, the requester cannot edit it (REQUEST_LOCKED — withdraw
 * it first); an issuer (`editor.canIssue`) corrects only the compliance fields — the buyer's particulars, the family,
 * the tax category / exemption, the supply dates, the terms and the notes. Price, quantity, discount, the set of lines
 * and the customer are refused (REQUEST_COMMERCIAL_LOCKED: «إعادة إلى المبيعات»). Each correction is recorded
 * (EDITED_BY_ACCOUNTANT, with the field diff).
 */
export async function updateDraft(id: string, patch: DraftPatch, ctx: AuditContext, editor: DraftEditor = { canIssue: false }) {
  const parsed = patch.lines !== undefined ? parseLines(patch.lines) : null;
  if (parsed?.problems.length) throw refuseWith("LINES_INVALID", { problems: parsed.problems });
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const row = await lockDocument(tx, id);
    if (row.status !== "DRAFT") throw refuseInv("DRAFT_ONLY");
    const doc = (await loadDocument(tx, id))!;
    const requested = !!doc.requestedAt;
    if (requested && !editor.canIssue) throw refuseInv("REQUEST_LOCKED");
    if (parsed && doc.kind === "INVOICE") assertAssetLinesAllowed(parsed.lines.filter((l, i) => !(l.kind === "FIXED_ASSET_SALE" && doc.lines[i]?.kind === "FIXED_ASSET_SALE" && doc.lines[i]?.fixedAssetId === l.fixedAssetId)), !!editor.canSellAssets);
    if (requested && parsed) {
      const changed = commercialChanges(doc.lines.map((l) => ({ ...l })), parsed.lines.map((l) => ({ ...l })));
      if (changed.length) throw refuseWith("REQUEST_COMMERCIAL_LOCKED", { fields: changed }, `(${changed.slice(0, 6).join(", ")})`);
    }
    const data: Prisma.SalesInvoiceUpdateInput = {};
    if (patch.family !== undefined && doc.kind === "INVOICE") data.family = patch.family === "SIMPLIFIED" ? "SIMPLIFIED" : "STANDARD";
    if (patch.buyer !== undefined) data.buyer = parseBuyer(patch.buyer, doc.buyer as BuyerParticulars) as unknown as Prisma.InputJsonValue;
    if (patch.supplyDate !== undefined) data.supplyDate = dateOf(asDay(patch.supplyDate));
    if (patch.supplyEndDate !== undefined) data.supplyEndDate = dateOf(asDay(patch.supplyEndDate));
    if (patch.paymentTermsDays !== undefined) data.paymentTermsDays = termsOf(patch.paymentTermsDays, doc.paymentTermsDays ?? 30);
    if (patch.notes !== undefined) data.notes = notesOf(patch.notes);
    // «الموقع»: editable while a draft (frozen at issue — sinv_invoice_guard).
    const assetBranch = parsed && doc.kind === "INVOICE" ? await assetSaleBranch(tx, parsed.lines) : null;
    const branchId = assetBranch ?? (await parseBranchId(tx, patch.branchId));
    if (branchId !== undefined) data.branch = branchId ? { connect: { id: branchId } } : { disconnect: true };
    if (doc.kind !== "INVOICE") {
      if (patch.reasonCode !== undefined) {
        if (!(NOTE_REASONS as readonly unknown[]).includes(patch.reasonCode)) throw refuseInv("BAD_INPUT", "reasonCode.", "سبب الإصدار غير معروف.");
        data.reasonCode = patch.reasonCode as NoteReason;
      }
      if (patch.reason !== undefined) data.reason = notesOf(patch.reason);
    }
    if (parsed) {
      let lines = parsed.lines;
      if (doc.kind !== "INVOICE") lines = noteLinesFrom(doc, lines);
      if (doc.kind === "INVOICE") {
        if (!doc.orderId && lines.some((l) => l.orderItemId)) throw refuseInv("BAD_INPUT", "Lines name order lines of no order.", "بنود مرتبطة بطلب غير محدد.");
        await assertNotOverInvoiced(tx, lines, doc.orderId, doc.id);
      }
      const { priced, rows } = lineRows(lines);
      await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });
      if (rows.length) await tx.salesInvoiceLine.createMany({ data: rows.map((r, i) => ({ ...r, ...saleColumns(lines[i]), invoiceId: id })) });
      Object.assign(data, totalsData(priced));
    }
    const after = await tx.salesInvoice.update({ where: { id }, data, include: { lines: { orderBy: LINE_ORDER } } });
    if (requested) {
      const diff = correctionDiff({ header: headerOf(doc), lines: doc.lines.map((l) => ({ ...l })) }, { header: headerOf(after), lines: after.lines.map((l) => ({ ...l })) });
      if (diff) await writeRequestEvent(tx, { invoiceId: id, kind: "EDITED_BY_ACCOUNTANT", actorId: ctx.actorId, diff });
    }
    return { id };
  }, TX_OPTS);
}

/** A credit note's lines inherit the original line's item, unit and tax; quantity and price are the credit's. */
function noteLinesFrom(doc: { kind: string; originalInvoiceId: string | null }, lines: CleanLine[]): CleanLine[] {
  if (doc.kind === "CREDIT_NOTE" && lines.some((l) => !l.originalLineId)) throw refuseInv("BAD_INPUT", "Each credit note line names the invoice line it credits.", "كل بند في الإشعار الدائن يحدد بند الفاتورة الذي يخفّضه.");
  return lines.map((l) => ({ ...l, ...ITEM_ONLY, orderItemId: null }));
}

/** A note's line is never itself an asset sale: it credits / debits one (the posting reads the original line's kind). */
const ITEM_ONLY = { kind: "ITEM" as const, fixedAssetId: null, disposalKind: null };

export async function cancelDraft(id: string, reason: string, ctx: AuditContext) {
  const r = (reason ?? "").trim();
  if (r.length < 3) throw refuseInv("REASON_REQUIRED");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: r });
    const row = await lockDocument(tx, id);
    if (row.status === "CANCELLED") throw refuseInv("ALREADY_CANCELLED");
    if (row.status !== "DRAFT") throw refuseInv("DRAFT_ONLY");
    const was = await tx.salesInvoice.findUniqueOrThrow({ where: { id }, select: { requestedAt: true } });
    await tx.salesInvoice.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: ctx.actorId, cancelReason: r.slice(0, 500), requestedAt: null } });
    if (was.requestedAt) await writeRequestEvent(tx, { invoiceId: id, kind: "CANCELLED", actorId: ctx.actorId, reason: r.slice(0, 1000) });
    return { id, status: "CANCELLED" };
  }, TX_OPTS);
}

// ── credit / debit notes ────────────────────────────────────────────────────────────────────────────

export type NoteInput = { kind: "CREDIT_NOTE" | "DEBIT_NOTE"; reasonCode: unknown; reason: unknown; lines?: unknown; full?: boolean };

/** A note DRAFT against an issued invoice. A credit note's lines come from the original's (full, or the given ones). */
export async function createNote(originalId: string, input: NoteInput, ctx: AuditContext) {
  if (!(NOTE_REASONS as readonly unknown[]).includes(input.reasonCode)) throw refuseInv("BAD_INPUT", "reasonCode.", "اختر سبب الإصدار.");
  const reason = notesOf(input.reason);
  if (!reason || reason.length < 3) throw refuseInv("REASON_REQUIRED");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const orig = await loadDocument(tx, originalId);
    if (!orig) throw refuseInv("NOT_FOUND");
    if (orig.status !== "ISSUED" || orig.kind !== "INVOICE") throw refuseInv("ORIGINAL_NOT_ISSUED");
    let lines: CleanLine[];
    if (input.kind === "CREDIT_NOTE") {
      const credited = await creditedPerLine(tx, orig.lines.map((l) => l.id));
      if (input.full || input.lines === undefined) {
        lines = orig.lines
          .filter((o) => D(o.lineNet).minus(credited.get(o.id) ?? ZERO).greaterThan(0))
          .map((o): CleanLine => ({ ...toClean(o), ...ITEM_ONLY, originalLineId: o.id, orderItemId: null }));
        if (!lines.length) throw refuseInv("OVER_CREDITED", "(the invoice is fully credited)", "(الفاتورة مخفّضة بالكامل)");
        if (credited.size) throw refuseInv("OVER_CREDITED", "(part of the invoice is credited already: choose the lines)", "(خُفّض جزء من الفاتورة مسبقًا: اختر البنود)");
      } else {
        const p = parseLines(input.lines);
        if (p.problems.length) throw refuseWith("LINES_INVALID", { problems: p.problems });
        lines = p.lines.map((l) => {
          const o = orig.lines.find((x) => x.id === l.originalLineId);
          if (!o) throw refuseInv("BAD_INPUT", "A credit note line names a line of the invoice.", "بند الإشعار يحدد بندًا من الفاتورة.");
          return { ...toClean(o), ...ITEM_ONLY, quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: l.discountPercent, originalLineId: o.id, orderItemId: null };
        });
      }
    } else {
      const p = parseLines(input.lines ?? []);
      if (p.problems.length) throw refuseWith("LINES_INVALID", { problems: p.problems });
      lines = p.lines.map((l) => ({ ...l, ...ITEM_ONLY, orderItemId: null }));
    }
    const { priced, rows } = lineRows(lines);
    const created = await tx.salesInvoice.create({
      data: {
        kind: input.kind, family: orig.family, status: "DRAFT", customerId: orig.customerId, orderId: orig.orderId, quoteId: orig.quoteId,
        // A note sits at its original's location (its revenue reversal lands in the same column).
        branchId: orig.branchId,
        originalInvoiceId: orig.id, reasonCode: input.reasonCode as string, reason,
        buyer: orig.buyer as Prisma.InputJsonValue, supplyDate: orig.supplyDate, paymentTermsDays: input.kind === "DEBIT_NOTE" ? orig.paymentTermsDays : 0,
        source: "MANUAL", createdById: ctx.actorId, ...totalsData(priced),
      },
      select: { id: true },
    });
    await tx.salesInvoiceLine.createMany({ data: rows.map((r) => ({ ...r, invoiceId: created.id })) });
    return { id: created.id };
  }, TX_OPTS);
}

async function creditedPerLine(db: Tx | typeof prisma, originalLineIds: string[]): Promise<Map<string, Decimal>> {
  const rows = originalLineIds.length ? await db.salesInvoiceLine.findMany({
    where: { originalLineId: { in: originalLineIds }, invoice: { kind: "CREDIT_NOTE", status: { in: ["DRAFT", "ISSUED"] } } },
    select: { originalLineId: true, lineNet: true },
  }) : [];
  const out = new Map<string, Decimal>();
  for (const r of rows) out.set(r.originalLineId!, (out.get(r.originalLineId!) ?? ZERO).plus(D(r.lineNet)));
  return out;
}

/** What is still creditable on each line of an issued invoice (the credit note form). */
export async function creditable(originalId: string) {
  const orig = await loadDocument(prisma, originalId);
  if (!orig) return null;
  const credited = await creditedPerLine(prisma, orig.lines.map((l) => l.id));
  return orig.lines.map((l) => ({ lineId: l.id, quantity: D(l.quantity).toString(), lineNet: D(l.lineNet).toFixed(2), credited: (credited.get(l.id) ?? ZERO).toFixed(2), left: Decimal.max(D(l.lineNet).minus(credited.get(l.id) ?? ZERO), ZERO).toFixed(2) }));
}

// ── issue ───────────────────────────────────────────────────────────────────────────────────────────

export type IssueResult = { id: string; number: string; replayed: boolean; posting: { status: string; entryId?: string; reason?: string }; zatca?: SignedAtIssue };

/**
 * Issue a DRAFT: the database numbers it (gapless per series), the seller and buyer are frozen, the totals are
 * re-derived from the lines (E-10), and the ledger entry is posted in the same transaction (a no-op before
 * activation / go-live). A credit note's credit is applied to its original first. Idempotent: issuing an issued
 * document returns it (no second number, no second entry).
 */
export async function issueDocument(id: string, ctx: AuditContext, now: Date = new Date()): Promise<IssueResult> {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const row = await lockDocument(tx, id);
    if (row.status === "CANCELLED") throw refuseInv("ALREADY_CANCELLED");
    const doc = (await loadDocument(tx, id))!;
    if (row.status === "ISSUED") return { id, number: doc.number!, replayed: true, posting: { status: "replayed" } };
    let sodBypass = false;
    if (doc.kind !== "INVOICE" && doc.createdById === ctx.actorId) {
      // The SoD setting (A5, src/lib/accounting/sod.ts; SIMPLE MODE always allows): the preparer issues their own
      // note only if self-approval is allowed; the bypass is recorded on the document (and in the audit log).
      if (!sodDecision(await sodPolicy(tx), "SELF_APPROVAL")) throw refuseInv("SOD_SELF_ISSUE");
      sodBypass = true;
    }
    const lines = doc.lines.map(toClean);
    const reparsed = parseLines(lines.map((l) => ({ ...l, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), discountPercent: l.discountPercent.toString(), taxRatePercent: l.taxRatePercent.toString() })), { forIssue: true });
    const priced = priceInvoice(lines);
    const seller = await sellerSnapshot(tx);
    const stamp = riyadhStamp(now);
    const supplyDay = dayOf(doc.supplyDate) ?? stamp.day;
    const problems = [
      ...issueProblems({ kind: doc.kind as InvoiceKind, family: doc.family as InvoiceFamily, buyer: doc.buyer as BuyerParticulars, seller, supplyDate: supplyDay, lines, reasonCode: doc.reasonCode, reason: doc.reason, grandTotal: priced.grandTotal }),
      ...reparsed.problems.map((p) => ({ code: p.code, ar: `البند ${p.index + 1}: ${p.ar}`, en: `Line ${p.index + 1}: ${p.en}` })),
    ];
    if (problems.length) throw refuseWith("NOT_READY", { problems });
    const settings = await readInvoiceSettings(tx);
    const series = seriesFor(doc.kind as InvoiceKind, { invoice: settings.invoicePrefix, creditNote: settings.creditNotePrefix, debitNote: settings.debitNotePrefix });
    const acct = await getSettings(tx);
    // «بيع أصل ثابت» (WP-F): a sale line's net posts to FA_DISPOSAL_CLEARING (not revenue); a credit note on one reverses it.
    const originals = doc.kind !== "INVOICE" ? await tx.salesInvoiceLine.findMany({ where: { id: { in: doc.lines.map((l) => l.originalLineId).filter((x): x is string => !!x) } }, select: { id: true, kind: true } }) : [];
    const clearing = doc.lines.map((l) => l.kind === "FIXED_ASSET_SALE" || originals.some((o) => o.id === l.originalLineId && o.kind === "FIXED_ASSET_SALE"));
    if (acct.accountingActive) await assertRolesMapped(tx, [...(doc.kind === "CREDIT_NOTE" ? ["AR", "SALES_RETURNS", "VAT_OUTPUT"] : ["AR", "SALES_REVENUE", "VAT_OUTPUT"]), ...(clearing.some(Boolean) ? ["FA_DISPOSAL_CLEARING"] : [])]);
    const terms = doc.paymentTermsDays ?? 0;
    // «الموقع»: a draft saved without one (before the dimension existed) takes its default now; frozen from here on.
    const branchId = doc.branchId ?? (doc.originalInvoice ? (await tx.salesInvoice.findUnique({ where: { id: doc.originalInvoice.id }, select: { branchId: true } }))?.branchId ?? null : null)
      ?? (await orderBranchId(tx, doc.orderId)) ?? (doc.kind === "INVOICE" ? await defaultInvoiceBranch(tx, { orderId: null, actorId: doc.createdById }) : null);
    // Totals re-derived from the stored lines (a draft saved by an older screen is corrected here, never trusted).
    const { rows } = lineRows(lines);
    for (let i = 0; i < doc.lines.length; i++) {
      const r = rows[i];
      await tx.salesInvoiceLine.update({ where: { id: doc.lines[i].id }, data: { discountAmount: r.discountAmount, lineNet: r.lineNet, lineTax: r.lineTax, lineTotal: r.lineTotal } });
    }
    const issued = await tx.salesInvoice.update({
      where: { id },
      data: {
        status: "ISSUED", series, issuedAt: now, issueDate: dateOf(stamp.day), issueTime: stamp.time, issuedById: ctx.actorId,
        supplyDate: dateOf(supplyDay), dueDate: dateOf(addDays(stamp.day, doc.kind === "CREDIT_NOTE" ? 0 : terms)),
        seller: seller as unknown as Prisma.InputJsonValue, sodBypass, ...totalsData(priced), branchId,
        // «طلبات الفواتير»: an issued document leaves the queue (CHECK SalesInvoice_request_check); the requester stays.
        requestedAt: null,
      },
      select: { id: true, number: true, customerId: true, kind: true, grandTotal: true, taxTotal: true, issueDate: true },
    });
    const posting = await postDocumentIssued(tx, {
      id, kind: doc.kind as InvoiceKind, number: issued.number!, customerId: issued.customerId, issueDate: dayOf(issued.issueDate)!, branchId,
      grandTotal: D(issued.grandTotal), taxTotal: D(issued.taxTotal),
      lines: lines.map((l, i) => ({ lineNet: new Decimal(rows[i].lineNet), productSkuId: l.productSkuId, description: l.description, clearing: clearing[i] })),
    }, ctx.actorId);
    if (doc.kind === "CREDIT_NOTE" && doc.originalInvoiceId) {
      // The credit first settles what the original still owes; any excess stays as the customer's credit. The original
      // is locked first (the order the AR guard locks in), so a receipt applied concurrently cannot be counted twice.
      await tx.$queryRaw`SELECT "id" FROM "SalesInvoice" WHERE "id" = ${doc.originalInvoiceId} FOR UPDATE`;
      const owed = await openAmount(tx, doc.originalInvoiceId);
      const amount = Decimal.min(owed, D(issued.grandTotal));
      if (amount.greaterThan(0)) {
        await tx.arApplication.create({ data: { customerId: issued.customerId, invoiceId: doc.originalInvoiceId, creditNoteId: id, amount: amount.toFixed(2), appliedDate: dateOf(stamp.day)!, createdById: ctx.actorId } });
      }
    }
    await emitAutomationEvent(tx, { eventType: "sales.invoice_status_changed", subjectType: "SalesInvoice", subjectId: id, payload: { from: "DRAFT", to: "ISSUED", kind: doc.kind }, actorId: ctx.actorId });
    // «طلب فاتورة ضريبية»: the history records the issue of a requested draft; the requester and the order's owner are
    // told it can be printed (Sales keeps view / print / PDF through invoices_view and its customer scope).
    if (doc.requestedAt) await writeRequestEvent(tx, { invoiceId: id, kind: "ISSUED", actorId: ctx.actorId });
    await notifyIssued(tx, { id, customerId: issued.customerId, grandTotal: issued.grandTotal, buyer: doc.buyer, orderId: doc.orderId, number: issued.number! }, doc.requestedById, ctx.actorId);
    // A4 — ZATCA Phase 2: when e-invoicing is on, the document takes the EGS unit's next ICV / PIH and is signed in
    // this same transaction (last, so the unit's row lock is held briefly). Off: nothing (A2 behaviour).
    const zatca = await signAtIssue(tx, id, now);
    return { id, number: issued.number!, replayed: false, posting: posting.status === "posted" ? { status: "posted", entryId: posting.entryId } : { status: "skipped", reason: posting.reason }, zatca };
  }, TX_OPTS);
}

/**
 * What would stop a draft from issuing now, without issuing it («soft» mode: the request answers these as warnings;
 * the issue refuses them, NOT_READY). The same checks issueDocument runs before numbering.
 */
export async function draftProblems(db: Tx | typeof prisma, doc: LoadedDocument, now: Date = new Date()) {
  const lines = doc.lines.map(toClean);
  const reparsed = parseLines(lines.map((l) => ({ ...l, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), discountPercent: l.discountPercent.toString(), taxRatePercent: l.taxRatePercent.toString() })), { forIssue: true });
  let grand = ZERO;
  try { grand = priceInvoice(lines).grandTotal; } catch { /* the line problems say why */ }
  const seller = await sellerSnapshot(db as Tx);
  const supplyDay = dayOf(doc.supplyDate) ?? riyadhStamp(now).day;
  return [
    ...issueProblems({ kind: doc.kind as InvoiceKind, family: doc.family as InvoiceFamily, buyer: doc.buyer as BuyerParticulars, seller, supplyDate: supplyDay, lines, reasonCode: doc.reasonCode, reason: doc.reason, grandTotal: grand }),
    ...reparsed.problems.map((p) => ({ code: p.code, ar: `البند ${p.index + 1}: ${p.ar}`, en: `Line ${p.index + 1}: ${p.en}` })),
    ...(lines.length ? [] : [{ code: "NO_LINES", ar: "أضف بندًا واحدًا على الأقل.", en: "Add at least one line." }]),
  ];
}

/** What an issued invoice / debit note still owes: total − Σ APPLIED applications. */
export async function openAmount(db: Tx | typeof prisma, invoiceId: string): Promise<Decimal> {
  const inv = await db.salesInvoice.findUnique({ where: { id: invoiceId }, select: { grandTotal: true, status: true } });
  if (!inv || inv.status !== "ISSUED") return ZERO;
  const agg = await db.arApplication.aggregate({ where: { invoiceId, status: "APPLIED" }, _sum: { amount: true } });
  return D(inv.grandTotal).minus(D(agg._sum.amount));
}

export const isIssued = (s: string) => s === "ISSUED";
export const D_ = D;
export const dayText = dayOf;
