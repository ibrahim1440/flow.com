import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { emailProviderStatus } from "@/lib/notify/email";
import { recipientFor } from "@/lib/notify/recipients";
import { EMAIL_TEST_LIMIT, deploymentEnvironment, testRunsInWindow } from "@/lib/notify/email-test";

export const dynamic = "force-dynamic";

/**
 * Settings › «البريد الإلكتروني» (feature/email-demo) — what the screen shows, read-only, the admin role
 * (the audience of every Organisation setting):
 *   · provider: "resend" | "outbox" (local runs only) | null (not configured);
 *   · senderDomain: the DOMAIN of EMAIL_FROM only — never the address, never the key;
 *   · defaultRecipient: the viewer's own company e-mail (lib/notify/recipients.ts), or null;
 *   · limit: the demo run's rate limit and what is left of it for this user.
 */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (user.role !== "admin") return forbidden();
  try {
    const s = emailProviderStatus();
    const me = await recipientFor(prisma, { accountId: user.id }, "system");
    const runs = await testRunsInWindow(user.id);
    return NextResponse.json({
      provider: s.provider,
      configured: s.provider !== null,
      senderDomain: s.senderDomain,
      environment: deploymentEnvironment(),
      defaultRecipient: me.email,
      limit: { runs: EMAIL_TEST_LIMIT.runs, windowMinutes: EMAIL_TEST_LIMIT.windowMs / 60_000, remaining: Math.max(0, EMAIL_TEST_LIMIT.runs - runs.used), retryAt: runs.retryAt },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
