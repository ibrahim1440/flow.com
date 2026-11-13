// R4 (gate, optional item the owner took): the supervisor sees WHAT they approve — the stored request's lines (item, qty,
// unit price, discount), read-only, on the CREDIT_OVERRIDE card. Read from the request's own resume (credit-limit.ts):
//   /api/sales/direct-sale, /api/orders   → the body's lines (a D22 invoice-page line carries its own price / discount;
//                                            otherwise the list price and the sale's discount)
//   /api/orders/[id]/payment-hold         → the held sale's invoice lines (the order's items at list price if none)
//   /api/sales/quotes/[id]/create-order   → the quotation's lines
// Display only: nothing here prices, checks or decides anything — the decision route re-checks as before.
import type { CreditResume } from "./credit-limit";

export type OverrideLine = { name: string; nameEn: string; qty: string; unitPrice: string; discountPercent: string; taxRatePercent?: string; lineNet?: string; lineGross?: string };

/** Abu Fahd R3 A5: each line's total — net (qty × price − discount) and with its VAT (the line's rate, else 15 %). */
function withTotals(l: OverrideLine): OverrideLine {
  const q = Number(l.qty), p = Number(l.unitPrice), d = Number(l.discountPercent || 0), t = Number(l.taxRatePercent ?? 15);
  if (!Number.isFinite(q) || !Number.isFinite(p)) return l;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const net = r2(r2(q * p) * (1 - (Number.isFinite(d) ? d : 0) / 100));
  return { ...l, lineNet: net.toFixed(2), lineGross: r2(net * (1 + (Number.isFinite(t) ? t : 15) / 100)).toFixed(2) };
}

type Db = {
  productSKU: { findMany(a: unknown): Promise<{ id: string; skuCode: string; name: string | null; nameAr: string | null; price: number }[]> };
  salesInvoice: { findFirst(a: unknown): Promise<{ lines: { description: string; descriptionEn: string | null; quantity: { toString(): string }; unitPrice: { toString(): string }; discountPercent: { toString(): string }; taxRatePercent: { toString(): string } }[] } | null> };
  orderItem: { findMany(a: unknown): Promise<{ productSkuId: string | null; quantityUnits: number | null }[]> };
  quoteLine: { findMany(a: unknown): Promise<{ productSkuId: string | null; description: string | null; quantity: { toString(): string }; unitPrice: { toString(): string }; discountPercent: { toString(): string }; taxRatePercent: { toString(): string } }[]> };
};

const MAX = 30;
const n2 = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x.toFixed(2) : null; };
const qty = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? String(Number(x.toFixed(3))) : "—"; };

async function skuNames(db: Db, ids: string[]) {
  const rows = ids.length ? await db.productSKU.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, skuCode: true, name: true, nameAr: true, price: true } }) : [];
  return new Map(rows.map((s) => [s.id, s]));
}

export async function overrideRequestLines(db: Db, resume: CreditResume | null): Promise<OverrideLine[]> {
  return (await rawLines(db, resume)).map(withTotals);
}

async function rawLines(db: Db, resume: CreditResume | null): Promise<OverrideLine[]> {
  if (!resume) return [];
  const held = resume.path.match(/^\/api\/orders\/([^/]+)\/payment-hold$/)?.[1];
  const quote = resume.path.match(/^\/api\/sales\/quotes\/([^/]+)\/create-order$/)?.[1];
  if (held) {
    const inv = await db.salesInvoice.findFirst({ where: { orderId: held }, orderBy: { createdAt: "desc" }, select: { lines: { orderBy: { position: "asc" }, take: MAX, select: { description: true, descriptionEn: true, quantity: true, unitPrice: true, discountPercent: true, taxRatePercent: true } } } });
    if (inv && inv.lines.length) return inv.lines.map((l) => ({ name: l.description, nameEn: l.descriptionEn || l.description, qty: qty(l.quantity.toString()), unitPrice: n2(l.unitPrice.toString()) ?? "—", discountPercent: n2(l.discountPercent.toString()) ?? "0.00", taxRatePercent: l.taxRatePercent.toString() }));
    const items = (await db.orderItem.findMany({ where: { orderId: held }, orderBy: { createdAt: "asc" }, take: MAX, select: { productSkuId: true, quantityUnits: true } })).filter((i) => i.productSkuId);
    const skus = await skuNames(db, items.map((i) => i.productSkuId!));
    return items.map((i) => { const s = skus.get(i.productSkuId!); return { name: s?.nameAr || s?.name || s?.skuCode || "—", nameEn: s?.name || s?.skuCode || "—", qty: qty(i.quantityUnits), unitPrice: s ? s.price.toFixed(2) : "—", discountPercent: "0.00" }; });
  }
  if (quote) {
    const lines = await db.quoteLine.findMany({ where: { quoteId: quote }, orderBy: { position: "asc" }, take: MAX, select: { productSkuId: true, description: true, quantity: true, unitPrice: true, discountPercent: true, taxRatePercent: true } });
    const skus = await skuNames(db, lines.map((l) => l.productSkuId).filter((x): x is string => !!x));
    return lines.map((l) => { const s = l.productSkuId ? skus.get(l.productSkuId) : undefined; return { name: s?.nameAr || s?.name || l.description || "—", nameEn: s?.name || l.description || "—", qty: qty(l.quantity.toString()), unitPrice: n2(l.unitPrice.toString()) ?? "—", discountPercent: n2(l.discountPercent.toString()) ?? "0.00", taxRatePercent: l.taxRatePercent.toString() }; });
  }
  const body = resume.body ?? {};
  const raw = Array.isArray(body.lines) ? body.lines : Array.isArray(body.items) ? body.items : [];
  const lines = (raw as Record<string, unknown>[]).slice(0, MAX).filter((l) => l && typeof l.productSkuId === "string" && l.productSkuId);
  const skus = await skuNames(db, lines.map((l) => l.productSkuId as string));
  const saleDiscount = n2(body.discountPercent) ?? "0.00";
  return lines.map((l) => {
    const s = skus.get(l.productSkuId as string);
    return { name: s?.nameAr || s?.name || s?.skuCode || "—", nameEn: s?.name || s?.skuCode || "—", qty: qty(l.quantityUnits ?? l.quantity), unitPrice: n2(l.unitPrice) ?? (s ? s.price.toFixed(2) : "—"), discountPercent: n2(l.discountPercent) ?? saleDiscount, ...(n2(l.taxRatePercent) ? { taxRatePercent: n2(l.taxRatePercent)! } : {}) };
  });
}
