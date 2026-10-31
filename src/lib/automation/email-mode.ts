/**
 * The e-mail channel's sending decisions, pure (no database, no Next) — batch 25, phase 1.
 *
 * The e-mail channel has its OWN mode (AutomationSettings.emailSendMode), its own deployment gate and its own test
 * address: switching WhatsApp to LIVE never switches e-mail with it. A customer receives an automated e-mail only
 * when ALL of these hold:
 *   - the administrator set the e-mail mode to LIVE (admin role + step-up, audited);
 *   - this deployment allows it: EMAIL_LIVE_ENABLED=true AND VERCEL_ENV=production (a preview, a local copy or a
 *     restored backup never e-mails customers, whatever a row says);
 *   - a test e-mail reached the test address in the last 30 days — checked when switching TO LIVE only (fix round 1):
 *     once LIVE, sending keeps going; the settings card reminds the owner when the last confirmed test is older.
 *
 * ── TEST: three layers, each enough on its own ──
 *   1. plan time (planEmailDelivery): the destination is the test address, always;
 *   2. send time (emailSendTarget): the destination is decided again with the mode of that moment — a row planned
 *      while LIVE goes to the test address when the mode is now TEST;
 *   3. the last guard (finalEmailGuard), right before the provider is called: exactly one `to`, equal to the test
 *      address, and no cc / bcc (the message type has none, and any such key is refused).
 * OFF sends nothing: rows are recorded SKIPPED at plan time, and the sender does not run.
 */
import { isValidEmail, normalizeEmail } from "@/lib/notify/recipients";
import type { SendMode } from "./send-mode";

/** LIVE is refused unless a test e-mail reached the test address within this many days. */
export const TEST_EMAIL_FRESH_DAYS = 30;

export function emailLiveAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.EMAIL_LIVE_ENABLED === "true" && env.VERCEL_ENV === "production";
}

export type EffectiveEmailMode =
  | { mode: "OFF"; note: string }
  | { mode: "TEST"; testEmail: string }
  | { mode: "LIVE" };

export const EMAIL_NOTES = {
  off: "E-mail sending is turned off. The message was recorded, not sent.",
  liveBlocked: "Live e-mail is not enabled on this deployment.",
  liveUnverified: "Live e-mail needs a test e-mail that arrived in the last 30 days.",
  testNoAddress: "Test mode has no test e-mail address. The message was recorded, not sent.",
  optOut: "This customer asked not to receive e-mails.",
  suppressed: "This address bounced or complained before: never e-mailed again.",
  noEmail: "No e-mail address on record.",
  badEmail: "The e-mail address on record is not valid.",
  noRecipient: "No recipient for this event (for example, the order has no owner yet).",
  testUnusable: "Test mode: sent to the test address only. The recipient's own address is not usable:",
  testRefused: "Test mode: refused to send to an address other than the test address.",
  invoiceLocked: "Tax invoice e-mails are locked until ZATCA clears or reports the invoice.",
  attachmentOther: "The attachment does not belong to this recipient.",
  attachmentMissing: "The document to attach no longer exists or is not issued.",
  expired: "Expired: not sent within 24 hours of its time.",
  interrupted: "Interrupted while sending: it may or may not have been delivered. Retry only if you are sure it was not.",
  notConfigured: "No e-mail provider is configured on this server.",
  notTransactional: "Only transactional e-mails from system events are sent (no marketing).",
  noBaseUrl: "Not sent: the system address (APP_BASE_URL) is not set, so the e-mail would have no unsubscribe link.",
  archived: "The text of this message was moved to the archive (older than 180 days); it cannot be sent again.",
  quoteNotCurrent: "The quotation is no longer issued (expired, rejected or replaced), so its PDF is not sent.",
} as const;

export function testEmailFresh(verifiedAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !!verifiedAt && now.getTime() - verifiedAt.getTime() <= TEST_EMAIL_FRESH_DAYS * 86_400_000 && verifiedAt.getTime() <= now.getTime() + 60_000;
}

