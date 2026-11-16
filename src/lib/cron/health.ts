// R1-d gate L3: who watches the watchdog. The watchdog (/api/cron/watchdog, every hour from GitHub) raises «system.cron_late»
// when another job stops — but if the watchdog itself stops (the GitHub schedule disabled, CRON_SECRET wrong, the
// workflow deleted), nothing inside the system notices. /api/health says so to the EXTERNAL uptime monitor instead.
//
// Public, so it says one word: "ok" (the watchdog succeeded within the last 3 hours), "stale" (it did not), or "unknown"
// (the check itself could not run). No time, no job name, no count.
import { prisma } from "@/lib/db";
import { cronHealthOf, type CronHealth } from "@/lib/cron/jobs";
export { cronHealthOf, WATCHDOG_STALE_MS, type CronHealth } from "@/lib/cron/jobs";


export async function cronHealth(now = new Date()): Promise<CronHealth> {
  try {
    const last = await prisma.cronRun.findFirst({ where: { job: "watchdog", status: "OK" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
    return cronHealthOf(last?.startedAt ?? null, now);
  } catch {
    return "unknown";
  }
}
