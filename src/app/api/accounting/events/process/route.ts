import { accountingRoute } from "@/lib/accounting/http";
import { processPendingEvents } from "@/lib/accounting/event-processor";
import { processPendingOpsEvents } from "@/lib/accounting/ops-integration";
import { processPendingCosting } from "@/lib/accounting/sales-costing";

// One run of every automatic posting, in dependency order: operational stock events first (goods
// received, made and dispatched), then cost of sales (which draws on them), then ledger events.
export const POST = accountingRoute("events_process", async () => {
  const ops = await processPendingOpsEvents();
  const costing = await processPendingCosting();
  const { processed } = await processPendingEvents();
  const by = (s: string) => processed.filter((p) => p.status === s).length;
  const count = <T extends { status: string }>(xs: T[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {});
  return { processed: processed.length, translated: by("TRANSLATED"), blocked: by("BLOCKED"), failed: by("FAILED"), skipped: by("SKIPPED"), results: processed.slice(0, 50),
    operations: count(ops as { status: string }[]), costing: count(costing.statuses.map((status) => ({ status }))) };
});