/** What the e-mail sender actually does, given the stored settings and this deployment. */
export function effectiveEmailMode(
  s: { emailSendMode: SendMode; testEmail: string | null; testEmailVerifiedAt?: Date | null },
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): EffectiveEmailMode {
  void now;
  if (s.emailSendMode === "LIVE") {
    // The 30-day test is a condition of SWITCHING to LIVE (emailModeRefusal), never of staying LIVE.
    if (!emailLiveAllowed(env)) return { mode: "OFF", note: EMAIL_NOTES.liveBlocked };
    return { mode: "LIVE" };
  }
  if (s.emailSendMode === "TEST") {
    const t = parseEmailAddress(s.testEmail);
    return t ? { mode: "TEST", testEmail: t } : { mode: "OFF", note: EMAIL_NOTES.testNoAddress };
  }
  return { mode: "OFF", note: EMAIL_NOTES.off };
}

/** One plain address, trimmed and lower-cased, or null (a list, a display name, CR/LF or anything else is refused). */
export function parseEmailAddress(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (!t || /[\s,;<>"'()\\]/.test(t) || (t.match(/@/g) ?? []).length !== 1) return null;
  if (!isValidEmail(t)) return null;
  const domain = t.split("@")[1];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) ? t : null;
}

/** A mail subject: one line, no CR/LF (header injection), at most 150 characters. */
export function cleanSubject(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s{2,}/g, " ").trim().slice(0, 150);
}

/** Everything in an e-mail dedupe key: always "email:" first, so it can never collide with a WhatsApp key. */
export const emailKey = (base: string) => (base.startsWith("email:") ? base : `email:${base}`);

export type EmailPerson = { key: string; name: string; email: string | null | undefined; optOut?: boolean };

export type EmailDelivery = {
  toEmail: string | null;
  intendedEmail: string | null;
  status: "QUEUED" | "SKIPPED";
  statusNote: string | null;
  /** The recipient's own normalised address, for "one e-mail per address"; null when unusable. */
  ownEmail: string | null;
};

/**
 * One recipient, one mode → where the e-mail goes. The same table as the WhatsApp planDelivery:
 *   opted out / suppressed    → SKIPPED, in every mode
 *   OFF                       → SKIPPED, recorded as it would have been sent
 *   TEST                      → QUEUED to the test address ONLY (the recipient's own address need not be valid)
 *   LIVE, no usable address   → SKIPPED with the reason
 *   LIVE                      → QUEUED to the recipient's own address
 */
export function planEmailDelivery(person: EmailPerson, mode: EffectiveEmailMode, suppressed: (email: string) => boolean = () => false): EmailDelivery {
  const own = parseEmailAddress(person.email);
  const rawMissing = !normalizeEmail(person.email);
  const unusable = rawMissing ? EMAIL_NOTES.noEmail : EMAIL_NOTES.badEmail;
  if (person.optOut) return { toEmail: own, intendedEmail: null, status: "SKIPPED", statusNote: EMAIL_NOTES.optOut, ownEmail: own };
  if (mode.mode === "TEST") {
    return { toEmail: mode.testEmail, intendedEmail: own, status: "QUEUED", statusNote: own ? null : `${EMAIL_NOTES.testUnusable} ${unusable}`, ownEmail: own };
  }
  if (!own) return { toEmail: null, intendedEmail: null, status: "SKIPPED", statusNote: unusable, ownEmail: null };
  if (suppressed(own)) return { toEmail: own, intendedEmail: null, status: "SKIPPED", statusNote: EMAIL_NOTES.suppressed, ownEmail: own };
  if (mode.mode === "OFF") return { toEmail: own, intendedEmail: null, status: "SKIPPED", statusNote: mode.note, ownEmail: own };
  return { toEmail: own, intendedEmail: null, status: "QUEUED", statusNote: null, ownEmail: own };
}

/**
 * The address the sender uses for a queued e-mail, decided again at send time with the mode of that moment. In
 * TEST mode it is the test address, always — also for a row queued while the mode was LIVE.
 */
export function emailSendTarget(mode: Exclude<EffectiveEmailMode, { mode: "OFF" }>, msg: { toEmail: string | null; intendedEmail: string | null }): { toEmail: string | null; intendedEmail: string | null } {
  if (mode.mode === "TEST") {
    const intendedEmail = msg.intendedEmail ?? (msg.toEmail && msg.toEmail !== mode.testEmail ? msg.toEmail : null);
    return { toEmail: mode.testEmail, intendedEmail };
  }
  return { toEmail: msg.toEmail, intendedEmail: msg.intendedEmail };
}

