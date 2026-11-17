// R1-e (owner decision, 17 Nov 06:10): an automation message is resent after «لم تصل» ONLY inside its type's hard window
// AND while what it says is still true. Both are proven from the database at execution, in the resend's own locked
// transaction (message-review.ts); anything that cannot be proven is refused (409 with a reason code) with a pointer to
// the original path. The review and the history stay available either way.
//
// The window starts at the ROOT original's FIRST send attempt (gate M1: a resend of a resend never restarts it — the
// resendOfMessageId chain is followed back to the first message): sendingStartedAt; for a row from before that column,
// the earliest attempt on record (WhatsAppSendAttempt / EmailSendAttempt). Neither → not provable → refused. A review or
// a retry never restarts it. The plain retry of a FAILED row (gate H1: rule-service / email-dispatch) goes through the
// same verdict; a row that never reached the provider (no attempt at all) is measured from its creation instead.
//
//   type (eventType)                                  window                 still true when
//   order.created / order.status_changed / …progress  24 h                   no newer status event for the order
//   delivery.recorded                                 72 h                   the delivery exists; its order's status unchanged
//   production.* / qc.batch_finalized / packaging.*   12 h                   no newer event for the batch / production order
//   qc.guest_invited                                  until the invite ends  the invite PENDING, the batch still open, AND the
//                                                                            link in the message still the batch's live guest
//                                                                            token (RoastingBatch.qcToken — the guest page's own
//                                                                            check); no link to compare → unprovable
//   sales.quote_status_changed (quotation e-mail)     until validUntil       the same quotation still ISSUED / ACCEPTED, no newer status
//   sales.deal_stage_changed                          24 h                   no newer stage change for the deal
//   sales.task_due                                    6 h                    the task not completed
//   sales.invoice_status_changed                      7 days                 no newer status event, the invoice unchanged since
//   Qoyod copy (attachmentKind qoyod_pdf)             7 days                 the same copy version, its PDF, the invoice issued
//   sales.collection_status_changed                   7 days                 no newer status, no new collection for the customer
//   finance.approval_requested                        until decided          the request still PENDING
//   finance.approval_decided                          7 days                 no newer decision event for the request
//   test (recipientKind test)                         none (test number)     —
//   anything else                                     —                      not provable → refused
import type { Prisma } from "@/generated/prisma/client";
import { qoyodAttachmentFor } from "@/lib/services/invoicing/qoyod-attachment";
import { rootMessageId } from "./resend-root";

type Db = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "whatsAppMessage" | "emailMessage" | "automationEvent" | "whatsAppSendAttempt" | "emailSendAttempt" | "qcInvite" | "roastingBatch" | "quote" | "activity" | "salesInvoice" | "salesInvoiceQoyod" | "salesCollection" | "finApprovalRequest" | "delivery">;
export type ResendOriginal = {
  id: string; channel: "whatsapp" | "email"; dedupeKey: string; eventId: string | null; eventType: string | null;
  subjectType: string | null; subjectId: string | null; recipientKind: string; attachmentKind: string | null; attachmentRefId: string | null;
  sendingStartedAt: Date | null; createdAt: Date; resendOfMessageId?: string | null;
};
/** retry: the plain retry of a FAILED row — one that never reached the provider is measured from its creation. */
export type VerdictOpts = { retry?: boolean };
export type ResendVerdict =
  | { ok: true; from: Date | null; until: Date | null }
  | { ok: false; code: string; ar: string; en: string; href: string | null; from: Date | null; until: Date | null };

const H = 3_600_000;
const D = 24 * H;
const riyadh = (d: Date) => new Intl.DateTimeFormat("ar-SA-u-nu-latn", { timeZone: "Asia/Riyadh", dateStyle: "short", timeStyle: "short" }).format(d);

/** Where a person issues an up-to-date message instead (the original path). */
export function originalPath(subjectType: string | null, subjectId: string | null): string | null {
  if (!subjectId) return null;
  switch (subjectType) {
    case "Order": return `/dashboard/orders?order=${encodeURIComponent(subjectId)}`;
    case "Quote": return `/dashboard/sales/quotes/${encodeURIComponent(subjectId)}`;
    case "SalesInvoice": return `/dashboard/sales/invoices/${encodeURIComponent(subjectId)}`;
    case "Opportunity": return `/dashboard/sales/deals/${encodeURIComponent(subjectId)}`;
    case "SalesCollection": return "/dashboard/sales/collections";
    case "Employee": return `/dashboard/employees/${encodeURIComponent(subjectId)}`;
    default: return null;
  }
}

