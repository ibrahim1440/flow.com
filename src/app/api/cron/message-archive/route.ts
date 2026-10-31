import { NextResponse } from "@/lib/api-response";
import { cronAuthorized } from "@/lib/cron/auth";
import { archiveOldMessages, messageArchiveEnabled } from "@/lib/automation/message-archive";

/**
 * Daily: message bodies older than 180 days move from the live logs to the archive, and archived messages older than
 * five years are destroyed through the controlled database path (owner decisions, 31 Oct 2026;
 * lib/automation/message-archive.ts). It MOVES data, so like the recurring job it accepts ONLY the CRON_SECRET bearer
 * (lib/cron/auth.ts), never the Vercel user-agent fallback. Idempotent and transactional per batch. Answers counts only.
 * Does nothing (`{ skipped: "disabled" }`) unless MESSAGE_ARCHIVE_ENABLED=true.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = cronAuthorized(request.headers);
  if (!auth.ok || auth.via !== "secret") return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  // Off unless MESSAGE_ARCHIVE_ENABLED=true (fix round 1): the first run moves live WhatsApp bodies — the owner's step.
  if (!messageArchiveEnabled()) return NextResponse.json({ ok: true, skipped: "disabled" });
  try {
    const r = await archiveOldMessages();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    console.error("[message-archive] run failed:", (e as Error)?.name ?? "error");
    return NextResponse.json({ ok: false, error: "تعذّر نقل الرسائل للأرشيف", errorEn: "The message archive run failed" }, { status: 500 });
  }
}
