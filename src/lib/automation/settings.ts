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
import type { SendMode } from "./send-mode";
export { effectiveMode, liveAllowed, type EffectiveMode, type SendMode } from "./send-mode";

type Db = Prisma.TransactionClient | typeof prisma;

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
