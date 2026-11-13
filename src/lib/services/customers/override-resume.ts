// P1 gate R5 B6: an over-limit request's resume (the refused request kept to send again after the approval) is a client
// value — it is checked here, on the server, before the request is stored, and it decides the request's kind and amount:
//   /api/orders/[id]/payment-hold        a held (REJECTED) direct sale of the SAME customer, the requester's own order (or
//                                        the requester holds customers › sales_hold) → DIRECT_SALE, the amount = what is
//                                        left unpaid of it (heldOrderCreditPosition) — the client's amount is ignored
//   /api/sales/quotes/[id]/create-order  a quotation of the SAME customer → QUOTE_ORDER, the amount = its grand total
//   /api/sales/direct-sale               the stored body's customer is the request's → DIRECT_SALE, the amount = the body
//                                        priced on the server (lines with their own terms, or the list price and discount)
//   /api/orders                          the stored body's customer is the request's → ORDER, the amount = its lines at
//                                        the list price with VAT (the value the order's own credit check uses)
// Anything else (another customer, another rep's order, a path that does not resolve) is refused: 409 RESUME_INVALID.
import { Prisma } from "@/generated/prisma/client";
import type { CreditKind } from "./credit-limit";
import type { CreditResume } from "./credit-limit";

type Tx = Prisma.TransactionClient;
const bad = (ar: string, en: string) => ({ _appCode: 409, code: "RESUME_INVALID", message: ar, error: ar, errorAr: ar, errorEn: en });

export type ResumeCheck = { kind: CreditKind; amount: Prisma.Decimal; heldOrderId: string | null; commitment: Prisma.Decimal | null; total: Prisma.Decimal | null };

export async function checkResume(tx: Tx, actor: { id: string; permissions: unknown }, customerId: string, resume: CreditResume): Promise<ResumeCheck> {
  const held = resume.path.match(/^\/api\/orders\/([^/]+)\/payment-hold$/)?.[1];
  const quote = resume.path.match(/^\/api\/sales\/quotes\/([^/]+)\/create-order$/)?.[1];
  if (held) {
    const o = await tx.order.findUnique({ where: { id: held }, select: { id: true, customerId: true, ownerId: true, paymentHold: true, status: true } });
    const { mayOverrideCredit } = await import("./credit-limit");
    if (!o || o.customerId !== customerId || (o.ownerId !== actor.id && !mayOverrideCredit(actor.permissions as never))) throw bad("الطلب الموقوف مو لهالعميل أو مو طلبك.", "The held order is not this customer's or not yours.");
    if (o.paymentHold !== "REJECTED" || o.status === "Cancelled") throw bad("الطلب ما هو موقوف برفض إيصال.", "The order is not held by a rejected receipt.");
    const { heldOrderCreditPosition } = await import("@/lib/services/orders/payment-hold");
    const pos = (await heldOrderCreditPosition(tx, o.id))!;
    if (!pos.order.greaterThan(0)) throw bad("ما بقى شي من الطلب يحتاج اعتماد.", "Nothing is left unpaid on the order.");
    return { kind: "DIRECT_SALE", amount: new Prisma.Decimal(pos.order.toFixed(2)), heldOrderId: o.id, commitment: new Prisma.Decimal(pos.commitment.toFixed(2)), total: new Prisma.Decimal(pos.total.toFixed(2)) };
  }
  if (quote) {
    const q = await tx.quote.findUnique({ where: { id: quote }, select: { id: true, grandTotal: true, opportunity: { select: { customerId: true } } } });
    if (!q || q.opportunity?.customerId !== customerId) throw bad("عرض السعر مو لهالعميل.", "The quotation is not this customer's.");
    return { kind: "QUOTE_ORDER", amount: new Prisma.Decimal(q.grandTotal.toString()), heldOrderId: null, commitment: null, total: null };
  }
  const body = resume.body ?? {};
  if (body.customerId !== customerId) throw bad("الطلب المحفوظ مو لهالعميل.", "The stored request is not this customer's.");
  if (resume.path === "/api/sales/direct-sale") {
    const { hasTerms, priceTerms } = await import("@/lib/services/sales/direct-sale-terms");
    const { priceDirectSale } = await import("@/lib/services/sales/direct-sale");
    let gross: string;
    try {
      if (hasTerms(body as never)) gross = (await priceTerms(tx, body.lines, new Prisma.Decimal(100), "0")).quote.gross;
      else {
        const d = Number(body.discountPercent ?? 0);
        gross = (await priceDirectSale(tx, body.lines, new Prisma.Decimal(Number.isFinite(d) && d >= 0 && d <= 100 ? d : 0))).gross;
      }
    } catch { throw bad("بنود الطلب المحفوظ غير صالحة.", "The stored request's lines are not valid."); }
    return { kind: "DIRECT_SALE", amount: new Prisma.Decimal(gross), heldOrderId: null, commitment: null, total: null };
  }
  if (resume.path === "/api/orders") {
    const items = Array.isArray(body.items) ? (body.items as { productSkuId?: unknown; quantityUnits?: unknown }[]) : [];
    const lines = items.filter((i) => typeof i?.productSkuId === "string" && Number.isInteger(Number(i.quantityUnits)) && Number(i.quantityUnits) > 0)
      .map((i) => ({ productSkuId: i.productSkuId as string, quantityUnits: Number(i.quantityUnits) }));
    if (!lines.length) throw bad("بنود الطلب المحفوظ غير صالحة.", "The stored request's lines are not valid.");
    const skus = await tx.productSKU.findMany({ where: { id: { in: lines.map((l) => l.productSkuId) } }, select: { id: true, price: true } });
    const { linesValue } = await import("./exposure");
    return { kind: "ORDER", amount: new Prisma.Decimal(linesValue(lines.map((l) => ({ quantityUnits: l.quantityUnits, productSku: skus.find((k) => k.id === l.productSkuId) ?? null }))).toFixed(2)), heldOrderId: null, commitment: null, total: null };
  }
  throw bad("مسار الطلب المحفوظ غير معروف.", "Unknown stored request.");
}
