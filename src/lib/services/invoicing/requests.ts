// «طلب فاتورة ضريبية» — the tax invoice request workflow (BATCH 22 WP-C; owner split 2026-10-29). Sales prepares a DRAFT
// and REQUESTS it; the accountant (sales › invoices_issue) corrects its compliance fields if needed (council Q-F3), sends
// it back with a reason, or ISSUES it (the existing issueDocument: the number, ICV and PIH are taken there only, Q-F5).
// There is no new status: a request is a DRAFT with requestedAt (20261126090000_invoice_requests); every step is a row
// of the append-only history and a notification, in the same transaction.
//
//   request   POST /api/sales/invoices/[id]/request   invoices_create (a note: invoices_credit_note) — the requester
//   withdraw  POST /api/sales/invoices/[id]/withdraw  the requester only
//   return    POST /api/sales/invoices/[id]/return    invoices_issue (a note: invoices_credit_note); reason code + ≥ 10 chars
//   queue     GET  /api/sales/invoices/requests        invoices_issue: oldest first, aged in Riyadh business days
//   «حفظ وإصدار»  POST /api/sales/invoices {issue: true, requestKey}  invoices_issue: create under the key, then issue
import { prisma, TX_OPTS } from "@/lib/db";
import { setAuditContext, type AuditContext } from "@/lib/accounting/audit";
import { assertSalesAllowed } from "@/lib/services/customers/credit-db";
import { notify } from "@/lib/notifications/notify";
import { createDraft, draftProblems, issueDocument, loadDocument, lockDocument, type DraftInput, type IssueResult } from "./service";
import { refuseInv } from "./refusals";
import { notifyRequested, notifyReturned, writeRequestEvent } from "./request-events";
import { RETURN_REASON_MIN, isReturnReason, queueAging, riyadhDayText } from "./request-math";
import { AccountingError } from "@/lib/accounting/errors";

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

/**
 * «إرسال الطلب للمحاسب»: the draft enters the issuer's queue. The draft's issue problems are returned as WARNINGS (the
 * accountant fixes the compliance ones or sends it back). A manual invoice (no order) checks the customer's credit now —
 * an order-based one passed the credit check when the order was placed.
 */
export async function requestInvoice(id: string, note: unknown, ctx: AuditContext, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const row = await lockDocument(tx, id);
    if (row.status !== "DRAFT") throw refuseInv("DRAFT_ONLY");
    const doc = (await loadDocument(tx, id))!;
    if (doc.requestedAt) throw refuseInv("ALREADY_REQUESTED");
    if (!doc.lines.length) throw refuseInv("LINES_INVALID", "(no lines)", "(لا بنود)");
    if (doc.kind === "INVOICE" && !doc.orderId) await assertSalesAllowed(tx, doc.customerId, now);
    const warnings = await draftProblems(tx, doc, now);
    const requestNote = clean(note, 1000) || null;
    await tx.salesInvoice.update({ where: { id }, data: { requestedAt: now, requestedById: ctx.actorId, requestNote } });
    await writeRequestEvent(tx, { invoiceId: id, kind: "REQUESTED", actorId: ctx.actorId, reason: requestNote });
    await notifyRequested(tx, doc, ctx.actorId, now);
    return { id, requestedAt: now.toISOString(), warnings };
  }, TX_OPTS);
}

/** «سحب الطلب»: the requester takes the draft back to edit it (it leaves the queue; nothing else changes). */
export async function withdrawRequest(id: string, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const row = await lockDocument(tx, id);
    if (row.status !== "DRAFT") throw refuseInv("DRAFT_ONLY");
    const doc = await tx.salesInvoice.findUniqueOrThrow({ where: { id }, select: { requestedAt: true, requestedById: true } });
    if (!doc.requestedAt) throw refuseInv("NOT_REQUESTED");
    if (doc.requestedById !== ctx.actorId) throw refuseInv("REQUEST_NOT_YOURS");
    await tx.salesInvoice.update({ where: { id }, data: { requestedAt: null } });
    await writeRequestEvent(tx, { invoiceId: id, kind: "WITHDRAWN", actorId: ctx.actorId });
    return { id, withdrawn: true };
  }, TX_OPTS);
}

/**
 * «إعادة إلى المبيعات» (Q-F3): a wrong commercial term goes back to Sales with a reason code and a reason of at least 10
 * characters — shown to Sales as a banner on the draft and kept in the history. The draft stays a draft.
 */
export async function returnRequest(id: string, input: { reasonCode: unknown; reason: unknown }, ctx: AuditContext, now: Date = new Date()) {
  const reason = clean(input.reason, 1000);
  if (!isReturnReason(input.reasonCode) || reason.length < RETURN_REASON_MIN) throw refuseInv("RETURN_REASON_REQUIRED");
  const code = input.reasonCode;
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason });
    const row = await lockDocument(tx, id);
    if (row.status !== "DRAFT") throw refuseInv("DRAFT_ONLY");
    const doc = (await loadDocument(tx, id))!;
    if (!doc.requestedAt || !doc.requestedById) throw refuseInv("NOT_REQUESTED");
    await tx.salesInvoice.update({ where: { id }, data: { requestedAt: null } });
    await writeRequestEvent(tx, { invoiceId: id, kind: "RETURNED", actorId: ctx.actorId, reasonCode: code, reason });
    await notifyReturned(tx, doc, doc.requestedById, ctx.actorId, code, reason, now);
    return { id, returned: true };
  }, TX_OPTS);
}

