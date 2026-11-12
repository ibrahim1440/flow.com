// P0 C5 (owner, 11 Nov 2026): a change of a line's VAT treatment on a DRAFT quotation or invoice draft is a REQUEST with a
// written reason and a ZATCA treatment + reason code, decided by a SECOND person (sales › invoice_tax_override_approve —
// never the requester; the database CHECK holds that too), with an audit row for every step. Nothing is changed by the
// decision itself: once approved, a save of the draft that carries exactly the approved treatment on that line passes
// the tax lock (coveredLines); any other non-standard line is still 400 TAX_LOCKED. An issued document is never edited
// (corrections stay credit / debit notes).
import type { Prisma } from "@/generated/prisma/client";
import type { prisma as Prisma0 } from "@/lib/db";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { fingerprint, isStandard, legitimateTreatment, num, type TaxTreatment } from "./discount-rules";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof Prisma0;
// The database client and the audit writer load on first use (a pure caller — the quotation rules in a unit test — never
// opens a connection).
const db0 = async () => (await import("@/lib/db")).prisma;
const audit = async (...a: Parameters<typeof import("@/lib/hr/core").audit>) => (await import("@/lib/hr/core")).audit(...a);
export type OverrideDoc = "QUOTE" | "INVOICE";
export type OverrideEntry = TaxTreatment & { key: string };
type Actor = { id: string; name?: string | null; permissions: Permissions | Record<string, unknown> };

const refuse = (status: number, code: string, ar: string, en: string, extra: Record<string, unknown> = {}) =>
  ({ _appCode: status, code, message: ar, errorAr: ar, error: ar, errorEn: en, ...extra });

/** May ASK for a VAT change (sales › invoice_tax_override) — direct-sale-terms.ts mayOverrideTax, kept here without its imports. */
const mayOverrideTax = (p: Permissions | Record<string, unknown>) => hasSubPrivilege(p as Permissions, "sales", "invoice_tax_override");

export const mayApproveTaxOverride = (p: Permissions | Record<string, unknown>) => hasSubPrivilege(p as Permissions, "sales", "invoice_tax_override_approve");

/** What makes a line THE line an approval was given for. */
export type KeyLine = { productSkuId?: string | null; description?: string | null; quantity: { toString(): string } | string | number; unitPrice: { toString(): string } | string | number };

/**
 * A line's key on its document (P0 gate M1): its CONTENT — the SKU (or, for a custom line, its description), the quantity
 * and the unit price — never its position. Reordering the same line keeps its approval; another line moved to the place,
 * or the line's quantity / price changed, has another key and is locked again (the approval is void for it).
 *
 * Re-gate R2 (M1'): one approval covers exactly ONE line. Identical lines are told apart by their occurrence among the
 * identical lines (the first keeps the plain content key, the second is «#1», …), so a copy of an approved line has a
 * key of its own and no approval — it is locked. Reorder-safe: identical lines are interchangeable, and moving a
 * different line never changes an occurrence count. `lineKeys` keys a whole document (in its order); pure.
 */
const contentKey = (l: KeyLine, n: number) => {
  const base = { s: l.productSkuId ?? null, d: l.productSkuId ? null : (l.description ?? "").trim().replace(/\s+/g, " "), q: num(String(l.quantity)), p: num(String(l.unitPrice)) };
  return `line:${fingerprint(n === 0 ? base : { ...base, n }).slice(0, 32)}`;
};

type TaxedKeyLine = KeyLine & { taxCategory?: string | null; taxRatePercent?: { toString(): string } | string | number | null; exemptionReasonCode?: string | null };
const nonStandard = (l: TaxedKeyLine) => l.taxRatePercent != null && !isStandard({ taxCategory: (l.taxCategory ?? "S") as TaxTreatment["taxCategory"], taxRatePercent: String(l.taxRatePercent) });
const MAX_LINES = 200;

/** Keys of a whole document, in its order: identical lines get distinct keys (the request form names one of them). */
export function lineKeys(lines: KeyLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const first = contentKey(l, 0);
    const n = seen.get(first) ?? 0;
    seen.set(first, n + 1);
    return n === 0 ? first : contentKey(l, n);
  });
}

/**
 * Which approved treatment covers which line (R2 / M1'): within a group of identical lines every approval counts ONCE —
 * the group's approvals are a pool; a non-standard line already carrying an approved treatment takes one first, then
 * (`fill`) the remaining approvals go to the group's standard lines in order. A non-standard line left without one is
 * not covered (undefined). Order-free: the same lines in any order are covered the same way.
 */
