// P0 SEC-02 (owner decision C4, 11 Nov 2026): a direct sale's or a free sample's invoice DRAFT keeps the rules it was
// made under after the rep withdraws it and edits it. One row per draft (SalesInvoiceDraftControl,
// 20261230090000_p0_rep_security):
//
//   · baseline — the terms as first sent to the accountant (the «تعدّلت بعد الإرسال» diff, and the terms the creation
//     rules already passed: a draft still on its baseline is never re-judged, even if a product was deactivated since);
//   · an edit away from the baseline re-applies the creation rules on the server:
//       direct sale — every line's VAT standard unless an approved override (C5), an INACTIVE product refused, the discount
//                     measured against the list (a price below the list is a discount), above 60 % refused; above the
//                     threshold (45 %) without sales › quote_approve_discount the SAME draft waits for the supervisor
//                     (PENDING, through the approvals inbox); a line without an approved list price needs them too;
//       sample      — only the send's own products, one unit each at the list price; the discount 0–100 %.
//   · while PENDING / REJECTED / or the fingerprint of the terms differs from the approved one, the draft is neither
//     requested nor issued (DRAFT_APPROVAL_*). The thresholds and who approves are unchanged.
import type { Prisma } from "@/generated/prisma/client";
import { Prisma as P } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { isSimpleMode } from "@/lib/simple-mode";
import { audit } from "@/lib/hr/core";
import { SAMPLE_CHANNEL, priceInvoiceLine } from "./pricing";
import { Decimal as M } from "@/lib/accounting/money";
import { discountFigures, fingerprint, needsApproval, num } from "@/lib/services/sales/discount-rules";
import { discountThreshold } from "@/lib/services/sales/quote-settings";
import { assertLinesTax } from "@/lib/services/sales/tax-override";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;
type Dec = { toString(): string };
export type ControlKind = "DIRECT_SALE" | "SAMPLE";

/** The commercial terms of one line, as the control compares and fingerprints them. */
export type TermLine = {
  productSkuId: string | null; orderItemId: string | null; description?: string | null; quantity: string; unit: string; unitPrice: string; discountPercent: string;
  taxCategory: string; taxRatePercent: string; exemptionReasonCode: string | null;
};
export type DraftTerms = { lines: TermLine[]; paymentTermsDays: number | null };

type LineLike = { productSkuId: string | null; orderItemId: string | null; description?: string | null; quantity: Dec; unit: string; unitPrice: Dec; discountPercent: Dec; taxCategory: string; taxRatePercent: Dec; exemptionReasonCode: string | null };

const refuse = (status: number, code: string, ar: string, en: string, extra: Record<string, unknown> = {}) =>
  ({ _appCode: status, code, message: ar, errorAr: ar, error: ar, errorEn: en, ...extra });

/** A document's lines as terms (pure). */
export function termsOf(lines: LineLike[], paymentTermsDays: number | null): DraftTerms {
  return {
    paymentTermsDays: paymentTermsDays ?? null,
    lines: lines.map((l) => ({
      productSkuId: l.productSkuId ?? null, orderItemId: l.orderItemId ?? null, description: l.productSkuId ? null : (l.description ?? null), quantity: num(l.quantity.toString())!, unit: l.unit,
      unitPrice: num(l.unitPrice.toString())!, discountPercent: num(l.discountPercent.toString())!, taxCategory: l.taxCategory,
      taxRatePercent: num(l.taxRatePercent.toString())!, exemptionReasonCode: l.exemptionReasonCode ?? null,
    })),
  };
}

export const termsHash = (t: DraftTerms) => fingerprint(t);
/** The terms without their VAT treatment: a VAT change is judged by the tax lock and its own approval (C5), not as a
 *  discount — a draft whose only change is an approved VAT treatment is still on its commercial baseline. */
const commercialHash = (t: DraftTerms) => fingerprint({ ...t, lines: t.lines.map((l) => ({ productSkuId: l.productSkuId, orderItemId: l.orderItemId, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, discountPercent: l.discountPercent })) });

