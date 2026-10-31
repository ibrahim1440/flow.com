import "server-only";

/**
 * The e-mail channel's database half (batch 25): planning rows for an event, and the sender loop.
 *
 * The sender is its own loop, called by runAutomationDispatch next to the WhatsApp sender: it never waits on, or
 * stops for, the WhatsApp connection. Same queue discipline as WhatsApp — rows claimed with FOR UPDATE SKIP LOCKED,
 * a unique dedupe key per message (namespaced "email:"), a message in flight when its process died is failed (never
 * re-sent blindly), a message more than a day late is expired.
 *
 * At send time everything that decides where an e-mail goes or what it carries is read AGAIN: the e-mail mode (TEST →
 * the test address only), the customer's «يستقبل إيميلات», the suppression list, the invoice lock, and — for the
 * quotation PDF — that the quotation is still issued and belongs to the message's customer. Then finalEmailGuard
 * looks at the exact message handed to the provider.
 */
import { AUTOMATION_TAG } from "@/lib/notify/resend-webhook";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { deliverEmail, emailConfigured } from "@/lib/notify/email";
import { recipientFor } from "@/lib/notify/recipients";
import { companyInfoFrom } from "@/lib/notify/templates/demo";
import type { CompanyInfo } from "@/lib/notify/templates/types";
import { sellerSnapshot } from "@/lib/services/invoicing/settings";
import { appBaseUrl, newEmailLinkId, unsubscribeToken } from "./email-links";
import { EMAIL_NOTES, effectiveEmailMode, emailSendTarget, finalEmailGuard, type EffectiveEmailMode } from "./email-mode";
import { quoteEmailInput, renderQuoteEmail, renderTextEmail, wrapHtml, wrapSubject, wrapText } from "./email-render";
import { SETTINGS_ID } from "./settings";
import type { SendMode } from "./send-mode";
import { getEvent } from "./catalog";

type Db = Prisma.TransactionClient | typeof prisma;

const BACKOFF_MINUTES = [1, 5, 15, 60];
export const MAX_EMAIL_ATTEMPTS = 5;
/** Resend's default limit is about 2 requests a second: one every 600 ms, and a handful per run. */
const PAUSE_BETWEEN_EMAILS_MS = 600;
const STALE_MS = 24 * 60 * 60 * 1000;
const STUCK_SEND_MS = 5 * 60 * 1000;

export type EmailSettings = { emailSendMode: SendMode; testEmail: string | null; testEmailVerifiedAt: Date | null };

export async function readEmailSettings(db: Db = prisma): Promise<EmailSettings> {
  const row = await db.automationSettings.findUnique({ where: { id: SETTINGS_ID }, select: { emailSendMode: true, testEmail: true, testEmailVerifiedAt: true } });
  return { emailSendMode: (row?.emailSendMode ?? "OFF") as SendMode, testEmail: row?.testEmail ?? null, testEmailVerifiedAt: row?.testEmailVerifiedAt ?? null };
}

export async function currentEmailMode(db: Db = prisma): Promise<EffectiveEmailMode> {
  return effectiveEmailMode(await readEmailSettings(db));
}

/** The suppressed addresses among these (lower-case), as a lookup the pure planners take. */
export async function suppressionLookup(db: Db, emails: (string | null | undefined)[]): Promise<(email: string) => boolean> {
  const list = [...new Set(emails.filter((e): e is string => !!e).map((e) => e.trim().toLowerCase()))];
  if (list.length === 0) return () => false;
  const rows = await db.emailSuppression.findMany({ where: { email: { in: list } }, select: { email: true } });
  const set = new Set(rows.map((r) => r.email));
  return (e) => set.has(e.toLowerCase());
}

/** A message in flight when its process died: failed, with that said; only a person retries it. */
export async function recoverInterruptedEmails() {
  await prisma.emailMessage.updateMany({
    where: { status: "SENDING", lockedAt: { lt: new Date(Date.now() - STUCK_SEND_MS) } },
    data: { status: "FAILED", lockedAt: null, statusNote: EMAIL_NOTES.interrupted },
  });
}

export type EmailSendReport = { emailsSent: number; emailFailures: number; emailPaused: string | null };

type Claimed = {
  eventType: string | null; recipientKind: string;
  id: string; toEmail: string | null; intendedEmail: string | null; subject: string; bodyText: string; attempts: number; statusNote: string | null;
  customerId: string | null; subjectType: string | null; subjectId: string | null; attachmentKind: string | null; attachmentRefId: string | null;
  scheduledAt: Date; bodyArchivedAt: Date | null;
};