export function coverLines(lines: TaxedKeyLine[], approved: Map<string, TaxTreatment>, fill: boolean): (TaxTreatment | undefined)[] {
  const out: (TaxTreatment | undefined)[] = new Array(lines.length).fill(undefined);
  const groups = new Map<string, number[]>();
  lines.forEach((l, i) => { const k = contentKey(l, 0); groups.set(k, [...(groups.get(k) ?? []), i]); });
  for (const idx of groups.values()) {
    const pool: TaxTreatment[] = [];
    for (let n = 0; n < MAX_LINES; n++) { const t = approved.get(contentKey(lines[idx[0]], n)); if (t) pool.push(t); }
    if (!pool.length) continue;
    for (const i of idx) {
      const l = lines[i];
      if (!nonStandard(l)) continue;
      const at = pool.findIndex((t) => num(t.taxRatePercent) === num(String(l.taxRatePercent)) && (l.taxCategory == null || (t.taxCategory === l.taxCategory && (t.exemptionReasonCode ?? null) === (l.exemptionReasonCode ?? null))));
      if (at >= 0) out[i] = pool.splice(at, 1)[0];
    }
    if (fill) for (const i of idx) { if (!pool.length) break; if (!nonStandard(lines[i])) out[i] = pool.shift(); }
  }
  return out;
}

/** The current lines of a draft with their keys and a label (the request form lists them; a request names one of them). */
export async function documentLines(db: Db, documentType: OverrideDoc, documentId: string): Promise<{ key: string; label: string; labelEn: string }[]> {
  if (documentType === "QUOTE") {
    const rows = await db.quoteLine.findMany({ where: { quoteId: documentId }, orderBy: [{ position: "asc" }, { id: "asc" }], select: { productSkuId: true, description: true, quantity: true, unitPrice: true, productSku: { select: { name: true, nameAr: true } } } });
    const keys = lineKeys(rows);
    return rows.map((l, i) => ({ key: keys[i], label: `${i + 1} · ${l.productSku?.nameAr || l.productSku?.name || l.description || ""}`, labelEn: `${i + 1} · ${l.productSku?.name || l.description || ""}` }));
  }
  const rows = await db.salesInvoiceLine.findMany({ where: { invoiceId: documentId }, orderBy: [{ position: "asc" }, { id: "asc" }], select: { productSkuId: true, description: true, descriptionEn: true, quantity: true, unitPrice: true } });
  const keys = lineKeys(rows);
  return rows.map((l, i) => ({ key: keys[i], label: `${i + 1} · ${l.description}`, labelEn: `${i + 1} · ${l.descriptionEn || l.description}` }));
}

const same = (a: TaxTreatment, b: TaxTreatment) =>
  a.taxCategory === b.taxCategory && num(a.taxRatePercent) === num(b.taxRatePercent) && (a.exemptionReasonCode ?? null) === (b.exemptionReasonCode ?? null);

/** The approved treatments of a draft, by line key (the latest approval of a key wins). */
export async function approvedTreatments(db: Db, documentType: OverrideDoc, documentId: string): Promise<Map<string, TaxTreatment>> {
  const rows = await db.taxOverrideRequest.findMany({ where: { documentType, documentId, status: "APPROVED" }, orderBy: { decidedAt: "asc" }, select: { lines: true } });
  const out = new Map<string, TaxTreatment>();
  for (const r of rows) for (const e of (r.lines as unknown as OverrideEntry[]) ?? []) out.set(e.key, { taxCategory: e.taxCategory, taxRatePercent: e.taxRatePercent, exemptionReasonCode: e.exemptionReasonCode ?? null });
  return out;
}

/**
 * Every line standard, or exactly the approved treatment of its key — else 400 TAX_LOCKED (C6: refused, never corrected).
 * A quotation line carries a rate only: its category is read from the approved entry (a non-standard rate with no approval
 * is refused). Returns nothing; throws on the first line not covered.
 */
export async function assertLinesTax(db: Db, documentType: OverrideDoc, documentId: string | null,
  lines: (KeyLine & { taxCategory?: string | null; taxRatePercent: Prisma.Decimal | string | number; exemptionReasonCode?: string | null })[]): Promise<void> {
  const nonStd = lines.map((l, i) => ({ l, i })).filter(({ l }) => !isStandard({ taxCategory: l.taxCategory ?? "S", taxRatePercent: String(l.taxRatePercent) }));
  if (!nonStd.length) return;
  const approved = documentId ? await approvedTreatments(db, documentType, documentId) : new Map<string, TaxTreatment>();
  const { taxLocked } = await import("./direct-sale-terms");
  const cover = coverLines(lines, approved, false);
  for (const { l, i } of nonStd) {
    const a = cover[i];
    const t: TaxTreatment = { taxCategory: (l.taxCategory ?? a?.taxCategory ?? "S") as TaxTreatment["taxCategory"], taxRatePercent: String(l.taxRatePercent), exemptionReasonCode: l.taxCategory ? l.exemptionReasonCode ?? null : a?.exemptionReasonCode ?? null };
    if (!a || !same(a, t)) throw taxLocked(i);
  }
}