/** «تعدّلت بعد الإرسال»: what changed from the baseline, per line (pure). Empty when nothing did. */
export function termsDiff(base: DraftTerms, now: DraftTerms): { line: number; field: string; before: string | null; after: string | null }[] {
  const out: { line: number; field: string; before: string | null; after: string | null }[] = [];
  const fields: (keyof TermLine)[] = ["productSkuId", "quantity", "unitPrice", "discountPercent", "taxCategory", "taxRatePercent", "exemptionReasonCode"];
  const n = Math.max(base.lines.length, now.lines.length);
  for (let i = 0; i < n; i++) {
    const a = base.lines[i], b = now.lines[i];
    if (!a) { out.push({ line: i + 1, field: "added", before: null, after: b.productSkuId }); continue; }
    if (!b) { out.push({ line: i + 1, field: "removed", before: a.productSkuId, after: null }); continue; }
    for (const f of fields) if ((a[f] ?? null) !== (b[f] ?? null)) out.push({ line: i + 1, field: f, before: (a[f] as string | null) ?? null, after: (b[f] as string | null) ?? null });
  }
  if ((base.paymentTermsDays ?? null) !== (now.paymentTermsDays ?? null)) out.push({ line: 0, field: "paymentTermsDays", before: base.paymentTermsDays === null ? null : String(base.paymentTermsDays), after: now.paymentTermsDays === null ? null : String(now.paymentTermsDays) });
  return out;
}

/** Which draft the control watches: a SAMPLE invoice, or the invoice of a direct-sale order. Others → null. */
export async function controlKindOf(db: Db, doc: { kind: string; channel: string | null; orderId: string | null }): Promise<ControlKind | null> {
  if (doc.kind !== "INVOICE") return null;
  if (doc.channel === SAMPLE_CHANNEL) return "SAMPLE";
  if (!doc.orderId) return null;
  const o = await db.order.findUnique({ where: { id: doc.orderId }, select: { channel: true } });
  return o?.channel === "DIRECT_SALE" ? "DIRECT_SALE" : null;
}

/** The figures of a direct-sale draft's terms against the list; refuses an inactive product and the 60 % ceiling. */
async function directSaleRule(db: Db, t: DraftTerms, threshold: P.Decimal) {
  const ids = [...new Set(t.lines.map((l) => l.productSkuId).filter((x): x is string => !!x))];
  const skus = ids.length ? await db.productSKU.findMany({ where: { id: { in: ids } }, select: { id: true, isActive: true, price: true } }) : [];
  const byId = new Map(skus.map((s) => [s.id, s]));
  const f = discountFigures(t.lines.map((l) => {
    const net = priceInvoiceLine({ quantity: new M(l.quantity), unitPrice: new M(l.unitPrice), discountPercent: new M(l.discountPercent), taxRatePercent: new M(l.taxRatePercent), taxCategory: l.taxCategory as "S" }).lineNet.toString();
    const s = l.productSkuId ? byId.get(l.productSkuId) : undefined;
    return { sku: l.productSkuId ? (s ? { isActive: s.isActive, price: s.price.toString() } : { isActive: false, price: 0 }) : null, quantity: l.quantity, lineNet: net };
  }));
  if (f.inactiveLines.length) throw refuse(400, "SKU_INACTIVE", `البند ${f.inactiveLines[0] + 1}: الصنف موقوف — احذفه أو اختر صنف ثاني.`, `Line ${f.inactiveLines[0] + 1}: the product is inactive — remove it or pick another.`);
  if (f.overCeiling.length) throw refuse(400, "DISCOUNT_CEILING", `البند ${f.overCeiling[0] + 1}: الخصم عن سعر القائمة أكثر من 60% — ما يُقبل.`, `Line ${f.overCeiling[0] + 1}: the discount against the list is above 60% — not accepted.`);
  return { figures: f, needs: needsApproval(f, threshold) };
}

