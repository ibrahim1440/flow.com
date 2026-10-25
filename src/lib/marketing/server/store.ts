import "server-only";
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { MktError, type Actor, can, denied, dn } from "./http";
import { audit, userActor } from "./audit";
import { sha256 } from "./crypto";
import { enrollCart, setConsent } from "./messaging";
import { fromCanonical, ordersFromCsv, parseCsv, StoreDataError, type CanonicalCart, type CanonicalCustomer, type CanonicalOrder } from "../store-normalize";
import { attributeOrder, aggregateCredit, type AttributionModel } from "../attribution";
import { revenueOf } from "../kpi";
import { loadSettings } from "./settings";

/**
 * The store mirror: the store webhook (or the CSV import) → MktStoreCustomer / MktStoreOrder / MktCart.
 * Read-only copies — the store stays the source of truth; nothing here writes back to it.
 * Every write is idempotent: the same payload twice changes nothing (payloadHash), and orders,
 * carts and customers are unique by (source, externalId).
 */

async function upsertCustomer(tx: Prisma.TransactionClient, c: CanonicalCustomer | null, source: string) {
  if (!c) return null;
  const row = await tx.mktStoreCustomer.upsert({
    where: { source_externalId: { source, externalId: c.externalId } },
    create: { source, externalId: c.externalId, name: c.name, phone: c.phone, email: c.email },
    update: { name: c.name ?? undefined, phone: c.phone ?? undefined, email: c.email ?? undefined },
  });
  // Consent given at checkout is recorded with its source; the store's "no" never overrides an
  // explicit opt-out, and the store's silence (null) records nothing.
  if (c.phone && c.marketingConsent === true) {
    const existing = await tx.mktConsent.findUnique({ where: { phone_channel: { phone: c.phone, channel: "WHATSAPP" } } });
    if (!existing) await setConsent(tx, { phone: c.phone, status: "OPTED_IN", source: "CHECKOUT", evidence: `store:${source}:${c.externalId}`, actorId: null });
  }
  return row;
}

