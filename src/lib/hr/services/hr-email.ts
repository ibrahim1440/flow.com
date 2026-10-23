// HR e-mails: the interview invitation and the end-of-service notice (feat/hr-expiry-email).
//
// Built now, sending only once the owner configures the provider (RESEND_API_KEY + EMAIL_FROM —
// lib/notify/email.ts). Until then everything works but the send itself: the preview renders, the
// screen says «البريد غير مفعّل بعد», and a «إرسال» is recorded as NOT_CONFIGURED. Nothing here throws
// because of e-mail: the adapter's result is the outcome (SENT / FAILED / NOT_CONFIGURED / NO_ADDRESS).
//
// Who may send:
//   * the invitation — hr › recruit (the applicant's own address, HrApplicant.email);
//   * the notice     — hr › offboard, the person in the sender's HR scope, never one's own notice
//                      (SIMPLE MODE excepted, like the separation itself). To the PERSONAL e-mail
//                      (HrEmployeePrivate.personalEmail, recipientFor «hr_separation»); with none on
//                      record, the company e-mail only when the sender confirms it (useCompanyEmail).
// The personal e-mail is HR private data: it is read here only to send (a system read, like
// lib/notify/recipients.ts) and is never shown — the preview and the log carry it masked («a•••@g•••.com»).
// Both are logged in the append-only HrAuditLog: the invitation on the applicant (entity HrApplicant),
// the notice on the employee's HR record (entity HrSeparation, employeeId set — the employee file's
// «السجل» tab), with the outcome, the template version and the masked address.
import { prisma } from "@/lib/db";
import { emailConfigured, sendEmail, type EmailResult } from "@/lib/notify/email";
import { recipientFor, type MissingReason } from "@/lib/notify/recipients";
import { HrError, type HrActor, assertCan, assertNotSelf, audit, personInScope, resolveScope, text } from "../core";
import { dayString } from "../dates";
import { companyFrom, maskEmail, renderInterviewInvite, renderSeparationNotice, separationReference, type Rendered } from "../email-templates";
import { clearance } from "./workforce";

export type HrEmailStatus = Exclude<EmailResult, "NO_RECIPIENTS"> | "NO_ADDRESS";
const STATUS_AR: Record<HrEmailStatus, string> = { SENT: "أُرسل", FAILED: "تعذّر الإرسال", NOT_CONFIGURED: "البريد غير مفعّل بعد", NO_ADDRESS: "لا يوجد بريد مسجّل" };

type Mode = "preview" | "send";
const modeOf = (b: Record<string, unknown>): Mode => (b.action === "send" ? "send" : "preview");

async function company() {
  return companyFrom(await prisma.systemConfig.findUnique({ where: { id: "singleton" }, select: { sellerLegalNameAr: true, sellerLegalNameEn: true, sellerPhone: true } }));
}
async function nameOf(accountId: string) {
  return (await prisma.employee.findUnique({ where: { id: accountId }, select: { name: true } }))?.name ?? null;
}

async function deliver(to: string | null, r: Rendered): Promise<HrEmailStatus> {
  if (!to) return "NO_ADDRESS";
  const s = await sendEmail({ to: [to], subject: r.subject, html: r.html, text: r.text });
  return s === "NO_RECIPIENTS" ? "NO_ADDRESS" : s;
}

async function logOf(entityType: string, entityId: string, action: string) {
  const rows = await prisma.hrAuditLog.findMany({ where: { entityType, entityId, action }, orderBy: { createdAt: "desc" }, take: 20 });
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  return rows.map((r) => {
    const a = (r.after ?? {}) as { status?: string; to?: string | null; version?: string; channel?: string };
    return { id: r.id, at: r.createdAt, by: r.actorId ? names.get(r.actorId) ?? null : null, status: a.status ?? null, to: a.to ?? null, version: a.version ?? null, channel: a.channel ?? null };
  });
}

// ── Interview invitation ───────────────────────────────────────────────────────────

export async function interviewInvite(actor: HrActor, applicantId: string, b: Record<string, unknown>) {
  assertCan(actor, "recruit");
  const mode = modeOf(b);
  const a = await prisma.hrApplicant.findUnique({ where: { id: applicantId }, include: { opening: { select: { title: true } }, interviews: { orderBy: { scheduledAt: "desc" } } } });
  if (!a) throw new HrError("Applicant not found", 404);
  const interviewId = text(b.interviewId, "interviewId", { max: 40 });
  const iv = interviewId ? a.interviews.find((x) => x.id === interviewId) : a.interviews.find((x) => x.outcome === "PENDING") ?? null;
  if (!iv) throw new HrError(interviewId ? "Interview not found" : "Schedule an interview first: the invitation names its date and time.", interviewId ? 404 : 409, "NO_INTERVIEW");
  const location = text(b.location, "location", { max: 300 });
  const contactName = text(b.contactName, "contactName", { max: 120 }) ?? (await nameOf(actor.id));
  const contactPhone = text(b.contactPhone, "contactPhone", { max: 40 });
  const note = text(b.note, "note", { max: 1000 });
  const rendered = renderInterviewInvite({ company: await company(), applicantName: a.fullName, position: a.opening?.title ?? null, scheduledAt: iv.scheduledAt, kind: iv.kind, location, contactName, contactPhone, note });
  const rec = await recipientFor(prisma, { applicantId }, "hr_interview");
  const preview = {
    configured: emailConfigured(), interviewId: iv.id, scheduledAt: iv.scheduledAt,
    // An applicant's address is not HR private data: the recruiter already sees it on the applicant.
    recipient: { email: rec.email, channel: rec.email ? "applicant" : null, missing: rec.email ? null : (rec as { reason: MissingReason }).reason },
    subject: rendered.subject, html: rendered.html, text: rendered.text, version: rendered.version,
  };
  if (mode === "preview") return preview;
  const status = await deliver(rec.email, rendered);
  await audit(prisma, {
    action: "EMAIL_INTERVIEW_INVITE", entityType: "HrApplicant", entityId: applicantId,
    after: { status, version: rendered.version, interviewId: iv.id, to: maskEmail(rec.email), channel: "applicant", noteChars: note?.length ?? 0 },
    reason: `${STATUS_AR[status]}${rec.email ? ` · ${maskEmail(rec.email)}` : ""}`, actorId: actor.id,
  });
  return { ...preview, status, log: await logOf("HrApplicant", applicantId, "EMAIL_INTERVIEW_INVITE") };
}

