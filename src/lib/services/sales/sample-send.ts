// D22 «إرسال عيّنة» (owner-approved design 2010:2 / workflow 2024:68, 11 Nov 2026) — the sample sent from the tax invoice page.
//
// ONE transaction composes the existing services:
//   1. the deal            the deal given, else resolveQuickDeal (the customer's one open deal of the account owner, a new
//                          one opened for the sample, or — several open — the most recently active one); it stays OPEN for
//                          the follow-up and moves forward to «تقييم العيّنة» (advanceToPurpose, as a sample request does);
//   2. the samples         requestStockSampleIn per line — one unit of each SKU (SAMPLE_ONE_UNIT), the one-per-product rule
//                          in the calendar year (a second waits for a manager: sales › lead_assign or sample_approve_repeat),
//                          the dispatch queue and its notifications, exactly as the deal page's request;
//   3. the invoice DRAFT    createSampleDraftIn — channel SAMPLE, externalOrderRef = the first sample's id; every line at its
//                          list price with the 100 % discount pre-filled (the rep may change price, discount or VAT; the
//                          accountant reviews before issue) — a zero invoice posts nothing; a line below 100 % is a sale
//                          (revenue + VAT at issue) — and its request to the accountant (requestInvoiceIn);
//   4. an audit row        SAMPLE_SEND_CREATED (the samples, the invoice, the deal, the request key).
// Idempotent through the client's requestKey: `sample-send:<key>` on the draft (unique) under an advisory lock — a second tap
// replays the first send, never a second set of samples.
//
// The VAT alert (sales › samples_vat_alert): the list value of the customer's samples in the calendar year (this send
// included) against SystemConfig.salesSampleVatAlertSar (NULL = 200). An alert only — deemed supply is self-assessed by the
// accountant (zatca.gov.sa); nothing is computed or posted from it.
import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { audit } from "@/lib/hr/core";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { cancelDraftIn, createSampleDraftIn, removeDraftSkuLinesIn } from "@/lib/services/invoicing/service";
import { requestInvoiceIn } from "@/lib/services/invoicing/requests";
import { parseLines, priceInvoice, type RawLine } from "@/lib/services/invoicing/pricing";
import { requestStockSampleIn } from "./sample-request";
import { sampleYearStart } from "./sample-rules";
import { resolveQuickDeal, actsForAccountOwner } from "./quick-deal";
import { advanceToPurpose } from "./lifecycle";
import { customerInScope } from "./customer-access";
import { assertTaxAllowed, parseHeader, parseLineTerms, invoiceRawLines, type LineTerms } from "./direct-sale-terms";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/** Namespace of the per-key advisory lock (beside 7771 direct sale). */
const SAMPLE_SEND_LOCK_NAMESPACE = 7772;
export const SAMPLE_VAT_ALERT_DEFAULT = 200;
export const MAX_SAMPLE_LINES = 20;

export type SampleSendActor = { id: string; name: string; role?: string | null; permissions: Permissions | Record<string, unknown> };

const refuse = (status: number, code: string, ar: string, en: string, extra: Record<string, unknown> = {}) =>
  ({ _appCode: status, code, message: ar, errorAr: ar, error: ar, errorEn: en, ...extra });

/** May this actor send a sample from the invoice page: request samples (sales › lead_write) and prepare invoices. */
export function maySendSample(permissions: Permissions | Record<string, unknown>): boolean {
  const p = permissions as Permissions;
  return hasSubPrivilege(p, "sales", "lead_write") && hasSubPrivilege(p, "sales", "invoices_create") && hasModuleAccess(p, "customers");
}
export const seesSampleVatAlert = (permissions: Permissions | Record<string, unknown>) => hasSubPrivilege(permissions as Permissions, "sales", "samples_vat_alert");

export function sampleSendKey(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(raw)) throw refuse(400, "REQUEST_KEY_REQUIRED", "مفتاح الطلب ناقص أو غير صالح.", "requestKey is missing or invalid.");
  return `sample-send:${raw}`;
}

/** The alert threshold in force (SAR). */
export async function sampleVatAlertThreshold(db: Db): Promise<Prisma.Decimal> {
  const row = await db.systemConfig.findUnique({ where: { id: "singleton" }, select: { salesSampleVatAlertSar: true } });
  return new Prisma.Decimal((row?.salesSampleVatAlertSar ?? SAMPLE_VAT_ALERT_DEFAULT).toString());
}

