import "server-only";
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { MktError, notFound, str, oneOf, date, num, strList, type Actor, can, denied, dn } from "./http";
import { audit, userActor } from "./audit";
import { openApproval, snapshotHash } from "./approvals-core";
import { approvalRequired, killed, loadSettings } from "./settings";
import { fetchTemplates, sendMode, sendTemplate } from "./whatsapp-cloud";
import { parseWebhook, isOptOutText } from "../wa-webhook";
import { karzounOptOut } from "../karzoun-rules";
import { sha256 } from "./crypto";
import { publicBaseUrl } from "./connections";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import {
  DEFAULT_CART_CONFIG, STOP_REASON_AR, campaignMessageAllowed, inQuietHours, localDayStart, nextCartAction, quietEndsAt, renderTemplate, validateCartConfig,
  type CartJourneyConfig, type Consent,
} from "../messaging-rules";

export const JOURNEY_KINDS = ["ABANDONED_CART", "WELCOME", "POST_PURCHASE", "REVIEW_REQUEST", "REPLENISH", "WINBACK", "CROSS_SELL"] as const;
export const JOURNEY_LABELS: Record<string, { ar: string; implemented: boolean; noteAr: string }> = {
  ABANDONED_CART: { ar: "استعادة السلة المتروكة", implemented: true, noteAr: "يعمل عند وصول بيانات السلال من المتجر." },
  WELCOME: { ar: "الترحيب بالعملاء الجدد", implemented: false, noteAr: "المرحلة الخامسة — بعد اعتماد قالب ترحيب." },
  POST_PURCHASE: { ar: "متابعة ما بعد الشراء", implemented: false, noteAr: "المرحلة الخامسة." },
  REVIEW_REQUEST: { ar: "طلب التقييم بعد الاستلام", implemented: false, noteAr: "يحتاج حالة التسليم من المتجر." },
  REPLENISH: { ar: "تذكير إعادة الشراء", implemented: false, noteAr: "يعتمد على دورة إعادة الشراء المدخلة لكل منتج." },
  WINBACK: { ar: "استعادة العملاء غير النشطين", implemented: false, noteAr: "المرحلة الخامسة." },
  CROSS_SELL: { ar: "منتجات مرتبطة", implemented: false, noteAr: "المرحلة الخامسة." },
};

// ── Consent ledger ─────────────────────────────────────────────────────────────────────────

export const CONSENT_SOURCES = ["CHECKOUT", "FORM", "IN_STORE", "REPLY_STOP", "ADMIN", "IMPORT"] as const;

export function phoneOrThrow(raw: unknown): string {
  const p = normalizePhoneForWhatsApp(typeof raw === "string" ? raw : null);
  if (!p.ok) throw new MktError("رقم الجوال غير صالح.", "Invalid phone number.", 400, "MKT_PHONE");
  return p.phone;
}

export async function setConsent(tx: Prisma.TransactionClient, args: { phone: string; status: "OPTED_IN" | "OPTED_OUT"; source: string; evidence: string | null; actorId: string | null }) {
  await tx.mktConsent.upsert({
    where: { phone_channel: { phone: args.phone, channel: "WHATSAPP" } },
    create: { phone: args.phone, channel: "WHATSAPP", status: args.status, source: args.source, evidence: args.evidence },
    update: { status: args.status, source: args.source, evidence: args.evidence },
  });
  await tx.mktConsentEvent.create({ data: { phone: args.phone, channel: "WHATSAPP", status: args.status, source: args.source, evidence: args.evidence, actorId: args.actorId } });
  if (args.status === "OPTED_OUT") {
    // A withdrawal stops everything queued for that phone, at once.
    await tx.mktMessage.updateMany({ where: { phone: args.phone, status: "QUEUED", category: "MARKETING" }, data: { status: "SKIPPED", statusNote: STOP_REASON_AR.OPTED_OUT } });
    await tx.mktJourneyEnrollment.updateMany({ where: { phone: args.phone, status: "ACTIVE" }, data: { status: "STOPPED", stopReason: "OPTED_OUT", nextRunAt: null } });
  }
}

export async function recordConsent(body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "customers_data") && !can(actor, "messaging_manage")) throw denied();
  const phone = phoneOrThrow(body.phone);
  const status = oneOf(body.status, ["OPTED_IN", "OPTED_OUT"] as const, "الحالة");
  const source = oneOf(body.source, CONSENT_SOURCES, "مصدر الموافقة", "ADMIN");
  const evidence = str(body.evidence, "الدليل", { max: 500 });
  if (status === "OPTED_IN" && !evidence) throw new MktError("سجّل دليل الموافقة (أين ومتى وافق العميل).", "Evidence is required for an opt-in.", 400, "MKT_REQUIRED");
  await prisma.$transaction(async (tx) => {
    await setConsent(tx, { phone, status, source, evidence, actorId: actor.id });
    await audit(tx, userActor(actor), "consent.recorded", "MktConsent", phone, { after: { status, source, evidence } });
  }, TX_OPTS);
  return { phone, status };
}

