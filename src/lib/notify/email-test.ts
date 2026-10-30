// Settings › «البريد الإلكتروني» › «إرسال رسائل تجريبية» (feature/email-demo): the server side.
//
// The owner checks the configured provider by sending the four demo e-mails (lib/notify/templates/
// demo.ts) to ONE address he types — from inside the deployed app, so nobody ever reads the key.
//
//   * Who: the admin role, a verified individual after a recent step-up (requireAdminAction, step
//     «settings.email_test») — the gate of every Organisation setting.
//   * How often: 3 runs per hour per user. Counted from this feature's own audit rows (SettingsAuditLog,
//     entityType «EmailTest»), so the limit writes nothing of its own; a second run of the same user
//     while one is in flight in this instance is refused too.
//   * What it writes: ONE SettingsAuditLog row per run (section «organisation», action
//     «SETTINGS_UPDATED» — the values the table's CHECK constraints already allow, no migration —
//     entityType «EmailTest», changed [], reason «EMAIL_TEST_SENT»): who, when, the recipient's DOMAIN
//     only, and the status of each of the four mails. Nothing else: no quotation, invoice, counter,
//     ZATCA state or journal entry is read for writing or created.
//   * Never logs the key, the sender address or the recipient.
import { prisma } from "@/lib/db";
import { emailProviderStatus, sendEmail, type EmailResult } from "@/lib/notify/email";
import { sellerSnapshot } from "@/lib/services/invoicing/settings";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import { buildDemoEmails, companyInfoFrom, type DemoKind } from "./templates/demo";
import { EMAIL_TEST_ENTITY, EMAIL_TEST_LIMIT, EMAIL_TEST_REASON, deploymentEnvironment, recipientDomain } from "./email-test-rules";

export { EMAIL_TEST_ENTITY, EMAIL_TEST_LIMIT, EMAIL_TEST_REASON, deploymentEnvironment, parseTestRecipient, recipientDomain } from "./email-test-rules";

export type EmailTestStatus = Exclude<EmailResult, "NO_RECIPIENTS">;
export type EmailTestResult = { kind: DemoKind; subject: string; status: EmailTestStatus; attachments: number };

/** Runs of this user in the window, and when the oldest one leaves it. */
export async function testRunsInWindow(userId: string, now = new Date()): Promise<{ used: number; retryAt: Date | null }> {
  const since = new Date(now.getTime() - EMAIL_TEST_LIMIT.windowMs);
  const rows = await prisma.settingsAuditLog.findMany({
    where: { entityType: EMAIL_TEST_ENTITY, actorId: userId, createdAt: { gte: since } },
    select: { createdAt: true }, orderBy: { createdAt: "asc" },
  });
  const retryAt = rows.length >= EMAIL_TEST_LIMIT.runs ? new Date(rows[rows.length - EMAIL_TEST_LIMIT.runs].createdAt.getTime() + EMAIL_TEST_LIMIT.windowMs) : null;
  return { used: rows.length, retryAt };
}

const inFlight = new Set<string>();

export type RunOutcome =
  | { ok: true; results: EmailTestResult[]; recipientDomain: string; provider: string | null; remaining: number }
  | { ok: false; code: "RATE_LIMITED"; retryAt: Date | null }
  | { ok: false; code: "IN_PROGRESS" };

export async function runEmailTest(actor: { id: string; name?: string | null }, to: string, now = new Date()): Promise<RunOutcome> {
  if (inFlight.has(actor.id)) return { ok: false, code: "IN_PROGRESS" };
  inFlight.add(actor.id);
  try {
    const runs = await testRunsInWindow(actor.id, now);
    if (runs.used >= EMAIL_TEST_LIMIT.runs) return { ok: false, code: "RATE_LIMITED", retryAt: runs.retryAt };

    const status = emailProviderStatus();
    const company = companyInfoFrom(await sellerSnapshot(prisma));
    const mails = buildDemoEmails({ company, now, environment: deploymentEnvironment(), senderDomain: status.senderDomain });
    const results: EmailTestResult[] = [];
    for (const m of mails) {
      const s = await sendEmail({ to: [to], subject: m.email.subject, html: m.email.html, text: m.email.text, attachments: m.email.attachments });
      results.push({ kind: m.kind, subject: m.email.subject, status: s === "NO_RECIPIENTS" ? "FAILED" : s, attachments: m.email.attachments?.length ?? 0 });
    }
    const domain = recipientDomain(to);
    await writeSettingsAudit(prisma, {
      section: "organisation", action: "SETTINGS_UPDATED", entityType: EMAIL_TEST_ENTITY, entityId: "demo", changed: [],
      after: {
        recipientDomain: domain, provider: status.provider, environment: deploymentEnvironment(),
        results: Object.fromEntries(results.map((r) => [r.kind, r.status])),
        templates: mails.map((m) => m.email.version),
      },
      reason: EMAIL_TEST_REASON, actor,
    });
    return { ok: true, results, recipientDomain: domain, provider: status.provider, remaining: Math.max(0, EMAIL_TEST_LIMIT.runs - runs.used - 1) };
  } finally {
    inFlight.delete(actor.id);
  }
}