export async function ingestOrder(o: CanonicalOrder, source = "STORE", actor: { kind: "WEBHOOK" | "USER"; id?: string; name?: string } = { kind: "WEBHOOK" }) {
  const hash = sha256(JSON.stringify(o));
  return prisma.$transaction(async (tx) => {
    const existing = await tx.mktStoreOrder.findUnique({ where: { source_externalId: { source, externalId: o.externalId } } });
    if (existing?.payloadHash === hash) return { id: existing.id, changed: false };
    const customer = await upsertCustomer(tx, o.customer, source);
    const campaign = o.utm.campaign ? await tx.mktCampaign.findUnique({ where: { utmCampaign: o.utm.campaign }, select: { id: true } }) : null;
    const data = {
      orderNumber: o.orderNumber, customerId: customer?.id ?? null, rawStatus: o.rawStatus, status: o.status, currency: o.currency,
      subtotal: o.subtotal, discount: o.discount, shipping: o.shipping, tax: o.tax, total: o.total, refunded: o.refunded, couponCode: o.couponCode,
      placedAt: o.placedAt, cancelledAt: o.cancelledAt, utmSource: o.utm.source ?? null, utmMedium: o.utm.medium ?? null, utmCampaign: o.utm.campaign ?? null,
      utmContent: o.utm.content ?? null, utmTerm: o.utm.term ?? null, landingUrl: o.landingUrl, referrer: o.referrer, campaignId: campaign?.id ?? null,
      lines: o.lines as unknown as Prisma.InputJsonValue, payloadHash: hash,
    };
    // A status update that omits the attribution fields never erases them.
    const keep = Object.fromEntries(Object.entries(data).filter(([k, v]) => v !== null || !["customerId", "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm", "landingUrl", "referrer", "campaignId", "orderNumber", "couponCode"].includes(k))) as typeof data;
    const row = await tx.mktStoreOrder.upsert({ where: { source_externalId: { source, externalId: o.externalId } }, create: { source, externalId: o.externalId, ...data }, update: keep });
    if (customer) {
      // First-order flag and the count, from the mirror itself (cancelled orders do not count).
      const live = await tx.mktStoreOrder.findMany({ where: { customerId: customer.id, status: { notIn: ["CANCELLED"] } }, orderBy: { placedAt: "asc" }, select: { id: true, placedAt: true } });
      await tx.mktStoreOrder.updateMany({ where: { customerId: customer.id }, data: { isFirstOrder: false } });
      if (live[0]) await tx.mktStoreOrder.update({ where: { id: live[0].id }, data: { isFirstOrder: true } });
      await tx.mktStoreCustomer.update({ where: { id: customer.id }, data: { ordersCount: live.length, firstOrderAt: live[0]?.placedAt ?? null } });
      // Carts this order recovers: the named cart, else this customer's open carts abandoned before it.
      if (o.status !== "CANCELLED" && o.status !== "PENDING") {
        await tx.mktCart.updateMany({
          where: { status: "OPEN", abandonedAt: { lte: o.placedAt, gte: new Date(o.placedAt.getTime() - 7 * 86_400_000) }, OR: [{ customerId: customer.id }, ...(o.cartExternalId ? [{ externalId: o.cartExternalId, source }] : []), ...(customer.phone ? [{ phone: customer.phone }] : [])] },
          data: { status: "CONVERTED", convertedAt: o.placedAt, convertedOrderExternalId: o.externalId },
        });
      }
    }
    if (o.utm.campaign && !existing) {
      await tx.mktTouch.create({ data: { subjectKey: customer?.phone ?? customer?.id ?? `order:${row.id}`, at: o.placedAt, channel: "UTM", platform: o.utm.source ?? null, campaignId: campaign?.id ?? null, orderId: row.id, detail: { utm: o.utm } } });
    }
    await audit(tx, { kind: actor.kind, id: actor.id, name: actor.name ?? `store:${source}` }, existing ? "store.order_updated" : "store.order_received", "MktStoreOrder", row.id, { after: { externalId: o.externalId, status: o.status, total: o.total, utm: o.utm.campaign ?? null } });
    return { id: row.id, changed: true };
  }, TX_OPTS);
}

export async function ingestCart(c: CanonicalCart, source = "STORE") {
  return prisma.$transaction(async (tx) => {
    const customer = await upsertCustomer(tx, c.customer, source);
    const existing = await tx.mktCart.findUnique({ where: { source_externalId: { source, externalId: c.externalId } } });
    if (existing && existing.status !== "OPEN") return { id: existing.id, changed: false };
    const data = { customerId: customer?.id ?? null, phone: c.customer?.phone ?? null, value: c.value, currency: c.currency, recoveryUrl: c.recoveryUrl, lines: c.lines as unknown as Prisma.InputJsonValue, abandonedAt: c.abandonedAt };
    // A later delivery that omits a field never erases what an earlier one told us (link, phone, value).
    const keep = { customerId: data.customerId ?? undefined, phone: data.phone ?? undefined, value: data.value ?? undefined, recoveryUrl: data.recoveryUrl ?? undefined, lines: c.lines.length ? data.lines : undefined, currency: data.currency, abandonedAt: data.abandonedAt };
    const row = await tx.mktCart.upsert({ where: { source_externalId: { source, externalId: c.externalId } }, create: { source, externalId: c.externalId, ...data }, update: keep });
    // A cart reported after its customer already ordered is not abandoned.
    const ordered = customer ? await tx.mktStoreOrder.count({ where: { customerId: customer.id, placedAt: { gte: c.abandonedAt }, status: { notIn: ["CANCELLED", "PENDING"] } } }) : 0;
    if (ordered > 0) {
      await tx.mktCart.update({ where: { id: row.id }, data: { status: "CONVERTED", convertedAt: new Date() } });
    } else {
      await enrollCart(tx, { id: row.id, phone: row.phone, abandonedAt: row.abandonedAt });
    }
    await audit(tx, { kind: "WEBHOOK", name: `store:${source}` }, existing ? "store.cart_updated" : "store.cart_received", "MktCart", row.id, { after: { externalId: c.externalId, value: c.value } });
    return { id: row.id, changed: true };
  }, TX_OPTS);
}