/** A sample's draft: the send's own products only, one unit each at the list price as sent; the discount 0–100 %. */
function sampleRule(base: DraftTerms, t: DraftTerms) {
  const sent = new Map(base.lines.filter((l) => l.productSkuId).map((l) => [l.productSkuId!, l]));
  t.lines.forEach((l, i) => {
    const b = l.productSkuId ? sent.get(l.productSkuId) : undefined;
    if (!b) throw refuse(400, "SAMPLE_TERMS_LOCKED", `البند ${i + 1}: فاتورة العيّنة لأصناف العيّنة المرسلة فقط.`, `Line ${i + 1}: a sample's invoice carries the sent samples only.`);
    if (l.quantity !== b.quantity || l.unit !== b.unit) throw refuse(400, "SAMPLE_TERMS_LOCKED", `البند ${i + 1}: العيّنة حبة وحدة — الكمية ما تتغير.`, `Line ${i + 1}: a sample is one unit — the quantity does not change.`);
    if (l.unitPrice !== b.unitPrice) throw refuse(400, "SAMPLE_TERMS_LOCKED", `البند ${i + 1}: سعر العيّنة سعر القائمة — يتغير الخصم بس.`, `Line ${i + 1}: a sample is at the list price — only the discount changes.`);
  });
  return { needs: false, maxEffective: null as P.Decimal | null };
}

async function ensureRow(tx: Tx, invoiceId: string, kind: ControlKind, current: DraftTerms) {
  const row = await tx.salesInvoiceDraftControl.findUnique({ where: { invoiceId } });
  if (row) return row;
  // First sight (the send itself, or a draft from before this batch): its current terms are the baseline.
  return tx.salesInvoiceDraftControl.create({ data: { invoiceId, kind, baselineTerms: current as unknown as Prisma.InputJsonValue, baselineHash: termsHash(current) } });
}

/** At the send (direct sale / sample): record the baseline. Idempotent. */
export async function recordBaseline(tx: Tx, invoiceId: string) {
  const doc = await tx.salesInvoice.findUnique({ where: { id: invoiceId }, select: { kind: true, channel: true, orderId: true, paymentTermsDays: true, lines: { orderBy: [{ position: "asc" }, { id: "asc" }] } } });
  if (!doc) return null;
  const kind = await controlKindOf(tx, doc);
  if (!kind) return null;
  return ensureRow(tx, invoiceId, kind, termsOf(doc.lines, doc.paymentTermsDays));
}

/**
 * A save of a controlled draft (updateDraft, after the lines are validated, before they are written): the creation rules
 * again. Returns the approval state the save leaves (null — no approval needed; PENDING — waiting for the supervisor).
 */
export async function checkDraftEdit(tx: Tx, input: {
  invoiceId: string; doc: { kind: string; channel: string | null; orderId: string | null; paymentTermsDays: number | null; customerId: string; createdById: string; lines: LineLike[] };
  next: { lines: LineLike[]; paymentTermsDays: number | null }; actor: { id: string; permissions: Permissions | Record<string, unknown> | null };
}): Promise<{ kind: ControlKind; approval: "PENDING" | "APPROVED" | null } | null> {
  const kind = await controlKindOf(tx, input.doc);
  if (!kind) return null;
  const row = await ensureRow(tx, input.invoiceId, kind, termsOf(input.doc.lines, input.doc.paymentTermsDays));
  const next = termsOf(input.next.lines, input.next.paymentTermsDays);
  // C5 / C6: VAT is standard unless a second person approved the treatment on this draft (400 TAX_LOCKED).
  await assertLinesTax(tx, "INVOICE", input.invoiceId, next.lines);
  const hash = termsHash(next);
  const clear = { approvalStatus: null, approvalHash: null, approvalPercent: null, requestedById: null, requestedAt: null, decidedById: null, decidedAt: null, decisionNote: null };
  if (hash === row.baselineHash || commercialHash(next) === commercialHash(row.baselineTerms as unknown as DraftTerms)) {
    if (row.approvalStatus) await tx.salesInvoiceDraftControl.update({ where: { invoiceId: input.invoiceId }, data: clear });
    return { kind, approval: null };
  }
  const base = row.baselineTerms as unknown as DraftTerms;
  const threshold = await discountThreshold(tx);
  const r = kind === "SAMPLE" ? sampleRule(base, next) : await (async () => { const x = await directSaleRule(tx, next, threshold); return { needs: x.needs, maxEffective: x.figures.maxEffective, custom: x.figures.customLines.length }; })();
  if (!r.needs) {
    if (row.approvalStatus) await tx.salesInvoiceDraftControl.update({ where: { invoiceId: input.invoiceId }, data: clear });
    return { kind, approval: null };
  }
  if (row.approvalStatus === "APPROVED" && row.approvalHash === hash) return { kind, approval: "APPROVED" };
  const pct = (r.maxEffective ?? new P.Decimal(0)).toDecimalPlaces(2);
  const now = new Date();
  if (input.actor.permissions && hasSubPrivilege(input.actor.permissions as Permissions, "sales", "quote_approve_discount")) {
    // An approver's own edit is approved by the edit (as an approver issuing a quotation records the approval).
    await tx.salesInvoiceDraftControl.update({ where: { invoiceId: input.invoiceId }, data: { ...clear, approvalStatus: "APPROVED", approvalHash: hash, approvalPercent: pct, requestedById: input.actor.id, requestedAt: now, decidedById: input.actor.id, decidedAt: now } });
    return { kind, approval: "APPROVED" };
  }
  await tx.salesInvoiceDraftControl.update({ where: { invoiceId: input.invoiceId }, data: { ...clear, approvalStatus: "PENDING", approvalHash: hash, approvalPercent: pct, requestedById: input.actor.id, requestedAt: now } });
  await audit(tx, { action: "INVOICE_DRAFT_APPROVAL_REQUESTED", entityType: "SalesInvoice", entityId: input.invoiceId, actorId: input.actor.id, after: { percent: pct.toString(), hash } });
  const c = await tx.customer.findUnique({ where: { id: input.doc.customerId }, select: { name: true, nameAr: true, accountOwnerId: true } });
  const { notify } = await import("@/lib/notifications/notify");
  await notify(tx, {
    event: "sales.invoice_draft_discount_pending", dedupeKey: `${input.invoiceId}:${hash}`, actorId: input.actor.id,
    entity: { type: "SalesInvoice", id: input.invoiceId },
    facts: { percent: pct.toString(), customerName: c ? c.nameAr || c.name : "", invoiceId: input.invoiceId },
    scopeOwners: [c?.accountOwnerId, input.doc.createdById],
  });
  return { kind, approval: "PENDING" };
}

