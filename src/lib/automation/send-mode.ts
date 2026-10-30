/**
 * The sending-mode decision, pure (no database): what the dispatcher actually does given the
 * stored mode and this deployment. settings.ts re-exports it with the database reads; tests import
 * it from here under plain Node (tests/automation/order-progress.test.ts).
 */
import { normalizePhoneForWhatsApp } from "./phone";

export type SendMode = "OFF" | "TEST" | "LIVE";

export function liveAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.WHATSAPP_LIVE_ENABLED === "true";
}

export type EffectiveMode =
  | { mode: "OFF"; note: string }
  | { mode: "TEST"; testPhone: string }
  | { mode: "LIVE" };

/** What the dispatcher actually does, given the stored mode and this deployment. */
export function effectiveMode(s: { sendMode: SendMode; testPhone: string | null }, env: Record<string, string | undefined> = process.env): EffectiveMode {
  if (s.sendMode === "LIVE") {
    return liveAllowed(env)
      ? { mode: "LIVE" }
      : { mode: "OFF", note: "Live sending is not enabled on this deployment (WHATSAPP_LIVE_ENABLED)." };
  }
  if (s.sendMode === "TEST") {
    return s.testPhone ? { mode: "TEST", testPhone: s.testPhone } : { mode: "OFF", note: "Test mode has no test number. The message was recorded as it would have been sent, not sent." };
  }
  return { mode: "OFF", note: "Sending is turned off. The message was recorded, not sent." };
}

// ─── Where one message goes ────────────────────────────────────────────────────

/**
 * The note on a message that TEST mode sent to the test number although the real recipient's own
 * number could not have been used. Kept on the row after it is sent, so the log still says why.
 */
export const TEST_UNUSABLE_NOTE = "Test mode: sent to the test number only. The recipient's own number is not usable:";

export const isTestTraceNote = (note: string | null | undefined): note is string => !!note && note.startsWith(TEST_UNUSABLE_NOTE);

export type Delivery = {
  /** Where the message goes: the test number in TEST mode, whatever the recipient's own number is. */
  phone: string | null;
  /** The recipient's own number (normalised) when TEST mode redirected the message; null when it had none usable. */
  intendedPhone: string | null;
  status: "QUEUED" | "SKIPPED";
  statusNote: string | null;
  /** The recipient's own normalised number, for "one message per phone"; null when it has none usable. */
  ownPhone: string | null;
};

/**
 * One recipient, one mode → where the message goes. Shared by the automation rules (dispatcher.ts)
 * and the status rules (status-rules/rules.ts), so both behave the same:
 *
 *   opted out                  → SKIPPED, in every mode
 *   OFF                        → SKIPPED, recorded as it would have been sent
 *   TEST                       → QUEUED to the test number ONLY. The recipient's own number is never
 *                                a destination, so it does not need to be valid: missing or unusable,
 *                                the test still goes out, with the reason kept in the note.
 *   LIVE, no usable number     → SKIPPED with the reason
 *   LIVE                       → QUEUED to the recipient's own number
 */
export function planDelivery(person: { phone: string | null | undefined; optOut?: boolean }, mode: EffectiveMode): Delivery {
  const own = normalizePhoneForWhatsApp(person.phone);
  const ownPhone = own.ok ? own.phone : null;
  if (person.optOut) return { phone: ownPhone, intendedPhone: null, status: "SKIPPED", statusNote: "This customer asked not to receive WhatsApp messages.", ownPhone };
  if (mode.mode === "TEST") {
    return {
      phone: mode.testPhone,
      intendedPhone: ownPhone,
      status: "QUEUED",
      statusNote: own.ok ? null : `${TEST_UNUSABLE_NOTE} ${own.reason}`,
      ownPhone,
    };
  }
  if (!own.ok) return { phone: null, intendedPhone: null, status: "SKIPPED", statusNote: own.reason, ownPhone };
  if (mode.mode === "OFF") return { phone: own.phone, intendedPhone: null, status: "SKIPPED", statusNote: mode.note, ownPhone };
  return { phone: own.phone, intendedPhone: null, status: "QUEUED", statusNote: null, ownPhone };
}

/**
 * The number the sender actually dials for a queued message, decided again at send time with the
 * mode of that moment. In TEST mode it is the test number, always — also for a message queued while
 * the mode was LIVE, or redirected to an earlier test number. The message's own number is then kept
 * as intendedPhone, unless it is a test number itself.
 */
export function sendTarget(mode: Exclude<EffectiveMode, { mode: "OFF" }>, msg: { phone: string | null; intendedPhone: string | null }): { phone: string | null; intendedPhone: string | null } {
  if (mode.mode === "TEST") {
    const intendedPhone = msg.intendedPhone ?? (msg.phone && msg.phone !== mode.testPhone ? msg.phone : null);
    return { phone: mode.testPhone, intendedPhone };
  }
  return { phone: msg.phone, intendedPhone: msg.intendedPhone };
}