type Content = { subject: string; html: string; text: string; attachments?: { filename: string; contentBase64: string; contentType: string }[]; sha256: string | null };

async function companyInfo(): Promise<CompanyInfo> {
  return companyInfoFrom(await sellerSnapshot(prisma));
}

/**
 * The reply address (fix round 1): the account owner's company e-mail, else the company «بريد الردود» (AutomationSettings.
 * replyToEmail), else none — and then the e-mail never promises «يكفي الرد على هذه الرسالة». Never the customer's data.
 */
export async function replyToFor(customerId: string | null, companyReplyTo: string | null, subject: { type: string | null; id: string | null } = { type: null, id: null }): Promise<string | undefined> {
  // Owner decision (31 Oct 2026, batch 25b): replies go to the rep who handles the customer — for a quotation the deal's
  // owner, otherwise the customer's account owner — at their work e-mail. «بريد الردود» only when that rep has none.
  const repOf = async (): Promise<string | null> => {
    if (subject.type === "Quote" && subject.id) {
      const q = await prisma.quote.findUnique({ where: { id: subject.id }, select: { opportunity: { select: { ownerId: true } } } });
      if (q?.opportunity.ownerId) return q.opportunity.ownerId;
    }
    if (!customerId) return null;
    return (await prisma.customer.findUnique({ where: { id: customerId }, select: { accountOwnerId: true } }))?.accountOwnerId ?? null;
  };
  const rep = await repOf();
  if (rep) {
    const r = await recipientFor(prisma, { accountId: rep }, "system");
    if (r.email) return r.email;
  }
  return companyReplyTo ?? undefined;
}

/** The customer's opaque link id for the unsubscribe link, made on first use (never the customer id). */
async function linkIdOf(customerId: string): Promise<string | null> {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { emailLinkId: true } });
  if (!c) return null;
  if (c.emailLinkId) return c.emailLinkId;
  const id = newEmailLinkId();
  const r = await prisma.customer.updateMany({ where: { id: customerId, emailLinkId: null }, data: { emailLinkId: id } });
  if (r.count === 1) return id;
  return (await prisma.customer.findUnique({ where: { id: customerId }, select: { emailLinkId: true } }))?.emailLinkId ?? null;
}

/** What the log keeps of the text part: never a signed link anyone with the log could use. */
const LINK_IN_TEXT = /https?:\/\/\S+\/(?:email\/unsubscribe|email\/confirm|api\/email\/unsubscribe)\?t=\S+/g;
export const loggableText = (text: string) => text.replace(LINK_IN_TEXT, "[الرابط الموقّع — لا يُحفظ في السجل]");

/** Why this message may not go now, decided with the facts of this moment; null when it may. */
async function sendTimeRefusal(msg: Claimed, mode: Exclude<EffectiveEmailMode, { mode: "OFF" }>, toEmail: string): Promise<{ status: "SKIPPED" | "FAILED"; note: string } | null> {
  // Transactional only (phase 1, PDPL): an automated e-mail must come from a system event of the catalogue (an order,
  // a quotation, a payment…). Nothing else — no campaign, no bulk send — goes out through this sender.
  if (!msg.eventType || !getEvent(msg.eventType)) return { status: "FAILED", note: EMAIL_NOTES.notTransactional };
  if (msg.subjectType === "SalesInvoice") {
    const inv = msg.subjectId ? await prisma.salesInvoice.findUnique({ where: { id: msg.subjectId }, select: { zatcaStatus: true } }) : null;
    if (!inv || !["CLEARED", "REPORTED"].includes(inv.zatcaStatus ?? "")) return { status: "SKIPPED", note: EMAIL_NOTES.invoiceLocked };
  }
  if (mode.mode === "LIVE" && msg.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: msg.customerId }, select: { emailOptOut: true } });
    if (!c) return { status: "SKIPPED", note: EMAIL_NOTES.noRecipient };
    if (c.emailOptOut) return { status: "SKIPPED", note: EMAIL_NOTES.optOut };
  }
  if (await prisma.emailSuppression.findUnique({ where: { email: toEmail }, select: { email: true } })) return { status: "SKIPPED", note: EMAIL_NOTES.suppressed };
  return null;
}