async function draftOf(db: Db, documentType: OverrideDoc, documentId: string): Promise<{ status: string; ownerIds: (string | null)[] } | null> {
  if (documentType === "QUOTE") {
    const q = await db.quote.findUnique({ where: { id: documentId }, select: { status: true, createdById: true } });
    return q ? { status: String(q.status), ownerIds: [q.createdById] } : null;
  }
  const i = await db.salesInvoice.findUnique({ where: { id: documentId }, select: { status: true, createdById: true } });
  return i ? { status: String(i.status), ownerIds: [i.createdById] } : null;
}

/** «طلب تغيير المعاملة الضريبية» — by a holder of invoice_tax_override, on a DRAFT, for legitimate ZATCA treatments only. */
export async function requestTaxOverride(actor: Actor, input: { documentType: unknown; documentId: unknown; lines: unknown; reason: unknown }) {
  if (!mayOverrideTax(actor.permissions)) throw refuse(403, "FORBIDDEN", "طلب تغيير الضريبة لصاحب صلاحية «تغيير المعاملة الضريبية».", "Requesting a VAT change needs the tax-override permission.");
  const documentType = input.documentType === "QUOTE" || input.documentType === "INVOICE" ? input.documentType : null;
  const documentId = typeof input.documentId === "string" ? input.documentId : "";
  if (!documentType || !documentId) throw refuse(400, "BAD_INPUT", "المستند غير صحيح.", "Invalid document.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5) throw refuse(400, "REASON_REQUIRED", "اكتب سبب التغيير (5 أحرف على الأقل).", "Write the reason for the change (at least 5 characters).");
  if (reason.length > 1000) throw refuse(400, "REASON_TOO_LONG", "السبب أطول من 1000 حرف.", "The reason is longer than 1000 characters.");
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 200) throw refuse(400, "NO_LINES", "حدّد السطر والمعاملة الضريبية.", "Name the line and its VAT treatment.");
  const lines: OverrideEntry[] = input.lines.map((r0, i) => {
    const r = (r0 ?? {}) as Record<string, unknown>;
    const e: OverrideEntry = {
      key: typeof r.key === "string" ? r.key : "",
      taxCategory: (["S", "Z", "E", "O"].includes(String(r.taxCategory)) ? r.taxCategory : "") as TaxTreatment["taxCategory"],
      taxRatePercent: num(String(r.taxRatePercent ?? "")) ?? "",
      exemptionReasonCode: typeof r.exemptionReasonCode === "string" && r.exemptionReasonCode ? r.exemptionReasonCode : null,
    };
    if (!/^line:[0-9a-f]{32}$/.test(e.key)) throw refuse(400, "BAD_LINE", `السطر ${i + 1}: غير صحيح.`, `Line ${i + 1}: invalid.`);
    // Owner, C5: a correct statutory treatment, never an arbitrary rate — Z / E / O with their ZATCA reason code.
    if (isStandard(e) || !legitimateTreatment(e)) {
      throw refuse(400, "TREATMENT_INVALID", `السطر ${i + 1}: المعاملة غير نظامية — المسموح صفري (VATEX-SA-32/33/34/35) أو معفى (VATEX-SA-29/30) أو خارج النطاق (VATEX-SA-OOS) بنسبة 0، مع رمز السبب.`,
        `Line ${i + 1}: not a statutory treatment — zero-rated (VATEX-SA-32/33/34/35), exempt (VATEX-SA-29/30) or out of scope (VATEX-SA-OOS) at 0%, with the reason code.`);
    }
    return e;
  });
  return (await db0()).$transaction(async (tx) => {
    const doc = await draftOf(tx, documentType, documentId);
    if (!doc) throw refuse(404, "NOT_FOUND", "المستند غير موجود.", "Document not found.");
    // M1: a request names a line that is on the draft NOW (by its content key).
    const current = new Set((await documentLines(tx, documentType, documentId)).map((l) => l.key));
    if (lines.some((e) => !current.has(e.key))) throw refuse(409, "LINE_CHANGED", "البند تغيّر أو انحذف — حدّث الصفحة واختره من جديد.", "The line changed or was removed — refresh and pick it again.");
    if (doc.status !== "DRAFT") throw refuse(409, "NOT_DRAFT", "التغيير على المسودات فقط — المستند الصادر يُصحّح بإشعار دائن أو مدين.", "Only a draft is changed — an issued document is corrected by a credit or debit note.");
    const row = await tx.taxOverrideRequest.create({ data: { documentType, documentId, lines: lines as unknown as Prisma.InputJsonValue, reason, requestedById: actor.id }, select: { id: true, status: true } });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, { event: "sales.tax_override_pending", dedupeKey: row.id, actorId: actor.id, entity: { type: documentType === "QUOTE" ? "Quote" : "SalesInvoice", id: documentId }, facts: { documentType, reason } });
    await audit(tx, { action: "TAX_OVERRIDE_REQUESTED", entityType: documentType === "QUOTE" ? "Quote" : "SalesInvoice", entityId: documentId, actorId: actor.id, after: { requestId: row.id, lines, reason } });
    return { id: row.id, status: row.status };
  });
}

