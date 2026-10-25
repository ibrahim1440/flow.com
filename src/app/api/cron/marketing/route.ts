import { NextResponse } from "@/lib/api-response";
import { cronAuthorized } from "@/lib/cron/auth";
import { runMarketingJobs } from "@/lib/marketing/server/jobs";

/**
 * The marketing automation engine's scheduler entry (publisher, journeys, WhatsApp sender, alerts,
 * daily decisions). Protected by lib/cron/auth.ts. Not added to vercel.json: on the Hobby plan Vercel
 * refuses crons more frequent than daily (docs/marketing/OPERATIONS.md — pick a scheduler).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = cronAuthorized(request.headers);
  if (!auth.ok) return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  try {
    const results = await runMarketingJobs("cron");
    return NextResponse.json({ ok: true, results: results.map((r) => ({ job: r.job, status: r.status })) });
  } catch (e) {
    console.error("[marketing] cron run failed:", (e as Error)?.name ?? "error");
    return NextResponse.json({ ok: false, error: "تعذّر تشغيل مهام التسويق", errorEn: "Marketing jobs could not run" }, { status: 500 });
  }
}
