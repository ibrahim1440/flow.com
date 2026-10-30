import { NextResponse } from "@/lib/api-response";
import { cronAuthorized } from "@/lib/cron/auth";
import { deliverPendingEmails } from "@/lib/notifications/deliver";
import { contractNoticeRun } from "@/lib/services/customers/contracts";
import { prisma } from "@/lib/db";

/**
 * «صلاحية العقد» — the daily contract notice (batch 24; its own job since council fix round 1, so a failure of the HR
 * document check can never silence it, nor the reverse). Vercel Cron once a day at 03:20 UTC (06:20 Asia/Riyadh —
 * vercel.json `crons`), protected by lib/cron/auth.ts like every cron route. Idempotent: one notice per contract per
 * end date (contractNoticeRun's dedupe key), so a second call the same day writes nothing.
 *   · a customer with an account owner → that owner («عقد عميلك قرب ينتهي»);
 *   · a customer with NO account owner → the sales managers (team view: sales › lead_assign).
 * Answers counts only; a failure is a 500 with the error's name, never silence.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = cronAuthorized(request.headers);
  if (!auth.ok) return NextResponse.json({ error: "غير مصرّح", errorEn: "Unauthorized" }, { status: 401 });
  try {
    const contracts = await contractNoticeRun(prisma);
    const emails = await deliverPendingEmails({ limit: 200 });
    return NextResponse.json({ ok: true, contracts, emails: emails.length });
  } catch (e) {
    console.error("[contracts] notice run failed:", (e as Error)?.name ?? "error");
    return NextResponse.json({ ok: false, error: "تعذّر تشغيل تنبيه العقود", errorEn: "The contract notice run failed" }, { status: 500 });
  }
}