export async function listConsent(q: { search?: string | null; status?: string | null }) {
  const rows = await prisma.mktConsent.findMany({
    where: { ...(q.status ? { status: q.status } : {}), ...(q.search ? { phone: { contains: q.search.replace(/\D/g, "") } } : {}) },
    orderBy: { updatedAt: "desc" }, take: 300,
  });
  const counts = await prisma.mktConsent.groupBy({ by: ["status"], _count: { _all: true } });
  return { rows, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) };
}

async function consentOf(phone: string): Promise<{ consent: Consent; erpOptOut: boolean }> {
  const c = await prisma.mktConsent.findUnique({ where: { phone_channel: { phone, channel: "WHATSAPP" } } });
  // The ERP's own flag: any ERP customer whose number normalises to this phone and said no.
  const tail = phone.slice(-9);
  const erp = await prisma.customer.findMany({ where: { whatsappOptOut: true, phone: { contains: tail } }, select: { phone: true }, take: 20 });
  const erpOptOut = erp.some((e) => { const p = normalizePhoneForWhatsApp(e.phone); return p.ok && p.phone === phone; });
  return { consent: (c?.status as Consent) ?? null, erpOptOut };
}

// ── Templates ──────────────────────────────────────────────────────────────────────────────

export async function listTemplates() {
  return prisma.mktWaTemplate.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }] });
}