async function contentOf(msg: Claimed, company: CompanyInfo, replyable: boolean): Promise<Content | { refused: string }> {
  if (msg.attachmentKind === "quote_pdf") {
    const q = msg.attachmentRefId
      ? await prisma.quote.findUnique({
          where: { id: msg.attachmentRefId },
          select: { id: true, quoteNumber: true, revision: true, status: true, customerId: true, issuedAt: true, validUntil: true, issuedSnapshot: true, opportunity: { select: { customerId: true, owner: { select: { name: true } } } } },
        })
      : null;
    if (!q || !q.issuedSnapshot || q.status === "DRAFT") return { refused: EMAIL_NOTES.attachmentMissing };
    // The PDF is the document the customer holds: sent while the quotation is ISSUED or ACCEPTED only. A quotation that
    // EXPIRED, was REJECTED or SUPERSEDED (or is a DRAFT) is never attached — the e-mail is refused with that said.
    if (q.status !== "ISSUED" && q.status !== "ACCEPTED") return { refused: EMAIL_NOTES.quoteNotCurrent };
    // Only the event's own quotation, and only to its own customer — re-checked now, never trusted from the row.
    const owner = q.customerId ?? q.opportunity.customerId;
    if (!msg.customerId || owner !== msg.customerId || (msg.subjectType === "Quote" && msg.subjectId !== q.id)) return { refused: EMAIL_NOTES.attachmentOther };
    const input = quoteEmailInput(q, company, null);
    if (!input) return { refused: EMAIL_NOTES.attachmentMissing };
    input.replyable = replyable;
    input.repName = q.opportunity.owner?.name ?? null;
    const r = renderQuoteEmail(input);
    const subject = msg.subject?.trim() && !msg.subject.includes("{{") ? msg.subject : r.subject;
    return { subject, html: r.html, text: r.text, attachments: r.attachments, sha256: r.pdfSha256 || null };
  }
  const r = renderTextEmail({ subject: msg.subject, bodyText: msg.bodyText, company });
  return { subject: r.subject, html: r.html, text: r.text, sha256: null };
}

