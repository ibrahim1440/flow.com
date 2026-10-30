import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { parseTestRecipient, runEmailTest } from "@/lib/notify/email-test";

export const dynamic = "force-dynamic";
// Four messages, three of them with a PDF drawn on the server: well under a minute.
export const maxDuration = 60;

/**
 * POST /api/settings/email/test { to } — sends the four demo e-mails (lib/notify/templates/demo.ts) to
 * that ONE address (feature/email-demo). The admin role, a verified individual after a recent step-up
 * (401 REAUTH_REQUIRED otherwise — the dashboard's step-up dialog retries); 3 runs per hour per user
 * (429 RATE_LIMITED with retryAt). Answers each mail's status — SENT / FAILED / NOT_CONFIGURED — and
 * writes one SettingsAuditLog row (the recipient's domain only). Writes nothing else.
 */
export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "settings.email_test", { stepUp: true });
  if (refused) return refused;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }
  const to = parseTestRecipient(body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).to : null);
  if (!to) return NextResponse.json({ error: "أدخل عنوان بريد إلكتروني واحدًا صحيحًا.", errorEn: "Enter one valid e-mail address.", code: "INVALID_RECIPIENT", field: "to" }, { status: 400 });
  try {
    const r = await runEmailTest({ id: user.id, name: user.name }, to);
    if (!r.ok && r.code === "RATE_LIMITED") {
      return NextResponse.json({ error: "بلغت الحد: 3 مرات إرسال تجريبي في الساعة. حاول لاحقًا.", errorEn: "Limit reached: 3 test runs per hour. Try again later.", code: "RATE_LIMITED", retryAt: r.retryAt }, { status: 429, headers: r.retryAt ? { "Retry-After": String(Math.max(1, Math.ceil((r.retryAt.getTime() - Date.now()) / 1000))) } : undefined });
    }
    if (!r.ok) return NextResponse.json({ error: "إرسال تجريبي آخر قيد التنفيذ.", errorEn: "Another test run is in progress.", code: "IN_PROGRESS" }, { status: 409 });
    return NextResponse.json({ results: r.results, recipientDomain: r.recipientDomain, provider: r.provider, remaining: r.remaining });
  } catch (err) {
    return handleDomainError(err);
  }
}