/** The window start: the ROOT original's first send attempt, as recorded. null = not provable. */
export async function windowStart(db: Db, o: ResendOriginal, opts: VerdictOpts = {}): Promise<Date | null> {
  let root: { id: string; sendingStartedAt: Date | null; createdAt: Date } = o;
  if (o.resendOfMessageId) {
    const id = await rootMessageId(db, o.channel === "email" ? "EmailMessage" : "WhatsAppMessage", o.id);
    const r = id && id !== o.id
      ? o.channel === "email"
        ? await db.emailMessage.findUnique({ where: { id }, select: { id: true, sendingStartedAt: true, createdAt: true } })
        : await db.whatsAppMessage.findUnique({ where: { id }, select: { id: true, sendingStartedAt: true, createdAt: true } })
      : null;
    if (!r) return null; // a broken chain is not provable
    root = r;
  }
  if (root.sendingStartedAt) return root.sendingStartedAt;
  const first = o.channel === "email"
    ? await db.emailSendAttempt.findFirst({ where: { messageId: root.id }, orderBy: { createdAt: "asc" }, select: { createdAt: true } })
    : await db.whatsAppSendAttempt.findFirst({ where: { messageId: root.id }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  if (first) return first.createdAt;
  // Never sent at all (no claim, no attempt): a retry cannot duplicate it, but it is still bound to its type's window —
  // counted from the message's creation (earlier than any attempt could be).
  return opts.retry && !o.resendOfMessageId ? root.createdAt : null;
}

/** When the original's event happened (newer events are compared to it). */
async function eventTime(db: Db, o: ResendOriginal): Promise<Date> {
  if (o.eventId) {
    const e = await db.automationEvent.findUnique({ where: { id: o.eventId }, select: { occurredAt: true } });
    if (e) return e.occurredAt;
  }
  return o.createdAt;
}
async function newerEvent(db: Db, subjectType: string, subjectId: string, types: string[] | null, after: Date): Promise<boolean> {
  const e = await db.automationEvent.findFirst({
    where: { subjectType, subjectId, occurredAt: { gt: after }, ...(types ? { eventType: { in: types } } : {}) },
    select: { id: true },
  });
  return !!e;
}

const ORDER_STATUS = ["order.created", "order.status_changed", "order.progress_changed"];
const OPS = ["production.batch_roasted", "production.order_created", "qc.batch_finalized", "packaging.completed"];

/** May this original be resent NOW? (window + content validity) — read-only; the caller holds the row lock. */
export async function automationResendVerdict(db: Db, o: ResendOriginal, now = new Date(), opts: VerdictOpts = {}): Promise<ResendVerdict> {
  const href = originalPath(o.subjectType, o.subjectId);
  const no = (code: string, ar: string, en: string, from: Date | null = null, until: Date | null = null): ResendVerdict => ({ ok: false, code, ar, en, href, from, until });
  if (o.recipientKind === "test") return { ok: true, from: null, until: null };

  // The hard window of the type.
  const type = o.attachmentKind === "qoyod_pdf" ? "qoyod" : o.eventType ?? "";
  const span =
    ORDER_STATUS.includes(type) ? 24 * H
    : type === "delivery.recorded" ? 72 * H
    : OPS.includes(type) ? 12 * H
    : type === "sales.deal_stage_changed" ? 24 * H
    : type === "sales.task_due" ? 6 * H
    : type === "sales.invoice_status_changed" || type === "qoyod" || type === "sales.collection_status_changed" || type === "finance.approval_decided" ? 7 * D
    : type === "qc.guest_invited" || type === "sales.quote_status_changed" || type === "finance.approval_requested" ? null // until the record says
    : undefined;
  if (span === undefined || !o.subjectId) {
    return no("RESEND_UNPROVABLE", "لا نستطيع إثبات أن هذه الرسالة ما زالت صحيحة، فلا تُعاد من السجل. أرسل رسالة محدّثة من مكانها الأصلي.",
      "We cannot prove this message is still correct, so it is not resent from the log. Send an up-to-date one from its original place.");
  }
  const from = await windowStart(db, o, opts);
  if (!from) {
    return no("WINDOW_UNPROVABLE", "لا يوجد سجل لأول محاولة إرسال لهذه الرسالة، فلا نستطيع إثبات أنها داخل مهلة الإعادة. أرسل رسالة محدّثة من مكانها الأصلي.",
      "There is no record of this message's first send attempt, so its resend window cannot be proven. Send an up-to-date one from its original place.");
  }
  let until = span === null ? null : new Date(from.getTime() + span);
  const tooLate = (u: Date) => no("RESEND_TOO_LATE",
    `انتهت مهلة الإعادة: انتهت صلاحية هذه الرسالة (${riyadh(u)})، فلا تُعاد. أرسل رسالة محدّثة من مكانها الأصلي.`,
    `The resend window has closed (${u.toISOString()}); the message is not resent. Send an up-to-date one from its original place.`, from, u);
  if (until && now.getTime() >= until.getTime()) return tooLate(until);

  const at = await eventTime(db, o);
  const changed = (ar: string, en: string) => no("CONTENT_CHANGED", ar, en, from, until);
  const sid = o.subjectId;

  if (ORDER_STATUS.includes(type)) {
    if (await newerEvent(db, "Order", sid, ORDER_STATUS, at)) return changed("تغيّرت حالة الطلب بعد هذه الرسالة، فما عادت صحيحة. الحالة الجديدة تصل برسالتها.", "The order's status changed after this message; it is no longer correct.");
  } else if (type === "delivery.recorded") {
    const d = await db.delivery.findUnique({ where: { id: sid }, select: { orderItem: { select: { orderId: true } } } });
    if (!d) return changed("ما عاد هذا التسليم موجوداً، فما تُعاد رسالته.", "This delivery no longer exists.");
    if (await newerEvent(db, "Order", d.orderItem.orderId, ORDER_STATUS, at)) return changed("تغيّرت حالة الطلب بعد هذا التسليم، فما عادت الرسالة صحيحة.", "The order's status changed after this delivery.");
  } else if (OPS.includes(type)) {
    if (await newerEvent(db, o.subjectType ?? "", sid, null, at)) return changed("تغيّرت حالة الدفعة بعد هذه الرسالة، فما عادت لازمة.", "The batch's status changed after this message.");
  } else if (type === "qc.guest_invited") {
    // Owner (release condition, 17 Nov): «معلّقة» alone does not prove the link still works. The guest page accepts a link
    // only while its token is the batch's qcToken (cleared by the QC decision) and the batch is «Pending QC» — the same
    // two facts are proven here from the link inside the message. Anything not provable → refused; a new invitation is
    // issued from the QC page.
    const QC = "/dashboard/qc";
    const qcNo = (code: string, ar: string, en: string): ResendVerdict => ({ ok: false, code, ar, en, href: QC, from, until });
    const unprovable = () => qcNo("RESEND_UNPROVABLE",
      "لا نستطيع إثبات أن رابط هذه الدعوة ما زال صالحاً، فلا تُعاد من السجل. أصدر دعوة جديدة من صفحة الجودة.",
      "We cannot prove this invitation's link still works, so it is not resent from the log. Issue a new invitation from the QC page.");
    const inviteId = o.dedupeKey.startsWith("qc-invite:") ? o.dedupeKey.slice("qc-invite:".length) : null;
    const inv = inviteId ? await db.qcInvite.findUnique({ where: { id: inviteId }, select: { status: true, batchId: true } }) : null;
    if (!inv) return unprovable();
    if (inv.status !== "PENDING") return qcNo("CONTENT_CHANGED", "أُلغيت الدعوة أو استُخدمت، فما تُعاد. أصدر دعوة جديدة من صفحة الجودة إن لزم.", "The invitation was cancelled or used.");
    const row = o.channel === "whatsapp" ? await db.whatsAppMessage.findUnique({ where: { id: o.id }, select: { body: true, bodyArchivedAt: true } }) : null;
    const link = row && !row.bodyArchivedAt ? /\/guest-qc\/([^/\s]+)\/([A-Za-z0-9]+)/.exec(row.body ?? "") : null;
    if (!link || link[1] !== inv.batchId) return unprovable();
    const batch = await db.roastingBatch.findUnique({ where: { id: inv.batchId }, select: { status: true, qcToken: true } });
    if (!batch?.qcToken || batch.qcToken !== link[2]) return qcNo("CONTENT_CHANGED", "انتهت صلاحية رابط هذه الدعوة، فما تُعاد. أصدر دعوة جديدة من صفحة الجودة.", "This invitation's link no longer works. Issue a new invitation from the QC page.");
    if (batch.status !== "Pending QC") return qcNo("CONTENT_CHANGED", "انتهت صلاحية الدعوة: الدفعة ما عادت مفتوحة للتقييم.", "The invitation expired: the batch is no longer open for QC.");
  } else if (type === "sales.quote_status_changed") {
    const q = await db.quote.findUnique({ where: { id: sid }, select: { status: true, validUntil: true } });
    if (!q?.validUntil) return changed("لا نستطيع إثبات صلاحية عرض السعر.", "The quotation's validity cannot be proven.");
    until = q.validUntil;
    if (now.getTime() >= q.validUntil.getTime()) return tooLate(q.validUntil);
    if (q.status !== "ISSUED" && q.status !== "ACCEPTED") return changed("تغيّرت حالة عرض السعر، فما عاد هذا الإيميل صالحاً. أرسل النسخة الحالية من صفحة العرض.", "The quotation's status changed; send the current version from its page.");
    if (await newerEvent(db, "Quote", sid, ["sales.quote_status_changed"], at)) return changed("صدرت نسخة أحدث من عرض السعر بعد هذه الرسالة.", "A newer version of the quotation was issued after this message.");
  } else if (type === "sales.deal_stage_changed") {
    if (await newerEvent(db, "Opportunity", sid, ["sales.deal_stage_changed"], at)) return changed("انتقلت الصفقة لمرحلة أحدث بعد هذه الرسالة.", "The deal moved to a newer stage after this message.");
  } else if (type === "sales.task_due") {
    const t = await db.activity.findUnique({ where: { id: sid }, select: { completedAt: true } });
    if (!t) return changed("ما عادت المهمة موجودة.", "The task no longer exists.");
    if (t.completedAt) return changed("اكتملت المهمة، فما يُعاد تذكيرها.", "The task is completed.");
  } else if (type === "sales.invoice_status_changed") {
    // Orchestrator (gate on be2f425a): like the invoice copy — 7 days, refused after a newer status OR any change to the
    // invoice itself since the event (updatedAt).
    if (await newerEvent(db, "SalesInvoice", sid, ["sales.invoice_status_changed"], at)) return changed("تغيّرت حالة الفاتورة بعد هذه الرسالة.", "The invoice's status changed after this message.");
    const inv = await db.salesInvoice.findUnique({ where: { id: sid }, select: { updatedAt: true } });
    if (!inv) return changed("ما عادت الفاتورة موجودة.", "The invoice no longer exists.");
    if (inv.updatedAt.getTime() > at.getTime()) return changed("تعدّلت الفاتورة بعد هذه الرسالة، فما عادت صحيحة. أرسل النسخة الحالية من صفحة الفاتورة.", "The invoice changed after this message; send the current one from the invoice page.");
  } else if (type === "qoyod") {
    const m = /^(?:email:)?qoyod:[^:]+:v(\d+):/.exec(o.dedupeKey);
    const copy = o.attachmentRefId ? await db.salesInvoiceQoyod.findUnique({ where: { id: o.attachmentRefId }, select: { version: true } }) : null;
    if (!m || !copy || copy.version !== Number(m[1])) return changed("تغيّرت نسخة «فاتورة قيود» بعد هذه الرسالة، فما تُعاد. أرسل النسخة الحالية من صفحة الفاتورة.", "The Qoyod copy changed after this message; send the current one from the invoice page.");
    if (!(await qoyodAttachmentFor(o.attachmentRefId, o.subjectType, o.subjectId))) return changed("ملف «فاتورة قيود» ما عاد نفسه أو ما عادت الفاتورة مُصدرة، فما تُعاد. أرسلها من صفحة الفاتورة.", "The Qoyod PDF is no longer the same or the invoice is no longer issued.");
  } else if (type === "sales.collection_status_changed") {
    const c = await db.salesCollection.findUnique({ where: { id: sid }, select: { customerId: true } });
    if (!c) return changed("ما عاد التحصيل موجوداً.", "The collection no longer exists.");
    if (await newerEvent(db, "SalesCollection", sid, ["sales.collection_status_changed"], at)) return changed("تغيّرت حالة التحصيل بعد هذه الرسالة. أصدر إشعاراً محدّثاً من صفحة التحصيل.", "The collection's status changed; issue an up-to-date notice from the collections page.");
    if (c.customerId && (await db.salesCollection.findFirst({ where: { customerId: c.customerId, createdAt: { gt: at }, id: { not: sid } }, select: { id: true } }))) {
      return changed("سُجّل تحصيل جديد للعميل بعد هذه الرسالة فتغيّر رصيده. أصدر إشعاراً محدّثاً من صفحة التحصيل.", "A new collection was recorded for the customer; issue an up-to-date notice.");
    }
  } else if (type === "finance.approval_requested") {
    const f = await db.finApprovalRequest.findUnique({ where: { id: sid }, select: { status: true } });
    if (f?.status !== "PENDING") return changed("حُسم طلب الاعتماد أو أُلغي، فما يُعاد طلبه.", "The approval request was decided or cancelled.");
  } else if (type === "finance.approval_decided") {
    if (await newerEvent(db, "FinApprovalRequest", sid, ["finance.approval_decided"], at)) return changed("صدر قرار أحدث على هذا الطلب.", "A newer decision was made on this request.");
  }
  return { ok: true, from, until };
}

/** The columns the gate needs from a message row (both channels). */
export const RETRY_GATE_SELECT = {
  id: true, dedupeKey: true, eventId: true, eventType: true, subjectType: true, subjectId: true, recipientKind: true,
  attachmentKind: true, attachmentRefId: true, sendingStartedAt: true, createdAt: true, resendOfMessageId: true,
  deliveryDoubt: true, reviewOutcome: true,
} as const;

/**
 * Gate H1 + M2 (orchestrator, on be2f425a): the ONE gate for a person putting an existing FAILED row back in the queue
 * («إعادة المحاولة» on the log, «أرسل الإيميل الحين» on a quotation). Throws a 409 the routes pass through (code, both
 * languages, the original path):
 *   · a row that may have been delivered (deliveryDoubt) is never re-queued — owner: «قد تكون وصلت» is not resent before
 *     «لم تصل», and then only as a NEW message by the resend path (message-review.ts), WhatsApp and e-mail alike;
 *   · otherwise its type's window (from the root's first attempt) and its content must still hold — the resend verdict.
 */
export async function retryGate(db: Db, channel: "whatsapp" | "email", row: Omit<ResendOriginal, "channel"> & { deliveryDoubt: boolean; reviewOutcome: string | null }, now = new Date()): Promise<void> {
  if (row.deliveryDoubt) {
    const reviewedNotDelivered = row.reviewOutcome === "NOT_DELIVERED";
    throw {
      _appCode: 409, code: "REVIEW_REQUIRED",
      message: reviewedNotDelivered
        ? "سُجّلت «لم تصل» لهذه الرسالة — أعدها بـ«إعادة الإرسال بعد المراجعة»، لا بإعادة المحاولة."
        : row.reviewOutcome
          ? "سُجّلت نتيجة التحقق لهذه الرسالة، فما تُعاد."
          : "انقطع إرسال هذه الرسالة وقد تكون وصلت للعميل، فما تُعاد. سجّل نتيجة التحقق أولاً، ولا تُعِدها إلا إذا تأكدت أنها «لم تصل».",
      errorEn: reviewedNotDelivered
        ? "This message was reviewed «not delivered» — use «resend after review», not retry."
        : row.reviewOutcome
          ? "This message was reviewed; it is not sent again."
          : "This message's send was interrupted and it may already have been delivered, so it is not sent again. Record the review first; resend only if you are sure it was not delivered.",
    };
  }
  const v = await automationResendVerdict(db, { ...row, channel }, now, { retry: true });
  if (!v.ok) throw { _appCode: 409, code: v.code, message: v.ar, errorEn: v.en, ...(v.href ? { href: v.href } : {}) };
}