/** The list value (today's list price × units) of a customer's samples in the calendar year, CANCELLED excluded. */
export async function customerSampleYearValue(db: Db, customerId: string, now: Date = new Date()): Promise<Prisma.Decimal> {
  const rows = await db.sampleShipment.findMany({
    where: { status: { not: "CANCELLED" }, productSkuId: { not: null }, createdAt: { gte: sampleYearStart(now) }, opportunity: { customerId } },
    select: { quantity: true, productSku: { select: { price: true } } },
  });
  return rows.reduce((t, r) => t.plus(new Prisma.Decimal(r.quantity.toString()).times((r.productSku?.price ?? 0).toFixed(2))), new Prisma.Decimal(0)).toDecimalPlaces(2);
}

/** What the page shows for a customer before «أرسل»: the products already sampled this year, and the alert (if the actor
 *  may see it). */
export async function sampleSendFacts(actor: SampleSendActor, customerId: string, now: Date = new Date()) {
  if (!(await customerInScope(actor, customerId))) throw refuse(404, "CUSTOMER_NOT_IN_BOOK", "العميل غير موجود أو غير مسند لك.", "Customer not found or not assigned to you.");
  const rows = await prisma.sampleShipment.findMany({
    where: { status: { not: "CANCELLED" }, productSkuId: { not: null }, createdAt: { gte: sampleYearStart(now) }, opportunity: { customerId } },
    select: { createdAt: true, productSku: { select: { id: true, productId: true } } },
    orderBy: { createdAt: "asc" },
  });
  const byProduct = new Map<string, string>();
  for (const r of rows) if (r.productSku && !byProduct.has(r.productSku.productId)) byProduct.set(r.productSku.productId, r.createdAt.toISOString());
  const alert = seesSampleVatAlert(actor.permissions)
    ? { yearValue: (await customerSampleYearValue(prisma, customerId, now)).toFixed(2), threshold: (await sampleVatAlertThreshold(prisma)).toFixed(2) }
    : null;
  // D22 gate (owner 2أ): the customer's open deals a sample may go on — the account owner's (resolveQuickDeal's set), most
  // recently active first — for «تربطه بصفقة؟» (D21 labels) when there are several.
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true, nameAr: true, accountOwnerId: true } });
  // Gate B1: resolveQuickDeal's own rule — another rep's customer (account owner not the caller, no team reach) shows NO
  // deals: their titles and amounts are the owner's. The POST refuses it the same way (NOT_ACCOUNT_OWNER).
  const owner = c?.accountOwnerId ?? actor.id;
  const mayList = owner === actor.id || actsForAccountOwner(actor);
  const deals = !mayList ? [] : await prisma.opportunity.findMany({
    where: { customerId, outcome: "OPEN", ownerId: owner },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }], take: 20,
    select: { id: true, title: true, amount: true, createdAt: true, stage: { select: { nameAr: true, nameEn: true } }, _count: { select: { quotes: true, samples: true } }, quotes: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } },
  });
  return {
    sampledProducts: [...byProduct].map(([productId, at]) => ({ productId, at })), alert, taxOverride: false,
    customerNames: [c?.nameAr ?? null, c?.name ?? null].filter(Boolean),
    deals: deals.map((d) => ({ id: d.id, title: d.title, amount: d.amount == null ? null : d.amount.toFixed(2), createdAt: d.createdAt.toISOString(), stageAr: d.stage.nameAr, stageEn: d.stage.nameEn, quotes: d._count.quotes, samples: d._count.samples, quoteAt: d.quotes[0]?.createdAt.toISOString() ?? null })),
  };
}

export type SampleSendResult = {
  replayed: boolean;
  opportunityId: string;
  invoice: { id: string; requested: boolean };
  samples: { id: string; productSkuId: string; approval: string }[];
  /** Some sample waits for a manager's approval (a repeat of the product this year) — it is not prepared before. */
  pendingApproval: boolean;
  totals: { net: string; tax: string; gross: string };
  vatAlert: { yearValue: string; threshold: string; over: boolean } | null;
};