/** Send the e-mails that are due. Independent of the WhatsApp connection. */
export async function sendDueEmails(report: EmailSendReport, deadline: number, maxSends: number): Promise<void> {
  const settings = await readEmailSettings();
  const mode = effectiveEmailMode(settings);
  const now = new Date();

  // Expired, with the reason it waited kept in the note (never a bare «Expired»).
  await prisma.$executeRaw`
    UPDATE "EmailMessage" SET status = 'FAILED', "updatedAt" = now(),
           "statusNote" = ${EMAIL_NOTES.expired} || CASE WHEN "statusNote" IS NULL OR "statusNote" = '' THEN '' ELSE ' (' || "statusNote" || ')' END
     WHERE status = 'QUEUED' AND "scheduledAt" < ${new Date(now.getTime() - STALE_MS)}`;
  if (mode.mode === "OFF") {
    report.emailPaused = mode.note;
    return;
  }
  const dueWhere = { status: "QUEUED" as const, scheduledAt: { lte: now }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };
  const due = await prisma.emailMessage.count({ where: dueWhere });
  if (due === 0) return;
  if (!emailConfigured()) {
    // No RESEND_API_KEY / EMAIL_FROM: the rows wait, and say why (the log and the settings card show it).
    report.emailPaused = EMAIL_NOTES.notConfigured;
    await prisma.emailMessage.updateMany({ where: { ...dueWhere, OR: [{ statusNote: null }, { statusNote: { not: EMAIL_NOTES.notConfigured } }] }, data: { statusNote: EMAIL_NOTES.notConfigured } });
    return;
  }

  const claimed = await prisma.$queryRaw<Claimed[]>`
    UPDATE "EmailMessage" SET status = 'SENDING', "lockedAt" = now(), "updatedAt" = now()
    WHERE id IN (
      SELECT id FROM "EmailMessage"
      WHERE status = 'QUEUED' AND "scheduledAt" <= now() AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
      ORDER BY "scheduledAt" ASC
      LIMIT ${maxSends}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "bodyArchivedAt", "eventType", "recipientKind", "toEmail", "intendedEmail", subject, "bodyText", attempts, "statusNote", "customerId", "subjectType", "subjectId", "attachmentKind", "attachmentRefId", "scheduledAt"`;
  if (claimed.length === 0) return;

  const company = await companyInfo();
  const base = appBaseUrl();
  const companyReplyTo = (await prisma.automationSettings.findUnique({ where: { id: SETTINGS_ID }, select: { replyToEmail: true } }))?.replyToEmail ?? null;
  const done = (id: string, data: Prisma.EmailMessageUpdateInput) => prisma.emailMessage.update({ where: { id }, data: { lockedAt: null, ...data } });

  for (let i = 0; i < claimed.length; i++) {
    const msg = claimed[i];
    if (Date.now() > deadline - 2 * PAUSE_BETWEEN_EMAILS_MS) {
      await releaseUnsent(claimed.slice(i));
      return;
    }
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_EMAILS_MS));

    // Layer 2: the destination decided again with the mode of this moment.
    const { toEmail, intendedEmail } = emailSendTarget(mode, msg);
    if (!toEmail) {
      await done(msg.id, { status: "FAILED", statusNote: EMAIL_NOTES.noEmail });
      continue;
    }
    if (msg.bodyArchivedAt) {
      await done(msg.id, { status: "FAILED", statusNote: EMAIL_NOTES.archived });
      continue;
    }
    // LIVE, to a customer: no system address = no unsubscribe link = not sent (and the reason shown).
    if (mode.mode === "LIVE" && msg.customerId && !base) {
      await done(msg.id, { status: "FAILED", statusNote: EMAIL_NOTES.noBaseUrl, toEmail, intendedEmail });
      continue;
    }
    const refused = await sendTimeRefusal(msg, mode, toEmail);
    if (refused) {
      await done(msg.id, { status: refused.status, statusNote: refused.note, toEmail, intendedEmail });
      continue;
    }
    const replyTo = await replyToFor(msg.customerId, companyReplyTo, { type: msg.subjectType, id: msg.subjectId });
    const content = await contentOf(msg, company, !!replyTo);
    if ("refused" in content) {
      await done(msg.id, { status: "FAILED", statusNote: content.refused, toEmail, intendedEmail });
      continue;
    }
    // TEST never carries the real customer's link or List-Unsubscribe: one click by the tester would stop a real
    // customer's e-mails and write a consent record nobody gave. The footer says «في وضع التجربة رابط الإيقاف معطّل».
    const linkId = mode.mode === "LIVE" && base && msg.customerId ? await linkIdOf(msg.customerId) : null;
    const token = linkId ? unsubscribeToken(linkId) : null;
    if (mode.mode === "LIVE" && msg.customerId && !token) {
      await done(msg.id, { status: "FAILED", statusNote: EMAIL_NOTES.noBaseUrl, toEmail, intendedEmail });
      continue;
    }
    const wrap = { test: mode.mode === "TEST" ? { intended: intendedEmail } : null, unsubscribeUrl: token ? `${base}/email/unsubscribe?t=${token}` : null };
    const attemptNo = msg.attempts + 1;
    const message = {
      to: [toEmail],
      subject: wrapSubject(content.subject, wrap),
      html: wrapHtml(content.html, wrap),
      text: wrapText(content.text, wrap),
      attachments: content.attachments,
      replyTo,
      // RFC 8058 one-click: the mail client POSTs to the API, never to the page.
      headers: token ? { "List-Unsubscribe": `<${base}/api/email/unsubscribe?t=${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
      // Stable per message (fix round 1): Resend answers a repeat of the same key within 24 h with the first result, so a
      // retry after a timeout can never deliver twice. (A manual retry of a message Resend refused is a new request.)
      idempotencyKey: `msg-${msg.id}`,
      // Fix round 2: our delivery reports are told from the account's other e-mails by this tag (webhooks/resend).
      tags: [{ ...AUTOMATION_TAG }],
    };
    // Layer 3: the exact message about to be handed over.
    const guard = finalEmailGuard(mode, message);
    if (guard) {
      await done(msg.id, { status: "FAILED", statusNote: guard, toEmail, intendedEmail });
      continue;
    }

    const started = Date.now();
    const result = await deliverEmail(message);
    const durationMs = Date.now() - started;
    await prisma.emailSendAttempt.create({
      data: { messageId: msg.id, attemptNo, ok: result.status === "SENT", httpStatus: result.httpStatus, providerMessageId: result.providerMessageId, error: result.error, durationMs },
    });

    if (result.status === "SENT") {
      report.emailsSent++;
      await done(msg.id, {
        status: "SENT", toEmail, intendedEmail, attempts: attemptNo, sentAt: new Date(), nextAttemptAt: null,
        providerMessageId: result.providerMessageId, httpStatus: result.httpStatus,
        subject: message.subject, bodyText: loggableText(message.text), attachmentSha256: content.sha256,
        statusNote: msg.statusNote?.startsWith(EMAIL_NOTES.testUnusable) ? msg.statusNote : null,
      });
      continue;
    }

    report.emailFailures++;
    // 429 / 5xx: Resend did not accept it, so trying again later is safe. No answer at all (timeout, network): it may
    // have been accepted — failed, and only a person retries it.
    const transient = result.httpStatus !== null && (result.httpStatus === 429 || result.httpStatus >= 500);
    const exhausted = attemptNo >= MAX_EMAIL_ATTEMPTS;
    const note = result.httpStatus === null ? `${EMAIL_NOTES.interrupted} (${result.error ?? "no answer"})` : result.error ?? "Send failed.";
    await done(msg.id, transient && !exhausted
      ? { status: "QUEUED", toEmail, intendedEmail, attempts: attemptNo, httpStatus: result.httpStatus, nextAttemptAt: new Date(Date.now() + BACKOFF_MINUTES[attemptNo - 1] * 60_000), statusNote: note }
      : { status: "FAILED", toEmail, intendedEmail, attempts: attemptNo, httpStatus: result.httpStatus, nextAttemptAt: null, statusNote: exhausted && transient ? `Gave up after ${attemptNo} attempts: ${note}` : note });

    // A rejected key, an unconfigured provider, a rate limit or a dead network fail every message alike: stop.
    if (result.status === "NOT_CONFIGURED" || result.httpStatus === null || result.httpStatus === 401 || result.httpStatus === 403 || result.httpStatus === 429) {
      report.emailPaused = note;
      await releaseUnsent(claimed.slice(i + 1));
      return;
    }
  }
}

async function releaseUnsent(rows: Claimed[]) {
  if (rows.length === 0) return;
  await prisma.emailMessage.updateMany({ where: { id: { in: rows.map((r) => r.id) }, status: "SENDING" }, data: { status: "QUEUED", lockedAt: null } });
}

/** Retry a failed e-mail, or cancel a queued one (automation › manage_messages). A bounce or complaint is never retried. */
export async function actOnEmail(tx: Prisma.TransactionClient, id: string, action: "retry" | "cancel", actorName: string) {
  const msg = await tx.emailMessage.findUnique({ where: { id }, select: { status: true, toEmail: true, intendedEmail: true, bodyArchivedAt: true } });
  if (!msg) throw { _appCode: 404, message: "Message not found." };
  if (action === "retry") {
    if (msg.bodyArchivedAt) throw { _appCode: 409, message: "نص هذه الرسالة انتقل للأرشيف (أقدم من 180 يوم)، فما تنعاد.", errorEn: EMAIL_NOTES.archived, code: "ARCHIVED" };
    if (msg.status !== "FAILED") throw { _appCode: 409, message: "Only a failed message can be retried." };
    const r = await tx.emailMessage.updateMany({
      where: { id, status: "FAILED" },
      data: { status: "QUEUED", attempts: 0, nextAttemptAt: null, lockedAt: null, scheduledAt: new Date(), statusNote: `Retried by ${actorName}.` },
    });
    if (r.count === 0) throw { _appCode: 409, message: "The message changed. Reload and try again." };
    return;
  }
  if (msg.status !== "QUEUED") throw { _appCode: 409, message: "Only a message waiting to be sent can be cancelled." };
  const r = await tx.emailMessage.updateMany({ where: { id, status: "QUEUED" }, data: { status: "CANCELLED", statusNote: `Cancelled by ${actorName}.` } });
  if (r.count === 0) throw { _appCode: 409, message: "The message is already being sent." };
}

/**
 * Run the e-mail planning of an event inside a SAVEPOINT of the event's transaction (fix round 1): an e-mail error rolls
 * back the e-mail rows only — the WhatsApp rows of the same event are kept, and the event is not retried for it.
 */
export async function withEmailSavepoint(tx: Prisma.TransactionClient, fn: () => Promise<void>): Promise<void> {
  await tx.$executeRawUnsafe("SAVEPOINT email_plan");
  try {
    await fn();
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT email_plan");
  } catch (err) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT email_plan");
    console.error("[automation] e-mail planning failed (WhatsApp kept):", err instanceof Error ? err.message : err);
  }
}
