import { NextResponse } from "next/server";
import { cronHealth } from "@/lib/cron/health";

/**
 * GET /api/health/cron — R1-d gate L3: the scheduled jobs, for a SECOND external monitor (docs/ops/CRON-AND-MONITORING.md).
 * 200 { cron: "ok" } when the hourly watchdog succeeded within the last 3 hours; 503 { cron: "stale" } when it did not
 * (or { cron: "unknown" } when the check could not run). Public and as silent as /api/health: one word, no time, no names.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;
const TIMEOUT_MS = 3000;

export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"unknown">((resolve) => { timer = setTimeout(() => resolve("unknown"), TIMEOUT_MS); });
  const cron = await Promise.race([cronHealth(), timeout]);
  if (timer) clearTimeout(timer);
  return NextResponse.json({ cron }, { status: cron === "ok" ? 200 : 503, headers: NO_STORE });
}