/**
 * Before a request («إرسال للمحاسب») and before the issue: a controlled draft away from its baseline must be covered —
 * VAT standard or approved, and, when it needs the supervisor, approved on exactly these terms.
 */
export async function assertDraftCovered(tx: Tx, doc: { id: string; kind: string; channel: string | null; orderId: string | null; paymentTermsDays: number | null; lines: LineLike[] }): Promise<void> {
  const kind = await controlKindOf(tx, doc);
  if (!kind) return;
  const now = termsOf(doc.lines, doc.paymentTermsDays);
  const row = await ensureRow(tx, doc.id, kind, now);
  const hash = termsHash(now);
  await assertLinesTax(tx, "INVOICE", doc.id, now.lines);
  if (hash === row.baselineHash || commercialHash(now) === commercialHash(row.baselineTerms as unknown as DraftTerms)) return;
  const threshold = await discountThreshold(tx);
  const needs = kind === "SAMPLE" ? sampleRule(row.baselineTerms as unknown as DraftTerms, now).needs : (await directSaleRule(tx, now, threshold)).needs;
  if (!needs) return;
  if (row.approvalStatus === "APPROVED" && row.approvalHash === hash) return;
  if (row.approvalStatus === "PENDING" && row.approvalHash === hash) throw refuse(409, "DRAFT_APPROVAL_PENDING", "المسودة تنتظر موافقة المشرف على الخصم — ما تنرسل ولا تنصدر قبلها.", "The draft is waiting for the supervisor's discount approval — it is not sent or issued before it.");
  if (row.approvalStatus === "REJECTED" && row.approvalHash === hash) throw refuse(409, "DRAFT_APPROVAL_REJECTED", "المشرف رفض الخصم على هالمسودة — عدّل الخصم أو ألغِها.", "The supervisor refused this draft's discount — change the discount or cancel it.");
  throw refuse(409, "DRAFT_APPROVAL_REQUIRED", "المسودة تعدّلت بعد الموافقة — احفظها من جديد لتروح للمشرف.", "The draft changed after the approval — save it again to send it to the supervisor.");
}

