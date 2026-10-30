import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { NON_BUSINESS_ORDER_STATUSES, USUAL_ITEMS_WINDOW_DAYS } from "@/lib/services/customers/aggregates";
import { invoicingFromRow } from "@/lib/services/settings/sections";

/**
 * «عرض سعر» from the customer page (batch 24 council fix round 1, P0-7).
 *
 *  · `reusableDraft` (fix round 2, item 2) — a second tap never raises another number (Q-0001, Q-0002…): the latest
 *    DRAFT of the same deal raised by the same person is reopened, lines or not, as it stands. Only once that draft is
 *    issued (then accepted / rejected / expired / superseded) or deleted does a tap start a new one. The caller holds the
 *    deal row lock (`lockDealForQuote`) so two fast taps cannot both miss it.
 *  · `prefillLines` — the new draft starts with what the customer usually takes, at the last prices:
 *      1. the lines of the customer's most recent quotation that was issued or accepted (its SKUs, quantities, prices);
 *      2. else the customer's usual items from the orders of the «الأصناف المعتادة» window (USUAL_ITEMS_WINDOW_DAYS),
 *         one line per item, the monthly kilograms as the quantity, the price of the last ISSUED or ACCEPTED quotation
 *         line for that product or description to this customer (never a draft or a rejected price — fix round 2,
 *         item 10), else the SKU's list price, else 0 (the rep types it);
 *    each with the company's default VAT (Settings › Invoicing & tax). Nothing is issued: it is a draft the rep edits.
 */
type Tx = PrismaNS.TransactionClient;
const DAY = 86_400_000;

/** Serialise «عرض سعر» taps on one deal: a row lock on the deal until the transaction ends. */
export async function lockDealForQuote(tx: Tx, opportunityId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Opportunity" WHERE "id" = ${opportunityId} FOR UPDATE`;
}

export async function reusableDraft(tx: Tx, opportunityId: string, actorId: string) {
  const d = await tx.quote.findFirst({
    where: { opportunityId, status: "DRAFT", createdById: actorId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, quoteNumber: true, revision: true, _count: { select: { lines: true } } },
  });
  return d ? { quote: { id: d.id, quoteNumber: d.quoteNumber, revision: d.revision }, lineCount: d._count.lines } : null;
}

export type PrefillLine = {
  productSkuId: string | null; description: string | null; quantity: string; unit: string;
  unitPrice: string; discountPercent: string; taxRatePercent: string;
};

export async function prefillLines(tx: Tx, customerId: string | null, now: Date = new Date()): Promise<PrefillLine[]> {
  if (!customerId) return [];
  const vat = invoicingFromRow(await tx.systemConfig.findUnique({ where: { id: "singleton" } }) as never).effectiveDefaultVatPercent;
  const last = await tx.quote.findFirst({
    where: { customerId, status: { in: ["ISSUED", "ACCEPTED"] }, lines: { some: {} } },
    orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
    select: { lines: { orderBy: { position: "asc" }, select: { productSkuId: true, description: true, quantity: true, unit: true, unitPrice: true, discountPercent: true, taxRatePercent: true } } },
  });
  if (last?.lines.length) {
    return last.lines.slice(0, 20).map((l) => ({
      productSkuId: l.productSkuId, description: l.description, quantity: l.quantity.toString(), unit: l.unit,
      unitPrice: l.unitPrice.toFixed(2), discountPercent: l.discountPercent.toString(), taxRatePercent: l.taxRatePercent.toString(),
    }));
  }
  // The usual items (orders of the «الأصناف المعتادة» window), one line per SKU (or per name for a line without one).
  const since = new Date(now.getTime() - USUAL_ITEMS_WINDOW_DAYS * DAY);
  const items = await tx.orderItem.findMany({
    where: { order: { customerId, createdAt: { gte: since }, status: { notIn: [...NON_BUSINESS_ORDER_STATUSES] } } },
    select: { productSkuId: true, beanTypeName: true, quantityKg: true, productSku: { select: { price: true, unitOfMeasure: true, isActive: true } } },
  });
  const groups = new Map<string, { productSkuId: string | null; name: string; kg: number; listPrice: number; unit: string }>();
  for (const i of items) {
    const sku = i.productSku?.isActive ? i.productSkuId : null;
    const key = sku ?? `name:${i.beanTypeName.trim()}`;
    if (!sku && !i.beanTypeName.trim()) continue;
    const g = groups.get(key) ?? { productSkuId: sku, name: i.beanTypeName.trim(), kg: 0, listPrice: Number(i.productSku?.price ?? 0), unit: sku && i.productSku?.unitOfMeasure === "UNIT" ? "UNIT" : "KG" };
    g.kg += Number.isFinite(i.quantityKg) ? i.quantityKg : 0;
    groups.set(key, g);
  }
  const months = USUAL_ITEMS_WINDOW_DAYS / 30;
  const usual = [...groups.values()]
    .map((g) => ({ ...g, perMonth: Math.max(1, Math.round(g.kg / months)) }))
    .filter((g) => g.kg > 0)
    .sort((a, b) => b.perMonth - a.perMonth || a.name.localeCompare(b.name))
    .slice(0, 5);
  if (!usual.length) return [];
  // The last price this customer was quoted for each product / description.
  const priced = await tx.quoteLine.findMany({
    where: { quote: { customerId, status: { in: ["ISSUED", "ACCEPTED"] } } },
    orderBy: { quote: { createdAt: "desc" } },
    take: 200,
    select: { productSkuId: true, description: true, unitPrice: true },
  });
  const lastPrice = (g: { productSkuId: string | null; name: string }) =>
    priced.find((p) => (g.productSkuId ? p.productSkuId === g.productSkuId : !p.productSkuId && (p.description ?? "").trim() === g.name))?.unitPrice.toFixed(2);
  return usual.map((g) => ({
    productSkuId: g.productSkuId, description: g.productSkuId ? null : g.name,
    quantity: String(g.unit === "UNIT" ? Math.max(1, Math.round(g.perMonth)) : g.perMonth), unit: g.unit,
    unitPrice: lastPrice(g) ?? (g.listPrice > 0 ? g.listPrice.toFixed(2) : "0"), discountPercent: "0", taxRatePercent: vat,
  }));
}