/** The independent decision: an approver who is not the requester; the document still a DRAFT. */
export async function decideTaxOverride(actor: Actor, id: string, input: { decision: unknown; note: unknown }) {
  if (!mayApproveTaxOverride(actor.permissions)) throw refuse(403, "FORBIDDEN", "الموافقة على تغيير الضريبة لصاحب صلاحية الموافقة.", "Deciding a VAT change needs the approval permission.");
  const decision = input.decision === "APPROVE" ? "APPROVED" : input.decision === "REJECT" ? "REJECTED" : null;
  if (!decision) throw refuse(400, "BAD_INPUT", "القرار غير صحيح.", "Invalid decision.");
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) : "";
  if (decision === "REJECTED" && note.length < 2) throw refuse(400, "REASON_REQUIRED", "اذكر سبب الرفض.", "Give the reason for refusing.");
  return (await db0()).$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "TaxOverrideRequest" WHERE "id" = ${id} FOR UPDATE`;
    const r = await tx.taxOverrideRequest.findUnique({ where: { id } });
    if (!r) throw refuse(404, "NOT_FOUND", "الطلب غير موجود.", "Request not found.");
    if (r.status !== "PENDING") throw refuse(409, "DECIDED", "تقرر الطلب مسبقًا.", "This request was already decided.");
    // Owner, C5: INDEPENDENT approval — never the requester (even in SIMPLE MODE: two people, or no change).
    if (r.requestedById === actor.id) throw refuse(403, "SELF_APPROVAL", "ما تقدر توافق على طلبك — يوافق عليه شخص ثاني.", "You cannot decide your own request — a second person decides it.");
    const doc = await draftOf(tx, r.documentType as OverrideDoc, r.documentId);
    if (!doc || doc.status !== "DRAFT") throw refuse(409, "NOT_DRAFT", "المستند ما عاد مسودة.", "The document is no longer a draft.");
    const at = new Date();
    await tx.taxOverrideRequest.update({ where: { id }, data: { status: decision, decidedById: actor.id, decidedAt: at, decisionNote: note || null } });
    if (decision === "APPROVED") await applyApproved(tx, r.documentType as OverrideDoc, r.documentId, actor.id);
    await audit(tx, { action: decision === "APPROVED" ? "TAX_OVERRIDE_APPROVED" : "TAX_OVERRIDE_REJECTED", entityType: r.documentType === "QUOTE" ? "Quote" : "SalesInvoice", entityId: r.documentId, actorId: actor.id, after: { requestId: id, lines: r.lines, reason: r.reason, note: note || null, requestedById: r.requestedById } });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, {
      event: "sales.tax_override_decided", dedupeKey: `${id}:${decision}`, actorId: actor.id, entity: { type: r.documentType === "QUOTE" ? "Quote" : "SalesInvoice", id: r.documentId },
      people: { requester: r.requestedById }, facts: { decision: decision === "APPROVED" ? "APPROVE" : "REJECT", note, documentType: r.documentType, documentId: r.documentId },
    });
    return { id, status: decision };
  });
}

/** The approved treatments onto the draft itself (inside the decision's transaction). */
async function applyApproved(tx: Tx, documentType: OverrideDoc, documentId: string, actorId: string) {
  const approved = await approvedTreatments(tx, documentType, documentId);
  if (documentType === "QUOTE") {
    const { saveQuoteLines } = await import("./quotes");
    const { Decimal } = await import("../commissions/engine");
    const lines = await tx.quoteLine.findMany({ where: { quoteId: documentId }, orderBy: [{ position: "asc" }, { id: "asc" }] });
    const cover = coverLines(lines, approved, true);
    await saveQuoteLines(tx, {
      quoteId: documentId, actorId,
      lines: lines.map((l, i) => ({
        productSkuId: l.productSkuId, description: l.description, quantity: new Decimal(l.quantity.toString()), unit: l.unit,
        unitPrice: new Decimal(l.unitPrice.toString()), discountPercent: new Decimal(l.discountPercent.toString()), position: l.position,
        taxRatePercent: new Decimal(cover[i]?.taxRatePercent ?? l.taxRatePercent.toString()),
      })),
    });
    return;
  }
  const { retaxDraftIn } = await import("@/lib/services/invoicing/service");
  await retaxDraftIn(tx, documentId, (ls) => coverLines(ls, approved, true));
}