const RECIPIENT_KEYS = ["cc", "bcc", "Cc", "Bcc", "CC", "BCC"];

/**
 * The last line between a test run and a customer's inbox, called with the exact message about to be handed to the
 * provider. In TEST: exactly one `to`, equal to the test address. In every mode: exactly one `to`, no cc / bcc (as
 * keys or as headers). Returns the refusal note, or null when the message may go.
 */
export function finalEmailGuard(mode: Exclude<EffectiveEmailMode, { mode: "OFF" }>, message: { to: string[]; headers?: Record<string, string> } & Record<string, unknown>): string | null {
  if (RECIPIENT_KEYS.some((k) => k in message)) return EMAIL_NOTES.testRefused;
  if (message.headers && Object.keys(message.headers).some((h) => ["cc", "bcc", "to"].includes(h.toLowerCase()))) return EMAIL_NOTES.testRefused;
  if (!Array.isArray(message.to) || message.to.length !== 1) return EMAIL_NOTES.testRefused;
  if (mode.mode === "TEST") return message.to[0] === mode.testEmail ? null : EMAIL_NOTES.testRefused;
  return parseEmailAddress(message.to[0]) === message.to[0] ? null : EMAIL_NOTES.badEmail;
}

// ─── Switching a channel's mode ────────────────────────────────────────────────

export type ModeChangeRefusal = { status: number; code: string; error: string; errorEn: string };

/**
 * May the e-mail mode move to `to`? (The step-up and the admin role are checked by the route, first.) LIVE needs this
 * deployment's gate and a fresh successful test; TEST needs a test address; OFF is always allowed.
 */
export function emailModeRefusal(
  to: SendMode,
  s: { testEmail: string | null; testEmailVerifiedAt: Date | null },
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): ModeChangeRefusal | null {
  if (to === "TEST" && !s.testEmail) return { status: 400, code: "TEST_EMAIL_REQUIRED", error: "وضع التجربة يحتاج إيميل تجربة.", errorEn: "Test mode needs a test e-mail address." };
  if (to !== "LIVE") return null;
  if (!emailLiveAllowed(env)) {
    return { status: 409, code: "EMAIL_LIVE_DISABLED", error: "الإرسال الفعلي للإيميل مقفل على هذا الخادم. يفتحه الدعم الفني بقرار من المالك.", errorEn: "Live e-mail is locked on this server (EMAIL_LIVE_ENABLED on production)." };
  }
  if (!env.RESEND_WEBHOOK_SECRET?.trim()) {
    return { status: 409, code: "EMAIL_WEBHOOK_MISSING", error: "قبل «فعلي» لازم يُضبط سر الـ webhook (RESEND_WEBHOOK_SECRET) حتى نعرف الإيميلات المرتدّة. كلّم الدعم الفني.", errorEn: "Before Live, RESEND_WEBHOOK_SECRET must be set (bounces and complaints)." };
  }
  if (!(env.APP_BASE_URL?.trim() || env.VERCEL_PROJECT_PRODUCTION_URL?.trim())) {
    return { status: 409, code: "EMAIL_BASE_URL_MISSING", error: "قبل «فعلي» لازم يُضبط عنوان النظام (APP_BASE_URL) حتى يوصل رابط الإيقاف. كلّم الدعم الفني.", errorEn: "Before Live, APP_BASE_URL must be set (the unsubscribe link)." };
  }
  if (!testEmailFresh(s.testEmailVerifiedAt, now)) {
    return { status: 409, code: "EMAIL_TEST_NOT_VERIFIED", error: "قبل «فعلي» لازم توصلك رسالة تجربة على إيميل التجربة (خلال آخر 30 يوم) وتضغط «وصلتني».", errorEn: "Before Live, a test e-mail must reach the test address (in the last 30 days) and be confirmed." };
  }
  return null;
}

/** The domain of an address, for audit rows (never the full address). */
export const emailDomain = (email: string | null | undefined) => (email ? email.split("@")[1] ?? null : null);