/** A webhook delivery: recorded once (source + event key), then applied. */
export async function receiveStoreWebhook(raw: string, signatureOk: boolean, eventKeyHeader: string | null) {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new MktError("صيغة غير صالحة.", "Invalid JSON.", 400); }
  const eventKey = (eventKeyHeader?.slice(0, 200) || sha256(raw));
  const ev = await prisma.mktWebhookEvent.upsert({
    where: { source_eventKey: { source: "STORE", eventKey } },
    create: { source: "STORE", eventKey, signatureOk, payload: payload as Prisma.InputJsonValue, topic: (payload as { type?: string })?.type ?? null },
    update: {},
  });
  if (ev.status === "PROCESSED" || ev.status === "IGNORED") return { duplicate: true, status: ev.status };
  if (!signatureOk) {
    await prisma.mktWebhookEvent.update({ where: { id: ev.id }, data: { status: "FAILED", error: "التوقيع غير صالح" } });
    throw new MktError("التوقيع غير صالح.", "Invalid signature.", 401, "MKT_SIGNATURE");
  }
  try {
    const n = fromCanonical(payload);
    if (n.kind === "order") await ingestOrder(n.order);
    else if (n.kind === "cart") await ingestCart(n.cart);
    await prisma.mktWebhookEvent.update({ where: { id: ev.id }, data: { status: n.kind === "ignored" ? "IGNORED" : "PROCESSED", processedAt: new Date(), error: n.kind === "ignored" ? n.reason : null } });
    return { duplicate: false, status: n.kind === "ignored" ? "IGNORED" : "PROCESSED" };
  } catch (e) {
    const reason = e instanceof StoreDataError ? e.message : e instanceof Error ? e.name : "error";
    await prisma.mktWebhookEvent.update({ where: { id: ev.id }, data: { status: "FAILED", error: reason.slice(0, 300) } });
    if (e instanceof StoreDataError) throw new MktError(`بيانات المتجر غير مفهومة: ${reason}`, `Unreadable store data: ${reason}`, 422, "MKT_STORE_DATA");
    throw e;
  }
}

/** Declared manual import of a store orders export. */
export async function importOrdersCsv(text: string, actor: Actor) {
  if (!can(actor, "revenue_view") || !can(actor, "campaigns_manage")) throw denied("الاستيراد يتطلب صلاحيتي الإيرادات وإدارة الحملات.");
  const rows = parseCsv(text);
  if (rows.length === 0) throw new MktError("الملف فارغ.", "Empty file.");
  if (rows.length > 5000) throw new MktError("الحد الأقصى 5000 طلب في الملف الواحد.", "At most 5000 rows.");
  const { orders, errors } = ordersFromCsv(rows);
  let imported = 0;
  for (const o of orders) {
    const r = await ingestOrder(o, "STORE", { kind: "USER", id: actor.id, name: actor.name });
    if (r.changed) imported++;
  }
  await prisma.$transaction(async (tx) => audit(tx, userActor(actor), "store.csv_import", "MktStoreOrder", null, { after: { rows: rows.length, imported, errors: errors.length }, note: "استيراد يدوي" }), TX_OPTS);
  return { rows: rows.length, imported, unchanged: orders.length - imported, errors };
}

// ── Attribution over the mirror ────────────────────────────────────────────────────────────

