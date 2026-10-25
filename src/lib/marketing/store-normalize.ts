// Store data → the marketing mirror. Pure.
//
// The store side speaks ONE documented canonical format — "Hiqbah Store Webhook v1" below —
// which the store link (Salla, through the system's store integration), a middleware, or the CSV
// import produces (docs/marketing/STORE-WEBHOOK.md). It maps the field names most store platforms
// use and refuses anything it cannot read.

import { normalizePhoneForWhatsApp } from "../automation/phone";
import { parseUtm } from "./utm";

export type CanonicalCustomer = { externalId: string; name: string | null; phone: string | null; email: string | null; marketingConsent: boolean | null };

export type CanonicalOrder = {
  externalId: string;
  orderNumber: string | null;
  status: "PENDING" | "PAID" | "FULFILLED" | "CANCELLED" | "REFUNDED" | "PARTIALLY_REFUNDED";
  rawStatus: string | null;
  customer: CanonicalCustomer | null;
  currency: string;
  subtotal: number | null;
  discount: number | null;
  shipping: number | null;
  tax: number | null;
  total: number;
  refunded: number;
  couponCode: string | null;
  placedAt: Date;
  cancelledAt: Date | null;
  landingUrl: string | null;
  referrer: string | null;
  utm: { source?: string; medium?: string; campaign?: string; content?: string; term?: string };
  cartExternalId: string | null;
  lines: { sku: string | null; name: string; qty: number; price: number | null }[];
};

export type CanonicalCart = {
  externalId: string;
  customer: CanonicalCustomer | null;
  value: number | null;
  currency: string;
  recoveryUrl: string | null;
  abandonedAt: Date;
  lines: { sku: string | null; name: string; qty: number; price: number | null }[];
};

export type Normalized = { kind: "order"; order: CanonicalOrder } | { kind: "cart"; cart: CanonicalCart } | { kind: "ignored"; reason: string };

export class StoreDataError extends Error {}

const money = (v: unknown, label: string, required = false): number | null => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new StoreDataError(`${label} missing`);
    return null;
  }
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new StoreDataError(`${label} invalid`);
  return Math.round(n * 100) / 100;
};

const when = (v: unknown, label: string, required = false): Date | null => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new StoreDataError(`${label} missing`);
    return null;
  }
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new StoreDataError(`${label} invalid`);
  return d;
};

const s = (v: unknown, max = 500): string | null => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim().slice(0, max));

/** Status words used by common store platforms → ours. Unknown words are refused, not guessed. */
export function normalizeOrderStatus(raw: string | null | undefined, refunded = 0, total = 0): CanonicalOrder["status"] {
  const t = (raw ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (["cancelled", "canceled", "void", "voided", "ملغي", "ملغى", "deleted"].includes(t)) return "CANCELLED";
  if (["refunded", "مسترجع", "مسترد"].includes(t) || (total > 0 && refunded >= total)) return "REFUNDED";
  if (["partially_refunded", "partial_refund"].includes(t) || refunded > 0) return "PARTIALLY_REFUNDED";
  if (["delivered", "completed", "complete", "fulfilled", "shipped", "تم_التوصيل", "مكتمل", "تم_الشحن"].includes(t)) return "FULFILLED";
  if (["paid", "processing", "in_progress", "ready", "confirmed", "under_review", "قيد_التنفيذ", "مدفوع", "جاري_التجهيز"].includes(t)) return "PAID";
  if (["pending", "pending_payment", "awaiting_payment", "unpaid", "new", "بانتظار_الدفع"].includes(t)) return "PENDING";
  throw new StoreDataError(`unknown order status «${raw}»`);
}

export function customerOf(c: unknown): CanonicalCustomer | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const id = s(o.externalId ?? o.id ?? o.customer_id);
  if (!id) return null;
  const rawPhone = s(o.phone ?? o.mobile ?? o.phone_number);
  const p = rawPhone ? normalizePhoneForWhatsApp(rawPhone) : null;
  const consent = o.marketingConsent ?? o.accepts_marketing ?? o.whatsapp_opt_in;
  return {
    externalId: id,
    name: s(o.name ?? [o.first_name, o.last_name].filter(Boolean).join(" "), 200),
    phone: p && p.ok ? p.phone : null,
    email: s(o.email, 200)?.toLowerCase() ?? null,
    marketingConsent: typeof consent === "boolean" ? consent : null,
  };
}

const linesOf = (v: unknown) =>
  Array.isArray(v)
    ? v.slice(0, 200).map((l) => {
        const o = (l ?? {}) as Record<string, unknown>;
        return { sku: s(o.sku, 100), name: s(o.name ?? o.title, 200) ?? "—", qty: Number(o.qty ?? o.quantity ?? 1) || 1, price: money(o.price, "line price") };
      })
    : [];