export async function interviewInviteLog(actor: HrActor, applicantId: string) {
  assertCan(actor, "recruit");
  if (!(await prisma.hrApplicant.findUnique({ where: { id: applicantId }, select: { id: true } }))) throw new HrError("Applicant not found", 404);
  return { configured: emailConfigured(), log: await logOf("HrApplicant", applicantId, "EMAIL_INTERVIEW_INVITE") };
}

// ── End-of-service notice ──────────────────────────────────────────────────────────

async function separationInScope(actor: HrActor, separationId: string) {
  assertCan(actor, "offboard");
  const s = await prisma.hrSeparation.findUnique({ where: { id: separationId }, include: { employee: true } });
  if (!s) throw new HrError("Separation not found", 404);
  await personInScope(prisma, await resolveScope(actor), s.employeeId);
  return s;
}

export async function separationNotice(actor: HrActor, separationId: string, b: Record<string, unknown>) {
  const mode = modeOf(b);
  const s = await separationInScope(actor, separationId);
  assertNotSelf(actor, s.employee, "send the end-of-service notice");
  if (s.status === "CANCELLED") throw new HrError("This end of service was cancelled; no notice is sent.", 409, "SEPARATION_CANCELLED");
  const note = text(b.note, "note", { max: 1000 });
  const useCompany = b.useCompanyEmail === true;
  const [personal, work, c] = await Promise.all([
    recipientFor(prisma, { hrEmployeeId: s.employeeId }, "hr_separation"),
    recipientFor(prisma, { hrEmployeeId: s.employeeId }, "system"),
    // The checklist reference: the clearance items as the separation flow computes them (names and done / open only).
    s.status === "INITIATED" ? clearance(actor, separationId) : Promise.resolve(null),
  ]);
  const checklist = c ? c.items.map((i) => ({ key: i.key, ok: i.ok })) : ["ASSETS", "ADVANCES", "PENDING_LEAVE"].map((key) => ({ key, ok: true }));
  const rendered = renderSeparationNotice({
    company: await company(), employeeName: s.employee.fullNameAr, employeeNo: s.employee.employeeNo, type: s.type,
    noticeDate: dayString(s.noticeDate), lastWorkingDay: dayString(s.lastWorkingDay), reference: separationReference(s.employee.employeeNo, s.id),
    checklist, contactName: await nameOf(actor.id), note,
  });
  const channel: "personal" | "company" | null = personal.email ? "personal" : work.email ? "company" : null;
  const preview = {
    configured: emailConfigured(),
    recipient: {
      channel,
      // Masked: the personal e-mail is private data and this screen is not a private-data view.
      email: channel === "personal" ? maskEmail(personal.email) : channel === "company" ? work.email : null,
      needsConfirmation: channel === "company",
      missing: personal.email ? null : (personal as { reason: MissingReason }).reason,
    },
    reference: separationReference(s.employee.employeeNo, s.id),
    amountsIncluded: false,
    subject: rendered.subject, html: rendered.html, text: rendered.text, version: rendered.version,
  };
  if (mode === "preview") return preview;
  if (channel === "company" && !useCompany) {
    throw new HrError("This person has no personal e-mail on record. Confirm sending the notice to the company e-mail instead.", 409, "CONFIRM_COMPANY_EMAIL");
  }
  const to = channel === "personal" ? personal.email : channel === "company" ? work.email : null;
  const status = await deliver(to, rendered);
  await audit(prisma, {
    action: "EMAIL_SEPARATION_NOTICE", entityType: "HrSeparation", entityId: separationId, employeeId: s.employeeId,
    after: { status, version: rendered.version, to: maskEmail(to), channel, noteChars: note?.length ?? 0 },
    reason: `${STATUS_AR[status]}${to ? ` · ${channel === "personal" ? "البريد الشخصي" : "بريد الشركة"} ${maskEmail(to)}` : ""}`, actorId: actor.id,
  });
  return { ...preview, status, log: await logOf("HrSeparation", separationId, "EMAIL_SEPARATION_NOTICE") };
}

export async function separationNoticeLog(actor: HrActor, separationId: string) {
  await separationInScope(actor, separationId);
  return { configured: emailConfigured(), log: await logOf("HrSeparation", separationId, "EMAIL_SEPARATION_NOTICE") };
}