export async function attributionReport(from: Date, to: Date, model?: AttributionModel, windowDays?: number) {
  const s = await loadSettings();
  const m = (model ?? s.attributionModel) as AttributionModel;
  const w = windowDays ?? s.attributionWindowDays;
  const orders = await prisma.mktStoreOrder.findMany({ where: { placedAt: { gte: from, lt: to } }, include: { customer: { select: { id: true, phone: true } } }, take: 20000 });
  const keys = [...new Set(orders.flatMap((o) => [o.customer?.phone, o.customer?.id].filter((k): k is string => !!k)))];
  const touches = await prisma.mktTouch.findMany({
    where: { subjectKey: { in: keys }, at: { gte: new Date(from.getTime() - w * 86_400_000), lt: to }, campaignId: { not: null }, channel: { not: "UTM" } },
    select: { subjectKey: true, at: true, campaignId: true, channel: true, detail: true },
  });
  const by = new Map<string, typeof touches>();
  // Only touches the customer acted on count for WhatsApp: a click (not a mere send).
  for (const t of touches) {
    if (t.channel === "WHATSAPP" && (t.detail as { kind?: string })?.kind !== "click") continue;
    (by.get(t.subjectKey) ?? by.set(t.subjectKey, []).get(t.subjectKey)!).push(t);
  }
  const live = orders.filter((o) => o.status !== "CANCELLED" && o.status !== "PENDING");
  const results = live.map((o) => attributeOrder({
    id: o.id, placedAt: o.placedAt, utmCampaignId: o.campaignId,
    touches: [...(o.customer?.phone ? by.get(o.customer.phone) ?? [] : []), ...(o.customer?.id ? by.get(o.customer.id) ?? [] : [])].map((t) => ({ at: t.at, campaignId: t.campaignId, channel: t.channel })),
  }, m, w));
  const netOf = (o: (typeof orders)[number]) => dn(o.tax) === null || dn(o.shipping) === null ? null : dn(o.total)! - dn(o.refunded)! - dn(o.tax)! - dn(o.shipping)!;
  const netKnown = live.every((o) => netOf(o) !== null);
  // Credit is in NET revenue when every order has tax and shipping; otherwise gross minus refunds, and the report says so.
  const values = new Map(live.map((o) => [o.id, { revenue: netKnown ? netOf(o)! : dn(o.total)! - dn(o.refunded)!, isNew: o.isFirstOrder === true }]));
  const agg = aggregateCredit(results, values);
  const campaigns = await prisma.mktCampaign.findMany({ where: { id: { in: agg.byCampaign.map((c) => c.campaignId) } }, select: { id: true, name: true, utmCampaign: true } });
  const names = new Map(campaigns.map((c) => [c.id, c]));
  const totals = revenueOf(orders.map((o) => ({ status: o.status, total: dn(o.total)!, refunded: dn(o.refunded)!, tax: dn(o.tax), shipping: dn(o.shipping), customerKey: o.customerId, isFirstOrder: o.isFirstOrder })));
  const unknownUtm = [...new Set(orders.filter((o) => o.utmCampaign && !o.campaignId).map((o) => o.utmCampaign!))];
  return {
    model: m, windowDays: w, revenueBasis: netKnown ? "NET" : "GROSS_MINUS_REFUNDS",
    totals, byCampaign: agg.byCampaign.map((c) => ({ ...c, campaign: names.get(c.campaignId) ?? null })), unattributed: agg.unattributed, unknownUtmCampaigns: unknownUtm,
  };
}

export async function listStoreOrders(q: { from: Date; to: Date; search?: string | null; unattributedOnly?: boolean }) {
  const rows = await prisma.mktStoreOrder.findMany({
    where: { placedAt: { gte: q.from, lt: q.to }, ...(q.unattributedOnly ? { campaignId: null } : {}), ...(q.search ? { OR: [{ orderNumber: { contains: q.search } }, { externalId: { contains: q.search } }, { utmCampaign: { contains: q.search.toLowerCase() } }] } : {}) },
    include: { campaign: { select: { id: true, name: true } }, customer: { select: { name: true } } },
    orderBy: { placedAt: "desc" },
    take: 300,
  });
  return rows.map((o) => ({
    id: o.id, externalId: o.externalId, orderNumber: o.orderNumber, status: o.status, total: dn(o.total), refunded: dn(o.refunded), currency: o.currency, placedAt: o.placedAt,
    isFirstOrder: o.isFirstOrder, utmSource: o.utmSource, utmMedium: o.utmMedium, utmCampaign: o.utmCampaign, couponCode: o.couponCode, campaign: o.campaign, customerName: o.customer?.name ?? null,
  }));
}
