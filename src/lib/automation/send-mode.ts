/**
 * The sending-mode decision, pure (no database): what the dispatcher actually does given the
 * stored mode and this deployment. settings.ts re-exports it with the database reads; tests import
 * it from here under plain Node (tests/automation/order-progress.test.ts).
 */
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