/** The canonical format (Hiqbah Store Webhook v1): { type: "order" | "cart", data: {...} } — docs/marketing/STORE-WEBHOOK.md. */
export function fromCanonical(payload: unknown): Normalized {
  const p = payload as { type?: string; data?: Record<string, unknown> } | null;
  if (!p || typeof p !== "object" || !p.data) throw new StoreDataError("payload must be { type, data }");
  const d = p.data;
  if (p.type === "order") {
    const total = money(d.total, "total", true)!;
    const refunded = money(d.refunded, "refunded") ?? 0;
    if (refunded > total) throw new StoreDataError("refunded exceeds total");
    const landingUrl = s(d.landingUrl ?? d.landing_site, 2000);
    const fromUrl = parseUtm(landingUrl);
    const utmIn = (d.utm ?? {}) as Record<string, unknown>;
    return {
      kind: "order",
      order: {
        externalId: s(d.externalId ?? d.id, 100) ?? (() => { throw new StoreDataError("order id missing"); })(),
        orderNumber: s(d.orderNumber ?? d.reference_id ?? d.number, 100),
        rawStatus: s(d.status, 100),
        status: normalizeOrderStatus(s(d.status), refunded, total),
        customer: customerOf(d.customer),
        currency: (s(d.currency, 3) ?? "SAR").toUpperCase(),
        subtotal: money(d.subtotal, "subtotal"), discount: money(d.discount, "discount"), shipping: money(d.shipping, "shipping"), tax: money(d.tax, "tax"),
        total, refunded,
        couponCode: s(d.couponCode ?? d.coupon, 100),
        placedAt: when(d.placedAt ?? d.created_at, "placedAt", true)!,
        cancelledAt: when(d.cancelledAt ?? d.cancelled_at, "cancelledAt"),
        landingUrl, referrer: s(d.referrer, 2000),
        utm: {
          source: s(utmIn.source)?.toLowerCase() ?? fromUrl.source, medium: s(utmIn.medium)?.toLowerCase() ?? fromUrl.medium,
          campaign: s(utmIn.campaign)?.toLowerCase() ?? fromUrl.campaign, content: s(utmIn.content)?.toLowerCase() ?? fromUrl.content ?? undefined,
          term: s(utmIn.term)?.toLowerCase() ?? fromUrl.term ?? undefined,
        },
        cartExternalId: s(d.cartExternalId ?? d.cart_id, 100),
        lines: linesOf(d.lines ?? d.items),
      },
    };
  }
  if (p.type === "cart") {
    return {
      kind: "cart",
      cart: {
        externalId: s(d.externalId ?? d.id, 100) ?? (() => { throw new StoreDataError("cart id missing"); })(),
        customer: customerOf(d.customer),
        value: money(d.value ?? d.total, "value"),
        currency: (s(d.currency, 3) ?? "SAR").toUpperCase(),
        recoveryUrl: (() => {
          const u = s(d.recoveryUrl ?? d.checkout_url, 2000);
          if (!u) return null;
          try { const x = new URL(u); return x.protocol === "https:" ? x.toString() : null; } catch { return null; }
        })(),
        abandonedAt: when(d.abandonedAt ?? d.updated_at ?? d.created_at, "abandonedAt", true)!,
        lines: linesOf(d.lines ?? d.items),
      },
    };
  }
  return { kind: "ignored", reason: `type «${p.type}» is not handled` };
}

/** CSV rows (header names as in docs/marketing/STORE-WEBHOOK.md) → canonical orders. Declared a MANUAL import. */
export function ordersFromCsv(rows: Record<string, string>[]): { orders: CanonicalOrder[]; errors: { row: number; reason: string }[] } {
  const orders: CanonicalOrder[] = [];
  const errors: { row: number; reason: string }[] = [];
  rows.forEach((r, i) => {
    try {
      const n = fromCanonical({
        type: "order",
        data: {
          id: r.order_id, number: r.order_number, status: r.status, total: r.total, refunded: r.refunded, tax: r.tax, shipping: r.shipping,
          discount: r.discount, currency: r.currency, created_at: r.placed_at, coupon: r.coupon, landing_site: r.landing_url,
          utm: { source: r.utm_source, medium: r.utm_medium, campaign: r.utm_campaign },
          customer: r.customer_id ? { id: r.customer_id, name: r.customer_name, phone: r.customer_phone, email: r.customer_email } : null,
        },
      });
      if (n.kind === "order") orders.push(n.order);
    } catch (e) {
      errors.push({ row: i + 2, reason: e instanceof Error ? e.message : "invalid" });
    }
  });
  return { orders, errors };
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). First row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== "")) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}