/** «أرسل» on the sample page. Throws `{ _appCode, code, errorAr }` refusals (handleDomainError maps them). */
export async function createSampleSend(
  input: { customerId: unknown; opportunityId?: unknown; lines: unknown; requestKey: unknown; note?: unknown; invoice?: unknown },
  actor: SampleSendActor,
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<SampleSendResult> {
  if (!maySendSample(actor.permissions)) throw refuse(403, "FORBIDDEN", "ما عندك صلاحية إرسال عيّنة.", "You may not send a sample.");
  const key = sampleSendKey(input.requestKey);
  if (typeof input.customerId !== "string" || !input.customerId.trim()) throw refuse(400, "CUSTOMER_REQUIRED", "اختر العميل.", "Choose the customer.");
  const customerId = input.customerId.trim();
  if (!(await customerInScope(actor, customerId))) throw refuse(404, "CUSTOMER_NOT_IN_BOOK", "العميل غير موجود أو غير مسند لك.", "Customer not found or not assigned to you.");
  if (Array.isArray(input.lines) && input.lines.length > MAX_SAMPLE_LINES) throw refuse(400, "TOO_MANY_LINES", `الحد ${MAX_SAMPLE_LINES} صنف في العيّنة.`, `At most ${MAX_SAMPLE_LINES} products in a sample.`);
  const header = parseHeader(input.invoice);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) || null : null;

  const out = await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SAMPLE_SEND_LOCK_NAMESPACE}, hashtext(${key}))`;
    const hit = await tx.hrAuditLog.findFirst({ where: { action: "SAMPLE_SEND_CREATED", after: { path: ["requestKey"], equals: key } }, select: { after: true } });
    if (hit) {
      const a = hit.after as { customerId?: string; opportunityId: string; invoiceId: string; samples: SampleSendResult["samples"]; totals: SampleSendResult["totals"] };
      if (a.customerId !== customerId) throw refuse(409, "REQUEST_KEY_REUSED", "مفتاح الطلب مستخدم لعملية ثانية.", "This requestKey belongs to another send.");
      return { replayed: true, opportunityId: a.opportunityId, invoice: { id: a.invoiceId, requested: true }, samples: a.samples, pendingApproval: a.samples.some((s) => s.approval === "PENDING"), totals: a.totals };
    }

    // The lines: SKUs in units, their list price, the 100 % discount pre-filled (the rep's own figures win).
    const ids = Array.isArray(input.lines) ? input.lines.map((l) => String((l as { productSkuId?: unknown })?.productSkuId ?? "")).filter(Boolean) : [];
    const skus = await tx.productSKU.findMany({ where: { id: { in: ids } }, select: { id: true, skuCode: true, name: true, nameAr: true, price: true, isActive: true, product: { select: { productNameAr: true, productNameEn: true } } } });
    const terms: LineTerms[] = parseLineTerms(input.lines, new Map(skus.map((s) => [s.id, { price: s.price }])), "100");
    // D22 (owner, option 1): S at the default rate unless the caller holds sales › invoice_tax_override (else 400 TAX_LOCKED).
    // P0 C5: a new send is S at the standard rate (an override is a request on the draft, approved by a second person).
    assertTaxAllowed(terms);
    const byId = new Map(skus.map((s) => [s.id, s]));
    for (const t of terms) {
      const s = byId.get(t.productSkuId);
      if (!s || !s.isActive) throw refuse(400, "SKU_UNAVAILABLE", "صنف غير متاح.", "A product is not available.", { productSkuId: t.productSkuId });
      if (t.quantityUnits !== 1) throw refuse(409, "SAMPLE_ONE_UNIT", "العيّنة حبة وحدة من كل صنف.", "A sample is one unit of each product.", { productSkuId: t.productSkuId });
    }
    const names = new Map(skus.map((s) => [s.id, { name: s.nameAr || s.name || s.product.productNameAr || s.product.productNameEn, skuCode: s.skuCode }]));
    const raw = invoiceRawLines(terms, names);
    const parsed = parseLines(raw as RawLine[]);
    if (parsed.problems.length) {
      const p = parsed.problems[0];
      throw refuse(400, "LINES_INVALID", `${p.index >= 0 ? `البند ${p.index + 1}: ` : ""}${p.ar}`, `${p.index >= 0 ? `Line ${p.index + 1}: ` : ""}${p.en}`, { problems: parsed.problems });
    }
    const priced = priceInvoice(parsed.lines);

    // 1 · the deal
    let opportunityId = typeof input.opportunityId === "string" && input.opportunityId ? input.opportunityId : "";
    if (opportunityId) {
      const d = await tx.opportunity.findUnique({ where: { id: opportunityId }, select: { customerId: true } });
      if (!d || d.customerId !== customerId) throw refuse(404, "DEAL_NOT_FOUND", "الصفقة غير موجودة لهذا العميل.", "Deal not found for this customer.");
    } else {
      const q = await resolveQuickDeal(tx, { id: actor.id, canOpenDeal: hasSubPrivilege(actor.permissions as Permissions, "sales", "lead_convert"), teamView: actsForAccountOwner(actor) }, customerId, "sample", now);
      if (q.kind === "forbidden") throw refuse(403, "NOT_ACCOUNT_OWNER", "هذا العميل له مندوب آخر — اطلب من مديرك أو من مندوبه.", "This customer belongs to another rep.");
      if (q.kind === "none") throw refuse(403, "NO_DEAL", "ما عندك صفقة مفتوحة مع هذا العميل، وما عندك صلاحية تفتح وحدة.", "You have no open deal with this customer and may not open one.");
      if (q.kind === "pick") opportunityId = q.deals[0].id; // the most recently active (resolveQuickDeal orders by updatedAt desc)
      else if (q.kind === "use" || q.kind === "created") opportunityId = q.opportunityId;
      else throw refuse(409, "NO_DEAL", "ما انربطت العيّنة بصفقة.", "The sample has no deal.");
    }

    // 2 · the samples (one per line), the stage
    const samples: SampleSendResult["samples"] = [];
    for (const t of terms) {
      const r = await requestStockSampleIn(tx, { opportunityId, productSkuId: t.productSkuId, units: 1, description: note, noReplayWindow: true }, { id: actor.id, permissions: actor.permissions, role: actor.role });
      samples.push({ id: r.sample.id, productSkuId: t.productSkuId, approval: r.sample.approval });
    }
    await advanceToPurpose(tx, opportunityId, "SAMPLE_EVALUATION", actor.id, "a sample was sent from the invoice page");

    // 3 · the invoice draft and its request
    // The draft names a sample still waiting for the manager when there is one (أبو فهد B1): the database refuses to issue a
    // SAMPLE invoice whose named sample waits — so it cannot be issued before every sample of the send is decided.
    const ref = samples.find((x) => x.approval === "PENDING") ?? samples[0];
    const draft = await createSampleDraftIn(tx, { customerId, lines: raw, requestKey: key, externalOrderRef: ref.id, header }, { ...ctx, actorId: actor.id });
    const pending = samples.some((s) => s.approval === "PENDING");
    await requestInvoiceIn(tx, draft.id, [pending ? "عيّنة ثانية تنتظر موافقة المدير قبل التحضير." : null, note].filter(Boolean).join(" — ") || null, { ...ctx, actorId: actor.id }, now);
    const totals = { net: priced.taxableTotal.toFixed(2), tax: priced.taxTotal.toFixed(2), gross: priced.grandTotal.toFixed(2) };

    // 4 · the audit row
    await audit(tx, {
      action: "SAMPLE_SEND_CREATED", entityType: "SalesInvoice", entityId: draft.id, actorId: actor.id,
      after: { requestKey: key, customerId, opportunityId, invoiceId: draft.id, samples, totals, lines: terms },
    });
    return { replayed: false, opportunityId, invoice: { id: draft.id, requested: true }, samples, pendingApproval: pending, totals };
  }, TX_OPTS);

  const vatAlert = seesSampleVatAlert(actor.permissions) ? await (async () => {
    const yearValue = await customerSampleYearValue(prisma, customerId, now);
    const threshold = await sampleVatAlertThreshold(prisma);
    return { yearValue: yearValue.toFixed(2), threshold: threshold.toFixed(2), over: yearValue.greaterThan(threshold) };
  })() : null;
  return { ...out, vatAlert };
}

/**
 * D22 gates (orchestrator, 11 Nov 2026 — R1 decline, R2-L1 every cancellation): a sample of a «إرسال عيّنة» that leaves the
 * send — a manager DECLINED its repeat (sample-request.ts decideSampleApproval) or the rep CANCELLED it (PATCH
 * /api/sales/samples/[id]; dispatch never cancels) — takes its zero invoice with it, in the same transaction:
 *   · the draft is CANCELLED (cancelDraftIn: the reason, the request event) when no other sample of the send is still open;
 *   · otherwise only that product's line leaves the draft (removeDraftSkuLinesIn) and the rest stays requested — the draft
 *     re-pointed (repointSendDraftIn) at a sample still open, one waiting for the manager first, so the database's rule
 *     (sinv_invoice_guard: the named sample exists, is not CANCELLED, needs no approval or has it) holds at issue;
 *   · an invoice already ISSUED is never touched (a credit note is the accountant's) — KEPT_ISSUED.
 * Every outcome writes SAMPLE_SEND_SAMPLE_DECLINED / SAMPLE_SEND_SAMPLE_CANCELLED. Not a send's sample: nothing.
 */
export async function withdrawSampleFromSendIn(tx: Tx, sampleId: string, actorId: string, reason: string | null, cause: "DECLINED" | "CANCELLED") {
  const a = await sendOfSampleIn(tx, sampleId);
  if (!a) return null;
  const mine = a.samples.find((x) => x.id === sampleId)!;
  const inv = await tx.salesInvoice.findUnique({ where: { id: a.invoiceId }, select: { status: true } });
  const why = cause === "DECLINED" ? "عيّنة مرفوضة من المدير" : "عيّنة ملغاة";
  let outcome: "CANCELLED" | "LINE_REMOVED" | "KEPT_ISSUED" | "ALREADY_CANCELLED" = "ALREADY_CANCELLED";
  if (inv?.status === "DRAFT") {
    // The ledger audit trail names who declined / cancelled (a decision's own transaction carries no request context).
    await setAuditContext(tx, { actorId, reason: reason ? `${why} — ${reason}` : why });
    const open = await tx.sampleShipment.count({ where: { id: { in: a.samples.map((x) => x.id).filter((x) => x !== sampleId) }, status: { not: "CANCELLED" } } });
    if (open === 0) {
      await cancelDraftIn(tx, a.invoiceId, `${why}${reason ? ` — ${reason}` : ""}`, actorId);
      outcome = "CANCELLED";
    } else {
      await removeDraftSkuLinesIn(tx, a.invoiceId, mine.productSkuId);
      await repointSendDraftIn(tx, a.invoiceId, a.samples.map((x) => x.id));
      outcome = "LINE_REMOVED";
    }
  } else if (inv?.status === "ISSUED") {
    outcome = "KEPT_ISSUED";
  }
  await audit(tx, {
    action: cause === "DECLINED" ? "SAMPLE_SEND_SAMPLE_DECLINED" : "SAMPLE_SEND_SAMPLE_CANCELLED",
    entityType: "SalesInvoice", entityId: a.invoiceId, actorId, after: { sampleId, productSkuId: mine.productSkuId, outcome, reason },
  });
  return { invoiceId: a.invoiceId, outcome };
}

/** The send of a sample (its invoice and every sample of it), from the SAMPLE_SEND_CREATED audit row; null when not a send's. */
export async function sendOfSampleIn(tx: Tx, sampleId: string) {
  const send = await tx.hrAuditLog.findFirst({
    where: { action: "SAMPLE_SEND_CREATED", after: { path: ["samples"], array_contains: [{ id: sampleId }] } },
    select: { after: true },
  });
  return send ? (send.after as { invoiceId: string; samples: { id: string; productSkuId: string }[] }) : null;
}

/**
 * أبو فهد B1 / R2-L1: a send's DRAFT names the sample that should hold its issue — one still waiting for the manager when
 * there is one, else any sample still open (never a CANCELLED one). The database trigger checks the named sample.
 */
export async function repointSendDraftIn(tx: Tx, invoiceId: string, sampleIds: string[]) {
  // Gate R3-L1: the draft's row is locked first — a cancel and an approve of two samples of one send serialise here, and
  // the second reads the samples as the first left them (never naming a sample cancelled a moment earlier).
  await tx.$queryRaw`SELECT "id" FROM "SalesInvoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
  const inv = await tx.salesInvoice.findUnique({ where: { id: invoiceId }, select: { status: true, externalOrderRef: true } });
  if (inv?.status !== "DRAFT") return;
  const open = await tx.sampleShipment.findMany({
    where: { id: { in: sampleIds }, status: { not: "CANCELLED" } },
    select: { id: true, approvalRequired: true, approvedAt: true }, orderBy: { createdAt: "asc" },
  });
  const next = open.find((x) => x.approvalRequired && !x.approvedAt) ?? open[0];
  if (next && next.id !== inv.externalOrderRef) await tx.salesInvoice.update({ where: { id: invoiceId }, data: { externalOrderRef: next.id } });
}

/** A manager approved a repeat sample: the send's draft moves on to the next sample still waiting, if any. */
export async function sampleApprovedIn(tx: Tx, sampleId: string) {
  const a = await sendOfSampleIn(tx, sampleId);
  if (a) await repointSendDraftIn(tx, a.invoiceId, a.samples.map((x) => x.id));
}

/** A manager declined a repeat sample (sample-request.ts). */
export const withdrawDeclinedSampleIn = (tx: Tx, sampleId: string, actorId: string, reason: string | null) =>
  withdrawSampleFromSendIn(tx, sampleId, actorId, reason, "DECLINED");
