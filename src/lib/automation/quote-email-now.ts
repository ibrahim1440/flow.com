import "server-only";

/**
 * «أرسل الإيميل الحين» on an issued quotation (fix round 2, council b25 seat 5 N3): a quotation issued while the «صدر» rule's
 * e-mail was off — or whose e-mail failed — can be sent from the quotation page. The SAME path as the rule: the quote
 * «صدر» status rule's own plan (planStatusEmails: the customer, opt-out, suppression, TEST redirection), the same
 * dedupe key (so it can never be sent twice: a row already waiting or sent refuses), the same sender and idempotency
 * key (msg-<id>). A failed row is retried (actOnEmail: an archived one refuses); a skipped one is planned again.
 */
import type { Prisma } from "@/generated/prisma/client";
import { resolveEventContext } from "./context";
import { actOnEmail, currentEmailMode, suppressionLookup } from "./email-dispatch";
import { planStatusEmails } from "./status-rules/rules";

type Tx = Prisma.TransactionClient;
type AppError = { _appCode: number; message: string; errorEn: string; code: string };
const refuse = (status: number, code: string, message: string, errorEn: string): AppError => ({ _appCode: status, code, message, errorEn });

export type QuoteEmailNowResult = { outcome: "queued" | "retried"; planMode: "TEST" | "LIVE" };

export async function sendQuoteEmailNow(tx: Tx, quoteId: string, actor: { id: string; name: string }): Promise<QuoteEmailNowResult> {
  const quote = await tx.quote.findUnique({ where: { id: quoteId }, select: { id: true, status: true } });
  if (!quote) throw refuse(404, "NOT_FOUND", "العرض غير موجود.", "Quotation not found.");
  if (quote.status !== "ISSUED" && quote.status !== "ACCEPTED") {
    throw refuse(409, "QUOTE_NOT_CURRENT", "يُرسل العرض بالإيميل وهو صادر أو مقبول فقط.", "Only an issued or accepted quotation is e-mailed.");
  }
  const rule = await tx.whatsAppStatusRule.findFirst({ where: { source: "quote", statusKey: "ISSUED" } });
  if (!rule || !rule.active || !rule.emailEnabled) {
    throw refuse(409, "RULE_EMAIL_OFF", "«إيميل للعميل» مو مفعّل في رسالة «صدر». فعّله من «إشعارات الحالات» أول.", "The «Issued» message has no e-mail switched on.");
  }
  const mode = await currentEmailMode(tx);
  if (mode.mode === "OFF") {
    throw refuse(409, "EMAIL_OFF", "إرسال الإيميل متوقف من «إعدادات الإرسال».", "E-mail sending is off.");
  }
  const now = new Date();
  const ctx = await resolveEventContext(tx, {
    id: `manual:${quoteId}`, eventType: "sales.quote_status_changed", subjectType: "Quote", subjectId: quoteId,
    payload: { to: "ISSUED" }, actorId: actor.id, occurredAt: now,
  }, "ar");
  if (!ctx) throw refuse(409, "NO_CONTEXT", "ما قدرنا نجهّز رسالة هذا العرض.", "The quotation's message could not be prepared.");
  const customers = ctx.people.customer ?? [];
  const suppressed = await suppressionLookup(tx, customers.map((c) => c.email));
  const planned = planStatusEmails({
    // renotify off: one stable key per quotation and customer — the key the rule itself uses for its first message.
    rule: { source: rule.source, statusKey: rule.statusKey, labelAr: rule.labelAr, template: rule.template, emailSubject: rule.emailSubject, renotify: false },
    subject: { type: "Quote", id: quoteId }, vars: ctx.vars, customers, mode, suppressed,
  });
  const p = planned[0];
  if (!p) throw refuse(409, "NO_RECIPIENT", "ما للعرض عميل نرسل له.", "No customer to e-mail.");
  if (p.status !== "QUEUED") {
    throw refuse(409, "NOT_SENDABLE", `ما ينرسل: ${p.statusNote ?? "السبب غير معروف"}`, p.statusNote ?? "Not sendable.");
  }
  const existing = await tx.emailMessage.findUnique({ where: { dedupeKey: p.dedupeKey }, select: { id: true, status: true, bodyArchivedAt: true } });
  const fields = {
    ...p, ruleId: null, ruleName: `إشعار الحالة: ${rule.labelAr}`, eventType: "sales.quote_status_changed", subjectType: "Quote", subjectId: quoteId,
    scheduledAt: now, statusNote: `Sent by hand by ${actor.name}.`, createdById: actor.id,
  };
  if (!existing) {
    await tx.emailMessage.create({ data: fields });
    return { outcome: "queued", planMode: mode.mode };
  }
  if (existing.bodyArchivedAt) throw refuse(409, "ARCHIVED", "نص هذه الرسالة انتقل للأرشيف، فما تنعاد.", "The message was archived.");
  if (existing.status === "FAILED") {
    await actOnEmail(tx, existing.id, "retry", actor.name);
    return { outcome: "retried", planMode: mode.mode };
  }
  if (existing.status === "SKIPPED" || existing.status === "CANCELLED") {
    const { dedupeKey: _k, ...rest } = fields;
    void _k;
    const r = await tx.emailMessage.updateMany({ where: { id: existing.id, status: existing.status }, data: { ...rest, attempts: 0, nextAttemptAt: null, lockedAt: null } });
    if (r.count === 0) throw refuse(409, "CHANGED", "الرسالة تغيّرت. حدّث الصفحة وجرّب مرة ثانية.", "The message changed. Reload.");
    return { outcome: "queued", planMode: mode.mode };
  }
  throw refuse(409, "ALREADY_SENT", "إيميل هذا العرض انرسل أو ينتظر الإرسال من قبل — ما نرسله مرتين.", "This quotation's e-mail was already sent or is waiting.");
}