/** The control's state for the screens (document page, queue): the approval and the «تعدّلت بعد الإرسال» diff. */
export async function draftControlView(db: Db, ids: string[], current: Map<string, DraftTerms>) {
  const rows = ids.length ? await db.salesInvoiceDraftControl.findMany({ where: { invoiceId: { in: ids } } }) : [];
  return new Map(rows.map((r) => {
    const now = current.get(r.invoiceId);
    return [r.invoiceId, {
      kind: r.kind, approval: r.approvalStatus, approvalPercent: r.approvalPercent?.toString() ?? null, decisionNote: r.decisionNote,
      requestedAt: r.requestedAt?.toISOString() ?? null,
      changedSinceSent: now ? termsDiff(r.baselineTerms as unknown as DraftTerms, now) : [],
    }];
  }));
}

/**
 * The supervisor's decision on a PENDING draft (sales › quote_approve_discount; the route asks the step-up). Four eyes
 * unless SIMPLE MODE (the same rule as the direct sale's own discount). The terms must still be the ones asked about.
 */
export async function decideDraftApproval(actor: { id: string; name?: string | null; permissions: Permissions | Record<string, unknown> }, invoiceId: string, input: { decision: unknown; note: unknown }) {
  if (!hasSubPrivilege(actor.permissions as Permissions, "sales", "quote_approve_discount")) throw refuse(403, "FORBIDDEN", "اعتماد الخصم لصاحب صلاحية اعتماد الخصومات.", "Deciding a discount needs the discount-approval permission.");
  const decision = input.decision === "APPROVE" ? "APPROVED" : input.decision === "REJECT" ? "REJECTED" : null;
  if (!decision) throw refuse(400, "BAD_INPUT", "القرار غير صحيح.", "Invalid decision.");
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) : "";
  if (decision === "REJECTED" && note.length < 2) throw refuse(400, "REASON_REQUIRED", "اذكر سبب الرفض.", "Give the reason for refusing.");
  return prisma.$transaction(async (tx) => {
    const lock = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "SalesInvoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
    if (!lock[0]) throw refuse(404, "NOT_FOUND", "المسودة غير موجودة.", "Draft not found.");
    if (lock[0].status !== "DRAFT") throw refuse(409, "NOT_DRAFT", "المستند ما عاد مسودة.", "The document is no longer a draft.");
    const row = await tx.salesInvoiceDraftControl.findUnique({ where: { invoiceId } });
    if (!row || row.approvalStatus !== "PENDING") throw refuse(409, "DECIDED", "ما فيه طلب موافقة قائم على هالمسودة.", "There is no pending approval on this draft.");
    if (!isSimpleMode() && row.requestedById === actor.id) throw refuse(403, "SELF_APPROVAL", "ما تعتمد خصم على تعديلك أنت.", "You cannot approve a discount on your own edit.");
    const doc = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { paymentTermsDays: true, customerId: true, createdById: true, lines: { orderBy: [{ position: "asc" }, { id: "asc" }] } } });
    if (termsHash(termsOf(doc.lines, doc.paymentTermsDays)) !== row.approvalHash) throw refuse(409, "STALE_REQUEST", "تغيّرت المسودة بعد الطلب — راجع الأرقام الجديدة.", "The draft changed after the request — review the new figures.");
    const at = new Date();
    await tx.salesInvoiceDraftControl.update({ where: { invoiceId }, data: { approvalStatus: decision, decidedById: actor.id, decidedAt: at, decisionNote: note || null } });
    await audit(tx, { action: decision === "APPROVED" ? "INVOICE_DRAFT_APPROVAL_APPROVED" : "INVOICE_DRAFT_APPROVAL_REJECTED", entityType: "SalesInvoice", entityId: invoiceId, actorId: actor.id, after: { percent: row.approvalPercent?.toString() ?? null, hash: row.approvalHash, note: note || null, requestedById: row.requestedById } });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, {
      event: "sales.invoice_draft_discount_decided", dedupeKey: `${invoiceId}:${row.approvalHash}:${decision}`, actorId: actor.id,
      entity: { type: "SalesInvoice", id: invoiceId }, people: { requester: row.requestedById ?? doc.createdById },
      facts: { decision: decision === "APPROVED" ? "APPROVE" : "REJECT", percent: row.approvalPercent?.toString() ?? "", note, invoiceId },
    });
    return { invoiceId, status: decision };
  });
}
