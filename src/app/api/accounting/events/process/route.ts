import { accountingRoute } from "@/lib/accounting/http";
import { processPendingEvents } from "@/lib/accounting/event-processor";

export const POST = accountingRoute("events_process", async () => {
  const { processed } = await processPendingEvents();
  const by = (s: string) => processed.filter((p) => p.status === s).length;
  return { processed: processed.length, translated: by("TRANSLATED"), blocked: by("BLOCKED"), failed: by("FAILED"), skipped: by("SKIPPED"), results: processed.slice(0, 50) };
});