export async function saveTemplate(body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "messaging_manage")) throw denied();
  const name = str(body.name, "اسم القالب", { max: 512, required: true })!.toLowerCase();
  if (!/^[a-z0-9_]+$/.test(name)) throw new MktError("اسم القالب: حروف إنجليزية صغيرة وأرقام وشرطة سفلية فقط (كما في Meta).", "Template names are lowercase a-z, 0-9 and _.");
  const data = {
    name, language: str(body.language, "اللغة", { max: 10 }) ?? "ar",
    category: oneOf(body.category, ["MARKETING", "UTILITY", "AUTHENTICATION"] as const, "الفئة"),
    body: str(body.body, "نص القالب", { max: 1024, required: true })!,
    variables: strList(body.variables, "المتغيرات", 10),
    purpose: str(body.purpose, "الغرض", { max: 60 }),
  };
  const placeholders = new Set([...data.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
  if (placeholders.size !== data.variables.length) throw new MktError(`عدد المتغيرات (${data.variables.length}) لا يطابق المواضع في النص (${placeholders.size}).`, "Variables do not match placeholders.");
  return prisma.$transaction(async (tx) => {
    const existing = await tx.mktWaTemplate.findUnique({ where: { name_language: { name, language: data.language } } });
    if (existing && existing.status !== "LOCAL_DRAFT" && existing.body !== data.body) {
      throw new MktError("هذا القالب معتمد من Meta؛ تعديل نصه يتم في WhatsApp Manager ثم المزامنة.", "Approved templates are edited in WhatsApp Manager.", 409);
    }
    const row = await tx.mktWaTemplate.upsert({ where: { name_language: { name, language: data.language } }, create: { ...data, status: "LOCAL_DRAFT" }, update: { variables: data.variables, purpose: data.purpose, ...(existing?.status === "LOCAL_DRAFT" ? { body: data.body, category: data.category } : {}) } });
    await audit(tx, userActor(actor), "template.saved", "MktWaTemplate", row.id, { after: data });
    return row;
  }, TX_OPTS);
}

/** Pull templates and their approval status from Meta (the authority on what may be sent). */
export async function syncTemplates(actor: Actor | null, fetchImpl: typeof fetch = fetch) {
  const r = await fetchTemplates(fetchImpl);
  if (!r.ok) throw new MktError(`تعذرت مزامنة القوالب: ${r.detail}`, "Template sync failed.", 502, "MKT_SYNC");
  let n = 0;
  await prisma.$transaction(async (tx) => {
    for (const t of r.templates) {
      const body = t.components?.find((c) => String(c.type).toUpperCase() === "BODY")?.text ?? "";
      const st = String(t.status ?? "").toUpperCase(), cat = String(t.category ?? "").toUpperCase();
      const status = ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"].includes(st) ? st : "PENDING";
      const category = ["MARKETING", "UTILITY", "AUTHENTICATION"].includes(cat) ? cat : "MARKETING";
      // Positional ({{1}}) → var1… for the owner to rename (name, value, link); a NAMED template keeps its names.
      const keys = [...new Set([...body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
      const named = keys.some((k) => !/^\d+$/.test(k));
      await tx.mktWaTemplate.upsert({
        where: { name_language: { name: t.name, language: t.language } },
        create: { name: t.name, language: t.language, status, category, body, variables: named ? keys : Array.from({ length: keys.length }, (_, i) => `var${i + 1}`) },
        update: { status, category, body },
      });
      n++;
    }
    await audit(tx, actor ? userActor(actor) : { kind: "SYSTEM" }, "template.synced", "MktWaTemplate", null, { after: { count: n } });
  }, TX_OPTS);
  return { synced: n };
}

// ── Journeys ───────────────────────────────────────────────────────────────────────────────

export async function listJourneys() {
  // ON CONFLICT DO NOTHING: two screens opening at once never collide on the first creation.
  await prisma.mktJourney.createMany({ data: JOURNEY_KINDS.map((kind) => ({ kind, name: JOURNEY_LABELS[kind].ar, config: kind === "ABANDONED_CART" ? (DEFAULT_CART_CONFIG as unknown as Prisma.InputJsonValue) : {} })), skipDuplicates: true });
  const rows = await prisma.mktJourney.findMany({ orderBy: { kind: "asc" } });
  const stats = await prisma.mktJourneyEnrollment.groupBy({ by: ["journeyId", "status"], _count: { _all: true } });
  const pending = await prisma.mktApproval.findMany({ where: { subjectType: "JOURNEY", status: "PENDING" }, select: { subjectId: true, id: true } });
  return rows.map((j) => ({
    ...j, label: JOURNEY_LABELS[j.kind],
    enrollments: Object.fromEntries(stats.filter((s) => s.journeyId === j.id).map((s) => [s.status, s._count._all])),
    pendingApprovalId: pending.find((p) => p.subjectId === j.id)?.id ?? null,
  }));
}

function readCartConfig(v: unknown): CartJourneyConfig {
  const o = (v ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(o.steps) ? (o.steps as Record<string, unknown>[]).map((s) => ({ waitMinutes: num(s.waitMinutes, "مدة الانتظار", { min: 0, int: true }) ?? 0, templateId: str(s.templateId, "القالب"), label: str(s.label, "الوصف", { max: 60 }) ?? undefined })) : [];
  return { steps, minCartValue: num(o.minCartValue, "الحد الأدنى للسلة", { min: 0 }), expireAfterHours: num(o.expireAfterHours, "صلاحية السلة", { min: 1, max: 168, int: true }) ?? 72 };
}

/** Save a journey's settings. Turning it on (or changing an active one) goes through approval per policy. */
export async function saveJourney(kind: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "messaging_manage")) throw denied();
  const k = oneOf(kind, JOURNEY_KINDS, "الرحلة");
  if (!JOURNEY_LABELS[k].implemented && body.active === true) throw new MktError("هذه الرحلة غير مطبّقة بعد في هذا الإصدار.", "Not implemented yet.", 409, "MKT_NOT_IMPLEMENTED");
  const config = k === "ABANDONED_CART" ? readCartConfig(body.config) : ((body.config ?? {}) as CartJourneyConfig);
  const wantActive = body.active === true;
  if (k === "ABANDONED_CART" && wantActive) {
    const errs = validateCartConfig(config);
    if (errs.length) throw new MktError(errs.join(" "), "Invalid journey configuration.", 400, "MKT_JOURNEY_INVALID");
    const ids = config.steps.map((s) => s.templateId!).filter(Boolean);
    const tpl = await prisma.mktWaTemplate.findMany({ where: { id: { in: ids } } });
    if (tpl.some((t) => t.status !== "APPROVED")) throw new MktError("كل قوالب الرحلة يجب أن تكون معتمدة من Meta.", "All templates must be approved by Meta.", 409);
    if (tpl.length !== new Set(ids).size) throw new MktError("قالب غير موجود.", "Unknown template.");
  }
  const settings = await loadSettings();
  return prisma.$transaction(async (tx) => {
    await tx.mktJourney.createMany({ data: [{ kind: k, name: JOURNEY_LABELS[k].ar }], skipDuplicates: true });
    const j = await tx.mktJourney.findUniqueOrThrow({ where: { kind: k } });
    if (!wantActive) {
      const row = await tx.mktJourney.update({ where: { id: j.id }, data: { active: false, config: config as unknown as Prisma.InputJsonValue, updatedById: actor.id } });
      await tx.mktApproval.updateMany({ where: { subjectType: "JOURNEY", subjectId: j.id, status: "PENDING" }, data: { status: "CANCELLED", decisionNote: "أُوقفت الرحلة" } });
      await audit(tx, userActor(actor), "journey.saved", "MktJourney", j.id, { before: { active: j.active, config: j.config }, after: { active: false, config } });
      return { journey: row, approvalId: null };
    }
    if (approvalRequired(settings, "journeyActivate")) {
      const a = await openApproval(tx, { subjectType: "JOURNEY", subjectId: j.id, action: "activate", payload: { config }, actor });
      return { journey: j, approvalId: a.id };
    }
    const row = await tx.mktJourney.update({ where: { id: j.id }, data: { active: true, config: config as unknown as Prisma.InputJsonValue, updatedById: actor.id } });
    await audit(tx, userActor(actor), "journey.activated", "MktJourney", j.id, { after: { config } });
    return { journey: row, approvalId: null };
  }, TX_OPTS);
}

export async function applyJourneyApproval(tx: Prisma.TransactionClient, a: { subjectId: string; payload: unknown; payloadHash: string }, approver: { id: string; name: string }) {
  if (snapshotHash(a.payload) !== a.payloadHash) throw new MktError("بيانات الطلب تالفة.", "Corrupt approval payload.", 409, "MKT_STALE_APPROVAL");
  const config = (a.payload as { config: unknown }).config;
  await tx.mktJourney.update({ where: { id: a.subjectId }, data: { active: true, config: config as Prisma.InputJsonValue, updatedById: approver.id } });
  await audit(tx, { kind: "USER", id: approver.id, name: approver.name }, "journey.activated", "MktJourney", a.subjectId, { after: { config }, note: "by approval" });
}

/** Called by the store ingestion for every new OPEN cart. Unique per journey and cart. */
export async function enrollCart(tx: Prisma.TransactionClient, cart: { id: string; phone: string | null; abandonedAt: Date }) {
  const j = await tx.mktJourney.findUnique({ where: { kind: "ABANDONED_CART" } });
  if (!j?.active) return null;
  const cfg = j.config as unknown as CartJourneyConfig;
  const first = cfg.steps?.[0];
  if (!first) return null;
  return tx.mktJourneyEnrollment.upsert({
    where: { journeyId_subjectKey: { journeyId: j.id, subjectKey: `cart:${cart.id}` } },
    create: { journeyId: j.id, subjectKey: `cart:${cart.id}`, phone: cart.phone, nextRunAt: new Date(cart.abandonedAt.getTime() + first.waitMinutes * 60_000), context: { cartId: cart.id } },
    update: {},
  });
}

async function guardsNow(now: Date, phone: string | null) {
  const s = await loadSettings();
  const dayStart = localDayStart(now, s.timezone);
  const [sentToday, week] = await Promise.all([
    prisma.mktMessage.count({ where: { sentAt: { gte: dayStart }, status: { in: ["SENT", "DELIVERED", "READ"] } } }),
    phone ? prisma.mktMessage.count({ where: { phone, category: "MARKETING", status: { in: ["SENT", "DELIVERED", "READ", "SENDING"] }, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }) : Promise.resolve(0),
  ]);
  return {
    settings: s,
    guards: { killed: killed(s, "messaging"), timezone: s.timezone, quietStart: s.quietHoursStart, quietEnd: s.quietHoursEnd, sentToday, maxPerDay: s.maxMessagesPerDay, marketingThisWeekForPhone: week, maxPerCustomerPerWeek: s.maxMarketingPerCustomerPerWeek },
  };
}

export type JourneyReport = { evaluated: number; queued: number; stopped: number; waiting: number };

/** Evaluate due enrollments: stop, wait, or queue the next message (the sender sends it). */
export async function runJourneys(now = new Date()): Promise<JourneyReport> {
  const rep: JourneyReport = { evaluated: 0, queued: 0, stopped: 0, waiting: 0 };
  const due = await prisma.mktJourneyEnrollment.findMany({ where: { status: "ACTIVE", nextRunAt: { lte: now } }, include: { journey: true }, take: 100, orderBy: { nextRunAt: "asc" } });
  const templates = new Map((await prisma.mktWaTemplate.findMany()).map((t) => [t.id, t]));
  for (const e of due) {
    rep.evaluated++;
    if (e.journey.kind !== "ABANDONED_CART" || !e.journey.active) {
      await prisma.mktJourneyEnrollment.update({ where: { id: e.id }, data: { status: "STOPPED", stopReason: "JOURNEY_OFF", nextRunAt: null } });
      rep.stopped++;
      continue;
    }
    const cfg = e.journey.config as unknown as CartJourneyConfig;
    const cartId = (e.context as { cartId?: string }).cartId!;
    const cart = await prisma.mktCart.findUnique({ where: { id: cartId }, include: { customer: true } });
    if (!cart) { await prisma.mktJourneyEnrollment.update({ where: { id: e.id }, data: { status: "STOPPED", stopReason: "CART_GONE", nextRunAt: null } }); rep.stopped++; continue; }
    const phone = cart.phone;
    const orderedSince = await prisma.mktStoreOrder.count({
      where: { placedAt: { gte: cart.abandonedAt }, status: { notIn: ["CANCELLED"] }, OR: [...(cart.customerId ? [{ customerId: cart.customerId }] : []), ...(phone ? [{ customer: { phone } }] : [])] },
    }).then((n) => n > 0);
    const c = phone ? await consentOf(phone) : { consent: null, erpOptOut: false };
    const lastSent = await prisma.mktMessage.findFirst({ where: { enrollmentId: e.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const { guards } = await guardsNow(now, phone);
    const action = nextCartAction({
      cartStatus: cart.status as "OPEN" | "CONVERTED" | "EXPIRED", abandonedAt: cart.abandonedAt, value: dn(cart.value), phone, orderedSince,
      consent: c.consent, erpOptOut: c.erpOptOut, stepIndex: e.stepIndex, lastSentAt: lastSent?.createdAt ?? null,
      templateApproved: (id) => !!id && templates.get(id)?.status === "APPROVED",
    }, cfg, guards, now);

    if (action.kind === "STOP") {
      await prisma.$transaction(async (tx) => {
        await tx.mktJourneyEnrollment.update({ where: { id: e.id }, data: { status: action.reason === "SEQUENCE_DONE" ? "COMPLETED" : "STOPPED", stopReason: action.reason, nextRunAt: null } });
        if (action.reason === "CART_EXPIRED" && cart.status === "OPEN") await tx.mktCart.update({ where: { id: cart.id }, data: { status: "EXPIRED" } });
        await audit(tx, { kind: "RULE", name: "abandoned-cart" }, "journey.stopped", "MktJourneyEnrollment", e.id, { note: STOP_REASON_AR[action.reason] });
      }, TX_OPTS);
      rep.stopped++;
    } else if (action.kind === "WAIT") {
      await prisma.mktJourneyEnrollment.update({ where: { id: e.id }, data: { nextRunAt: action.until } });
      rep.waiting++;
    } else {
      const tpl = templates.get(action.templateId)!;
      const values = templateValues(tpl.variables, { name: cart.customer?.name ?? "", value: cart.value ? `${dn(cart.value)} ${cart.currency === "SAR" ? "ر.س" : cart.currency}` : "", link: cart.recoveryUrl ?? "" });
      await prisma.$transaction(async (tx) => {
        const msg = await tx.mktMessage.upsert({
          where: { dedupeKey: `journey:${e.id}:step:${action.step}` },
          create: {
            phone: phone!, enrollmentId: e.id, templateId: tpl.id, category: tpl.category === "UTILITY" ? "UTILITY" : "MARKETING",
            preview: "", variables: values, dedupeKey: `journey:${e.id}:step:${action.step}`, scheduledAt: now, status: "QUEUED",
          },
          update: {},
        });
        const withLink = values.map((v) => (v === "{tracked_link}" ? trackedLink(msg.id) || cart.recoveryUrl || "" : v));
        const rendered = renderTemplate(tpl.body, withLink);
        await tx.mktMessage.update({
          where: { id: msg.id },
          data: rendered.ok ? { preview: rendered.text, variables: withLink, trackedUrl: cart.recoveryUrl } : { status: "SKIPPED", statusNote: `متغيرات ناقصة: ${rendered.missing.join("، ")}` },
        });
        const nextStep = cfg.steps[action.step + 1];
        await tx.mktJourneyEnrollment.update({ where: { id: e.id }, data: { stepIndex: action.step + 1, nextRunAt: nextStep ? new Date(now.getTime() + nextStep.waitMinutes * 60_000) : now } });
      }, TX_OPTS);
      rep.queued++;
    }
  }
  return rep;
}

/** Map a template's variable names to values. `link` becomes the tracked redirect (filled per message). */
export function templateValues(names: string[], facts: Record<string, string>): string[] {
  return names.map((n) => {
    const k = n.toLowerCase();
    if (k.includes("link") || k.includes("url")) return facts.link ? "{tracked_link}" : "";
    if (k.includes("name")) return facts.name || "عميلنا العزيز";
    if (k.includes("value") || k.includes("total")) return facts.value ?? "";
    return facts[k] ?? "";
  });
}

export function trackedLink(messageId: string): string {
  const base = publicBaseUrl();
  return base ? `${base}/api/marketing/r/${messageId}` : "";
}

// ── One-off message campaigns ──────────────────────────────────────────────────────────────

/** One batch is queued inside one transaction; larger audiences are split (Phase 5: background batching). */
export const MAX_CAMPAIGN_RECIPIENTS = 2000;

export const SEGMENTS = ["OPTED_IN_ALL", "BOUGHT_PRODUCT", "INACTIVE_DAYS", "PHONES"] as const;

export type MessageCampaignSpec = { templateId: string; segment: { type: (typeof SEGMENTS)[number]; sku?: string | null; days?: number | null; phones?: string[] }; scheduledAt: string | null; link: string | null };

export async function audiencePreview(spec: MessageCampaignSpec) {
  const phones = await resolveSegment(spec.segment);
  const tpl = await prisma.mktWaTemplate.findUnique({ where: { id: spec.templateId } });
  const consents = new Map((await prisma.mktConsent.findMany({ where: { phone: { in: phones } }, select: { phone: true, status: true } })).map((c) => [c.phone, c.status as Consent]));
  let eligible = 0;
  const skipped: Record<string, number> = {};
  for (const p of phones) {
    // The ERP customer's own opt-out is checked again per message at send time.
    const ok = campaignMessageAllowed({ consent: consents.get(p) ?? null, erpOptOut: false, phone: p, category: tpl?.category === "UTILITY" ? "UTILITY" : "MARKETING", templateApproved: tpl?.status === "APPROVED" });
    if (ok.ok) eligible++;
    else skipped[ok.reasonAr] = (skipped[ok.reasonAr] ?? 0) + 1;
  }
  return { audience: phones.length, eligible, skipped };
}

async function resolveSegment(seg: MessageCampaignSpec["segment"]): Promise<string[]> {
  if (seg.type === "PHONES") return [...new Set((seg.phones ?? []).map((p) => phoneOrThrow(p)))].slice(0, 5000);
  if (seg.type === "OPTED_IN_ALL") return (await prisma.mktConsent.findMany({ where: { status: "OPTED_IN" }, select: { phone: true }, take: 20000 })).map((r) => r.phone);
  if (seg.type === "BOUGHT_PRODUCT") {
    if (!seg.sku) throw new MktError("حدد رمز المنتج (SKU).", "SKU required.");
    const orders = await prisma.mktStoreOrder.findMany({ where: { status: { notIn: ["CANCELLED"] }, lines: { array_contains: [{ sku: seg.sku }] } }, select: { customer: { select: { phone: true } } }, take: 20000 });
    return [...new Set(orders.map((o) => o.customer?.phone).filter((p): p is string => !!p))];
  }
  const days = seg.days ?? 0;
  if (days < 14 || days > 730) throw new MktError("مدة عدم النشاط بين 14 و730 يوماً.", "Inactivity days must be 14–730.");
  const since = new Date(Date.now() - days * 86_400_000);
  const customers = await prisma.mktStoreCustomer.findMany({ where: { phone: { not: null }, ordersCount: { gt: 0 }, orders: { none: { placedAt: { gte: since } } } }, select: { phone: true }, take: 20000 });
  return customers.map((c) => c.phone!);
}

function readSpec(body: Record<string, unknown>): MessageCampaignSpec {
  const seg = (body.segment ?? {}) as Record<string, unknown>;
  return {
    templateId: str(body.templateId, "القالب", { required: true })!,
    segment: { type: oneOf(seg.type, SEGMENTS, "الشريحة"), sku: str(seg.sku, "SKU", { max: 100 }), days: num(seg.days, "الأيام", { int: true }), phones: Array.isArray(seg.phones) ? (seg.phones as string[]).slice(0, 5000) : undefined },
    scheduledAt: date(body.scheduledAt, "موعد الإرسال")?.toISOString() ?? null,
    link: str(body.link, "الرابط", { max: 2000 }),
  };
}

export async function requestMessageCampaign(campaignId: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "messaging_manage")) throw denied();
  const spec = readSpec(body);
  const campaign = await prisma.mktCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw notFound();
  const tpl = await prisma.mktWaTemplate.findUnique({ where: { id: spec.templateId } });
  if (!tpl || tpl.status !== "APPROVED") throw new MktError("القالب غير معتمد من Meta.", "Template is not approved.", 409);
  const preview = await audiencePreview(spec);
  if (preview.eligible > MAX_CAMPAIGN_RECIPIENTS) throw new MktError(`الشريحة أكبر من ${MAX_CAMPAIGN_RECIPIENTS} مستلم في دفعة واحدة؛ قسّمها.`, "Audience too large for one batch.", 409, "MKT_AUDIENCE_TOO_LARGE");
  if (preview.eligible === 0) throw new MktError("لا يوجد مستلم مؤهل في هذه الشريحة (موافقة تسويقية مطلوبة).", "No eligible recipient.", 409, "MKT_NO_AUDIENCE");
  const settings = await loadSettings();
  return prisma.$transaction(async (tx) => {
    if (approvalRequired(settings, "messageCampaign")) {
      const a = await openApproval(tx, { subjectType: "MESSAGE_CAMPAIGN", subjectId: campaignId, action: "send", payload: { ...spec, eligible: preview.eligible }, actor });
      return { approvalId: a.id, queued: 0, preview };
    }
    const queued = await enqueueCampaign(tx, campaignId, spec, `direct:${Date.now()}`);
    await audit(tx, userActor(actor), "message_campaign.queued", "MktCampaign", campaignId, { after: { ...spec, queued } });
    return { approvalId: null, queued, preview };
  }, TX_OPTS);
}

export async function applyMessageCampaignApproval(tx: Prisma.TransactionClient, a: { id: string; subjectId: string; payload: unknown; payloadHash: string }, approver: { id: string; name: string }) {
  if (snapshotHash(a.payload) !== a.payloadHash) throw new MktError("بيانات الطلب تالفة.", "Corrupt approval payload.", 409, "MKT_STALE_APPROVAL");
  const queued = await enqueueCampaign(tx, a.subjectId, a.payload as MessageCampaignSpec, a.id);
  await audit(tx, { kind: "USER", id: approver.id, name: approver.name }, "message_campaign.queued", "MktCampaign", a.subjectId, { after: { queued }, note: "by approval" });
}

async function enqueueCampaign(tx: Prisma.TransactionClient, campaignId: string, spec: MessageCampaignSpec, batchKey: string): Promise<number> {
  const tpl = await tx.mktWaTemplate.findUniqueOrThrow({ where: { id: spec.templateId } });
  const campaign = await tx.mktCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  // Only phones that may receive this category are queued; everything is checked again at send time.
  let phones = await resolveSegment(spec.segment);
  if (tpl.category !== "UTILITY") {
    const ok = new Set((await tx.mktConsent.findMany({ where: { phone: { in: phones }, status: "OPTED_IN" }, select: { phone: true } })).map((c) => c.phone));
    phones = phones.filter((p) => ok.has(p));
  }
  if (phones.length > MAX_CAMPAIGN_RECIPIENTS) throw new MktError(`الشريحة أكبر من ${MAX_CAMPAIGN_RECIPIENTS} مستلم في دفعة واحدة؛ قسّمها.`, "Audience too large for one batch.", 409, "MKT_AUDIENCE_TOO_LARGE");
  const names = new Map((await tx.mktStoreCustomer.findMany({ where: { phone: { in: phones } }, select: { phone: true, name: true } })).map((c) => [c.phone!, c.name ?? ""]));
  const at = spec.scheduledAt ? new Date(spec.scheduledAt) : new Date();
  let n = 0;
  for (const phone of phones) {
    const dedupeKey = `campaign:${campaignId}:${batchKey}:${phone}`;
    const values = templateValues(tpl.variables, { name: names.get(phone) ?? "", link: spec.link ?? campaign.landingUrl ?? "" });
    const msg = await tx.mktMessage.upsert({
      where: { dedupeKey },
      create: { phone, campaignId, templateId: tpl.id, category: tpl.category === "UTILITY" ? "UTILITY" : "MARKETING", preview: "", variables: values, dedupeKey, scheduledAt: at, trackedUrl: spec.link ?? campaign.landingUrl },
      update: {},
    });
    const withLink = values.map((v) => (v === "{tracked_link}" ? trackedLink(msg.id) || spec.link || campaign.landingUrl || "" : v));
    const r = renderTemplate(tpl.body, withLink);
    await tx.mktMessage.update({ where: { id: msg.id }, data: r.ok ? { preview: r.text, variables: withLink } : { status: "SKIPPED", statusNote: `متغيرات ناقصة: ${r.missing.join("، ")}` } });
    n++;
  }
  return n;
}

// ── The sender ─────────────────────────────────────────────────────────────────────────────

export type SendReport = { considered: number; sent: number; skipped: number; failed: number; deferred: number; mode: string };

/** Sends due QUEUED messages. Consent, kill switch, quiet hours and caps are checked again at send time. */
export async function runSender(now = new Date(), fetchImpl: typeof fetch = fetch): Promise<SendReport> {
  const mode = sendMode();
  const rep: SendReport = { considered: 0, sent: 0, skipped: 0, failed: 0, deferred: 0, mode: mode.mode };
  const due = await prisma.mktMessage.findMany({ where: { status: "QUEUED", scheduledAt: { lte: now } }, orderBy: { scheduledAt: "asc" }, take: 50 });
  const templates = new Map((await prisma.mktWaTemplate.findMany()).map((t) => [t.id, t]));
  for (const m of due) {
    rep.considered++;
    const { settings, guards } = await guardsNow(now, m.phone);
    if (guards.killed) { rep.deferred++; break; }
    const tpl = m.templateId ? templates.get(m.templateId) : null;
    const c = await consentOf(m.phone);
    const allowed = campaignMessageAllowed({ consent: c.consent, erpOptOut: c.erpOptOut, phone: m.phone, category: m.category === "UTILITY" ? "UTILITY" : "MARKETING", templateApproved: tpl?.status === "APPROVED" });
    if (!allowed.ok) {
      await prisma.mktMessage.update({ where: { id: m.id }, data: { status: "SKIPPED", statusNote: allowed.reasonAr } });
      rep.skipped++;
      continue;
    }
    if (m.category === "MARKETING" && inQuietHours(now, guards)) {
      await prisma.mktMessage.update({ where: { id: m.id }, data: { scheduledAt: quietEndsAt(now, guards) } });
      rep.deferred++;
      continue;
    }
    if (guards.sentToday >= settings.maxMessagesPerDay) { rep.deferred++; break; }
    if (m.scheduledAt.getTime() < now.getTime() - 24 * 3600_000) {
      await prisma.mktMessage.update({ where: { id: m.id }, data: { status: "CANCELLED", statusNote: "انقضى أكثر من 24 ساعة على موعدها؛ لم تُرسل متأخرة." } });
      rep.skipped++;
      continue;
    }
    if (mode.mode === "OFF") {
      await prisma.mktMessage.update({ where: { id: m.id }, data: { status: "SKIPPED", statusNote: `لم تُرسل: ${mode.reasonAr}` } });
      rep.skipped++;
      continue;
    }
    const claimed = await prisma.mktMessage.updateMany({ where: { id: m.id, status: "QUEUED" }, data: { status: "SENDING", attempts: { increment: 1 } } });
    if (claimed.count === 0) continue;
    const to = mode.mode === "TEST" ? mode.phone : m.phone;
    const r = await sendTemplate({ to, template: tpl!.name, language: tpl!.language, body: tpl!.body, bodyParams: (m.variables as string[]) ?? [] }, fetchImpl);
    if (r.ok) {
      await prisma.$transaction(async (tx) => {
        await tx.mktMessage.update({ where: { id: m.id }, data: { status: "SENT", providerId: r.providerId, sentAt: new Date(), statusNote: mode.mode === "TEST" ? `وضع الاختبار: أُرسلت إلى رقم الاختبار بدلاً من العميل.` : null } });
        await tx.mktTouch.create({ data: { subjectKey: m.phone, at: new Date(), channel: "WHATSAPP", campaignId: m.campaignId, messageId: m.id, detail: { kind: "sent", test: mode.mode === "TEST" } } });
      }, TX_OPTS);
      rep.sent++;
    } else {
      const retry = r.definite && r.transient && m.attempts + 1 < 4;
      await prisma.mktMessage.update({
        where: { id: m.id },
        data: retry ? { status: "QUEUED", scheduledAt: new Date(Date.now() + 5 * 60_000 * (m.attempts + 1)), statusNote: r.detail } : { status: "FAILED", failedAt: new Date(), statusNote: r.definite ? r.detail : `${r.detail} — قد تكون وصلت؛ لا تُعاد تلقائياً.` },
      });
      rep.failed++;
    }
  }
  return rep;
}

/** Delivery statuses and inbound «stop» from the Cloud API webhook. Idempotent. */
export async function applyCloudWebhook(payload: unknown) {
  const { statuses, inbound } = parseWebhook(payload);
  let updated = 0, optOuts = 0;
  const rank: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3 };
  for (const s of statuses) {
    const m = await prisma.mktMessage.findUnique({ where: { providerId: s.providerId } });
    if (!m) continue;
    if (s.status === "failed") {
      await prisma.mktMessage.update({ where: { id: m.id }, data: { status: "FAILED", failedAt: s.at, statusNote: s.errorText } });
    } else {
      const next = s.status.toUpperCase();
      if ((rank[next] ?? 0) <= (rank[m.status] ?? 0)) continue; // statuses can arrive out of order
      await prisma.mktMessage.update({ where: { id: m.id }, data: { status: next, ...(next === "DELIVERED" ? { deliveredAt: s.at } : {}), ...(next === "READ" ? { readAt: s.at, deliveredAt: m.deliveredAt ?? s.at } : {}) } });
    }
    updated++;
  }
  for (const i of inbound) {
    if (!isOptOutText(i.text)) continue;
    const p = normalizePhoneForWhatsApp(i.from);
    if (!p.ok) continue;
    await prisma.$transaction(async (tx) => {
      await setConsent(tx, { phone: p.phone, status: "OPTED_OUT", source: "REPLY_STOP", evidence: i.text.slice(0, 200), actorId: null });
      await audit(tx, { kind: "WEBHOOK", name: "whatsapp" }, "consent.opt_out_reply", "MktConsent", p.phone, { note: i.text.slice(0, 200) });
    }, TX_OPTS);
    optOuts++;
  }
  return { updated, optOuts };
}

export async function listMessages(q: { status?: string | null; search?: string | null; page: number }) {
  const where: Prisma.MktMessageWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.search ? { phone: { contains: q.search.replace(/\D/g, "") } } : {}) };
  const [rows, total, counts] = await Promise.all([
    prisma.mktMessage.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * 50, take: 50, include: { campaign: { select: { id: true, name: true } } } }),
    prisma.mktMessage.count({ where }),
    prisma.mktMessage.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  return { rows, total, perPage: 50, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) };
}

export async function cancelMessage(id: string, actor: Actor) {
  if (!can(actor, "messaging_manage")) throw denied();
  const r = await prisma.mktMessage.updateMany({ where: { id, status: "QUEUED" }, data: { status: "CANCELLED", statusNote: `ألغاها ${actor.name}` } });
  if (r.count === 0) throw new MktError("الرسالة ليست في قائمة الانتظار.", "Message is not queued.", 409);
}

/**
 * A signed Karzoun delivery (the route verified X-Karzoun-Signature-256 before calling). Recorded
 * once per event id — Karzoun retries with the same id — and only an unsubscribe is acted on.
 */
export async function applyKarzounWebhook(raw: string) {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new MktError("صيغة غير صالحة.", "Invalid JSON.", 400); }
  const { phones, eventId, event } = karzounOptOut(payload);
  const eventKey = (eventId ?? sha256(raw)).slice(0, 200);
  const ev = await prisma.mktWebhookEvent.upsert({
    where: { source_eventKey: { source: "KARZOUN", eventKey } },
    create: { source: "KARZOUN", eventKey, signatureOk: true, payload: payload as Prisma.InputJsonValue, topic: event },
    update: {},
  });
  if (ev.status === "PROCESSED" || ev.status === "IGNORED") return { duplicate: true, optOuts: 0 };
  let optOuts = 0;
  for (const raw of phones) {
    const p = normalizePhoneForWhatsApp(raw);
    if (!p.ok) continue;
    const c = await prisma.mktConsent.findUnique({ where: { phone_channel: { phone: p.phone, channel: "WHATSAPP" } }, select: { status: true } });
    if (c?.status === "OPTED_OUT") continue;
    await prisma.$transaction(async (tx) => {
      await setConsent(tx, { phone: p.phone, status: "OPTED_OUT", source: "KARZOUN", evidence: `${event ?? "karzoun"} ${eventId ?? ""}`.trim().slice(0, 200), actorId: null });
      await audit(tx, { kind: "WEBHOOK", name: "karzoun" }, "consent.opt_out_karzoun", "MktConsent", p.phone, { note: event ?? undefined });
    }, TX_OPTS);
    optOuts++;
  }
  await prisma.mktWebhookEvent.update({ where: { id: ev.id }, data: { status: phones.length ? "PROCESSED" : "IGNORED", processedAt: new Date() } });
  return { duplicate: false, optOuts };
}
