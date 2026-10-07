/**
 * Sending mode, and the deployment-level cap on it.
 *
 * Two keys have to turn for a real customer to receive a message: an administrator sets the
 * mode to LIVE in the WhatsApp screen, AND the deployment sets WHATSAPP_LIVE_ENABLED=true.
 * The second is what keeps a preview, a local copy or a restored backup — any database that
 * holds real customers' numbers — from messaging them because a row said LIVE.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

type Db = Prisma.TransactionClient | typeof prisma;

export type SendMode = "OFF" | "TEST" | "LIVE";

export const SETTINGS_ID = "singleton";

export type AutomationSettingsView = {
  sendMode: SendMode;
  testPhone: string | null;
  lastSweepAt: Date | null;
  updatedAt: Date | null;
};

export async function readSettings(db: Db = prisma): Promise<AutomationSettingsView> {
  const row = await db.automationSettings.findUnique({ where: { id: SETTINGS_ID } });
  return {
    sendMode: (row?.sendMode ?? "OFF") as SendMode,
    testPhone: row?.testPhone ?? null,
    lastSweepAt: row?.lastSweepAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export function liveAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.WHATSAPP_LIVE_ENABLED === "true";
}

export type EffectiveMode =
  | { mode: "OFF"; note: string }
  | { mode: "TEST"; testPhone: string }
  | { mode: "LIVE" };

/** What the dispatcher actually does, given the stored mode and this deployment. */
export function effectiveMode(s: Pick<AutomationSettingsView, "sendMode" | "testPhone">, env = process.env): EffectiveMode {
  if (s.sendMode === "LIVE") {
    return liveAllowed(env)
      ? { mode: "LIVE" }
      : { mode: "OFF", note: "Live sending is not enabled on this deployment (WHATSAPP_LIVE_ENABLED)." };
  }
  if (s.sendMode === "TEST") {
    return s.testPhone ? { mode: "TEST", testPhone: s.testPhone } : { mode: "OFF", note: "Test mode has no test number." };
  }
  return { mode: "OFF", note: "Sending is turned off. The message was recorded, not sent." };
}
