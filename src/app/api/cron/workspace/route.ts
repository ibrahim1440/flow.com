import { NextResponse } from "@/lib/api-response";
import { cronAuthorized } from "@/lib/cron/auth";
import { runWorkspaceJobs } from "@/lib/workspace/server/reminders";

/**
 * «مساحة عملي» scheduler entry: sends the task and appointment reminders and escalations that are due.
 * Protected by lib/cron/auth.ts (CRON_SECRET). Idempotent — any number of calls, at any interval, never
 * send a reminder twice. vercel.json runs it daily (the Hobby plan's limit) as a floor; an external
 * scheduler every 5 minutes gives the reminders their intended precision (docs/workspace/OPERATIONS.md).
 * Signed-in pages also run it opportunistically (at most once a minute per instance).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = cronAuthorized(request.headers);
  if (!auth.ok) return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  try {
    const summary = await runWorkspaceJobs("cron");
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("[workspace] cron run failed:", (e as Error)?.name ?? "error");
    return NextResponse.json({ ok: false, error: "تعذّر تشغيل مهام مساحة العمل", errorEn: "Workspace jobs could not run" }, { status: 500 });
  }
}
