import { wsRoute } from "@/lib/workspace/server/http";
import { canEdit } from "@/lib/auth-shared";
import { prisma } from "@/lib/db";
import { forbidden } from "@/lib/workspace/server/context";
import { getSettings, saveSettings } from "@/lib/workspace/server/settings";

/** GET — the workspace policy (working hours, reminders, escalation) and the last scheduled runs. */
export const GET = wsRoute(async () => ({
  settings: await getSettings(prisma),
  lastRuns: await prisma.workJobRun.findMany({ where: { trigger: { in: ["cron", "manual"] } }, orderBy: { startedAt: "desc" }, take: 10 }),
}));

/** PUT — the settings module at edit (the administrator). */
export const PUT = wsRoute(async ({ actor, body }) => {
  if (!canEdit(actor.permissions, "settings")) throw forbidden();
  return { settings: await saveSettings(prisma, actor.id, body) };
});