/** The request history of a document, oldest first (the drawer and the return banner). */
export async function requestHistory(invoiceId: string) {
  const rows = await prisma.salesInvoiceRequestEvent.findMany({ where: { invoiceId }, orderBy: [{ at: "asc" }, { id: "asc" }] });
  const people = await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId))] } }, select: { id: true, name: true } });
  return rows.map((r) => ({ id: r.id, kind: r.kind, actorId: r.actorId, actorName: people.find((p) => p.id === r.actorId)?.name ?? null, reasonCode: r.reasonCode, reason: r.reason, diff: r.diff, at: r.at.toISOString() }));
}

/**
 * «طلبات الفواتير»: every requested draft, oldest first, with its age in Riyadh business days, the legal limit (the 15th
 * of the month after the supply) and the colour (amber > 1 business day, red > 2 or within 5 days of the limit).
 */
export async function requestQueue(opts: { customerIds?: string[] | null; now?: Date; take?: number } = {}) {
  const now = opts.now ?? new Date();
  const rows = await prisma.salesInvoice.findMany({
    where: { status: "DRAFT", requestedAt: { not: null }, ...(opts.customerIds ? { customerId: { in: opts.customerIds } } : {}) },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }], take: Math.min(Math.max(opts.take ?? 200, 1), 500),
    select: { id: true, kind: true, family: true, customerId: true, orderId: true, buyer: true, grandTotal: true, taxTotal: true, supplyDate: true, requestedAt: true, requestedById: true, requestNote: true, createdById: true, source: true },
  });
  const [orders, people] = await Promise.all([
    prisma.order.findMany({ where: { id: { in: rows.map((r) => r.orderId).filter((x): x is string => !!x) } }, select: { id: true, orderNumber: true } }),
    prisma.employee.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, r.createdById]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
  ]);
  const name = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  return rows.map((r) => {
    const aging = queueAging(r.requestedAt!, r.supplyDate ? r.supplyDate.toISOString().slice(0, 10) : null, now);
    return {
      id: r.id, kind: r.kind, family: r.family, customerId: r.customerId, customerName: (r.buyer as { name?: string } | null)?.name ?? "",
      orderId: r.orderId, orderNumber: orders.find((o) => o.id === r.orderId)?.orderNumber ?? null, source: r.source,
      createdById: r.createdById, createdByName: name(r.createdById), requestedById: r.requestedById, requestedByName: name(r.requestedById), requestNote: r.requestNote,
      grandTotal: r.grandTotal.toFixed(2), taxTotal: r.taxTotal.toFixed(2), supplyDate: r.supplyDate ? r.supplyDate.toISOString().slice(0, 10) : null,
      requestedAt: r.requestedAt!.toISOString(), ...aging,
    };
  });
}

export async function requestQueueCount(): Promise<number> {
  return prisma.salesInvoice.count({ where: { status: "DRAFT", requestedAt: { not: null } } });
}

/**
 * The daily digest «finance.invoice_queue_overdue» (run by the existing daily notification job): the requests past two
 * business days or within five days of the legal limit. Once per day (the dedupe key is the Riyadh day).
 */
export async function invoiceQueueDigest(now: Date = new Date()) {
  const q = await requestQueue({ now, take: 500 });
  const late = q.filter((r) => r.tone === "red");
  if (!late.length) return { overdue: 0, notified: 0 };
  const pastLimit = late.filter((r) => r.daysToDeadline <= 5).length;
  const r = await notify(prisma, {
    event: "finance.invoice_queue_overdue", dedupeKey: riyadhDayText(now),
    facts: { count: late.length, pastLimit, oldestDays: Math.max(...late.map((x) => x.ageBusinessDays)) },
  });
  return { overdue: late.length, notified: r.inserted };
}

export type SaveAndIssueResult =
  | { state: "ISSUED"; id: string; replayed: boolean; issue: IssueResult }
  | { state: "NOT_READY"; id: string; replayed: boolean; problems: unknown };

/**
 * «حفظ وإصدار» (the council's one-click ruling): for an issuer only (the route checks invoices_issue + step-up). One
 * request, two transactions: the draft is created under its request key, then issued. When the issue refuses
 * (NOT_READY) the draft is KEPT and the problems are returned — the screen opens the draft with them listed. A replay of
 * the same key returns the same invoice (issued: the issue's own replay; still a draft: issued now).
 */
export async function saveAndIssue(input: DraftInput & { requestKey: string }, ctx: AuditContext, now: Date = new Date()): Promise<SaveAndIssueResult> {
  if (!input.requestKey) throw refuseInv("REQUEST_KEY_REQUIRED");
  const draft = await createDraft(input, ctx);
  try {
    const issue = await issueDocument(draft.id, ctx, now);
    return { state: "ISSUED", id: draft.id, replayed: draft.replayed || issue.replayed, issue };
  } catch (e) {
    if (e instanceof AccountingError && e.code === "NOT_READY") {
      return { state: "NOT_READY", id: draft.id, replayed: draft.replayed, problems: (e as AccountingError & { extra?: { problems?: unknown } }).extra?.problems ?? [] };
    }
    throw e;
  }
}

