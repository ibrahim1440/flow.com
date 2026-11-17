import { NextResponse } from "@/lib/api-response";
import { cronAuthorized } from "@/lib/cron/auth";
import { cronNeeded } from "@/lib/cron/needed";

/**
 * R1-e (owner decision 25 = أ): GET /api/cron/needed — CRON_SECRET only (lib/cron/auth.ts). The GitHub fallback schedule
 * (.github/workflows/cron.yml, every 3 hours) asks it first: `{ needed: false }` and that run ends early. Reads only;
 * not a job (nothing recorded in CronRun).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!cronAuthorized(request.headers).ok) return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await cronNeeded());
}
