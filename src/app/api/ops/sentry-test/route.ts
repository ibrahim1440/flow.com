import { NextResponse } from "@/lib/api-response";
import { requireEdit } from "@/lib/auth-server";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";
import { sentryTestError } from "@/lib/observability/sentry-test";

/**
 * POST /api/ops/sentry-test — R1-d: the owner's check that a server error reaches Sentry with its personal data removed.
 * Settings at edit only (403 otherwise); at most once a minute per person (429). Sends a synthetic error carrying FAKE
 * personal data (lib/observability/sentry-test.ts) through Sentry.captureException — scrubbed by beforeSend like any
 * other event — and answers its eventId, or { sentry: "off" } when SENTRY_DSN is not set. Writes nothing but the
 * rate-limit row.
 */
export async function POST() {
  const { user, error } = await requireEdit("settings");
  if (error) return error;
  const rl = await checkAndRecordRateLimit({ scope: "ops.sentry-test", key: user.id, limit: 1, windowMs: 60_000 });
  if (rl.limited) {
    return NextResponse.json(
      { error: "أرسلت خطأ تجريبي قبل شوي — جرّب بعد دقيقة.", errorEn: "A test error was sent a moment ago — try again in a minute.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  if (!process.env.SENTRY_DSN) return NextResponse.json({ ok: true, sentry: "off" });
  const Sentry = await import("@sentry/nextjs");
  const eventId = Sentry.captureException(sentryTestError("server"));
  await Sentry.flush(3000).catch(() => false);
  return NextResponse.json({ ok: true, sentry: "on", eventId });
}
