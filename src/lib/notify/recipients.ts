// Who an e-mail goes to — the two addresses a person has, and the one routing helper (owner
// model, feat/credit-hold):
//
//   * Company e-mail («البريد الإلكتروني للشركة» / «بريد الشركة») — ONE source of truth:
//       - an account linked to an HR person → HrEmployee.workEmail (edited in HR, at hiring, or from
//         the user's page, which writes there);
//       - an account with no HR link        → Employee.workEmail (additive, 20261028100000_credit_hold).
//     Unique among active people and accounts, case-insensitively (assertCompanyEmailFree). Every
//     system notification goes here (purpose "system"), the Blob storage alerts included.
//   * Personal e-mail («البريد الشخصي») — HrEmployeePrivate.personalEmail (HR private data: read and
//     written only through the HR private-data permission), and HrApplicant.email for a candidate.
//     The address of HR communications: recruitment, interviews, separation.
//
// recipientFor never invents an address: a missing one is `{ email: null, reason }`, and a screen
// that would send says «لا يوجد بريد مسجّل».
//
// Reading a person's personal e-mail here is a SYSTEM read for sending (no screen shows it); the
// HR screens keep reading it through getPrivate (permission + audit).

import type { Prisma as PrismaNS, PrismaClient } from "@/generated/prisma/client";

type Db = PrismaClient | PrismaNS.TransactionClient;

export type EmailPurpose = "system" | "hr_recruitment" | "hr_interview" | "hr_separation";
export type RecipientTarget = { accountId: string } | { hrEmployeeId: string } | { applicantId: string };
export type MissingReason = "NOT_FOUND" | "NO_COMPANY_EMAIL" | "NO_PERSONAL_EMAIL" | "NO_APPLICANT_EMAIL" | "NOT_A_PERSON";
export type Recipient =
  | { email: string; source: "hr_work_email" | "account_work_email" | "hr_personal_email" | "applicant_email" }
  | { email: null; reason: MissingReason };

export const NO_EMAIL_AR = "لا يوجد بريد مسجّل";
export const NO_EMAIL_EN = "No e-mail on record";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Trimmed and lower-cased for comparison; null when empty. */
export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.toLowerCase() : null;
}
export function isValidEmail(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v);
}

/** The facts a decision needs — pure, so the routing is asserted without a database. */
export type RecipientFacts =
  | { kind: "account"; found: boolean; hrWorkEmail: string | null; linked: boolean; accountWorkEmail: string | null; personalEmail: string | null }
  | { kind: "person"; found: boolean; hrWorkEmail: string | null; personalEmail: string | null }
  | { kind: "applicant"; found: boolean; email: string | null };

export function pickRecipient(purpose: EmailPurpose, f: RecipientFacts): Recipient {
  if (!f.found) return { email: null, reason: "NOT_FOUND" };
  const ok = (e: string | null | undefined) => (e && e.trim() ? e.trim() : null);
  if (f.kind === "applicant") {
    if (purpose === "system") return { email: null, reason: "NOT_A_PERSON" };
    const e = ok(f.email);
    return e ? { email: e, source: "applicant_email" } : { email: null, reason: "NO_APPLICANT_EMAIL" };
  }
  if (purpose === "system") {
    if (f.kind === "account" && !f.linked) {
      const e = ok(f.accountWorkEmail);
      return e ? { email: e, source: "account_work_email" } : { email: null, reason: "NO_COMPANY_EMAIL" };
    }
    const e = ok(f.hrWorkEmail);
    return e ? { email: e, source: "hr_work_email" } : { email: null, reason: "NO_COMPANY_EMAIL" };
  }
  const e = ok(f.personalEmail);
  return e ? { email: e, source: "hr_personal_email" } : { email: null, reason: "NO_PERSONAL_EMAIL" };
}

/** The address for `purpose`, or why there is none. */
export async function recipientFor(db: Db, target: RecipientTarget, purpose: EmailPurpose): Promise<Recipient> {
  if ("applicantId" in target) {
    const a = await db.hrApplicant.findUnique({ where: { id: target.applicantId }, select: { email: true } });
    return pickRecipient(purpose, { kind: "applicant", found: !!a, email: a?.email ?? null });
  }
  if ("hrEmployeeId" in target) {
    const p = await db.hrEmployee.findUnique({ where: { id: target.hrEmployeeId }, select: { workEmail: true, private: { select: { personalEmail: true } } } });
    return pickRecipient(purpose, { kind: "person", found: !!p, hrWorkEmail: p?.workEmail ?? null, personalEmail: p?.private?.personalEmail ?? null });
  }
  const e = await db.employee.findUnique({
    where: { id: target.accountId },
    select: { workEmail: true, hrPerson: { select: { workEmail: true, private: { select: { personalEmail: true } } } } },
  });
  return pickRecipient(purpose, {
    kind: "account", found: !!e, linked: !!e?.hrPerson, hrWorkEmail: e?.hrPerson?.workEmail ?? null,
    accountWorkEmail: e?.workEmail ?? null, personalEmail: e?.hrPerson?.private?.personalEmail ?? null,
  });
}

/** An account's company e-mail and where it is kept (the user page's one field). */
export async function companyEmailOf(db: Db, accountId: string): Promise<{ email: string | null; source: "hr" | "account"; hrEmployeeId: string | null } | null> {
  const e = await db.employee.findUnique({ where: { id: accountId }, select: { workEmail: true, hrPerson: { select: { id: true, workEmail: true } } } });
  if (!e) return null;
  return e.hrPerson
    ? { email: e.hrPerson.workEmail, source: "hr", hrEmployeeId: e.hrPerson.id }
    : { email: e.workEmail, source: "account", hrEmployeeId: null };
}

/**
 * Refuse a company e-mail already used by another ACTIVE person or account, case-insensitively.
 * Active = an HR person not SEPARATED, an account that is active (an unlinked one — a linked
 * account's address is its person's). Throws a domain refusal naming who uses it.
 */
export async function assertCompanyEmailFree(db: Db, email: string | null, except: { hrEmployeeId?: string | null; accountId?: string | null } = {}): Promise<void> {
  const n = normalizeEmail(email);
  if (!n) return;
  if (!isValidEmail(n)) {
    throw { _appCode: 400, code: "EMAIL_INVALID", message: "صيغة البريد الإلكتروني غير صحيحة.", errorAr: "صيغة البريد الإلكتروني غير صحيحة.", errorEn: "That e-mail address is not valid." };
  }
  // Serialise the check-then-write of every company address (namespace 7790, a new one).
  await db.$executeRaw`SELECT pg_advisory_xact_lock(7790, 0)`;
  const person = await db.hrEmployee.findFirst({
    where: { workEmail: { equals: n, mode: "insensitive" }, status: { not: "SEPARATED" }, ...(except.hrEmployeeId ? { id: { not: except.hrEmployeeId } } : {}) },
    select: { fullNameAr: true, employeeNo: true },
  });
  const account = person ? null : await db.employee.findFirst({
    where: { workEmail: { equals: n, mode: "insensitive" }, active: true, hrPerson: { is: null }, ...(except.accountId ? { id: { not: except.accountId } } : {}) },
    select: { name: true, username: true },
  });
  if (person || account) {
    const who = person ? `${person.fullNameAr} (${person.employeeNo})` : `${account!.name}${account!.username ? ` (${account!.username})` : ""}`;
    throw {
      _appCode: 409, code: "EMAIL_TAKEN",
      message: `بريد الشركة ${n} مستخدم لدى ${who}. لكل شخص بريد شركة خاص به.`,
      errorAr: `بريد الشركة ${n} مستخدم لدى ${who}. لكل شخص بريد شركة خاص به.`,
      errorEn: `The company e-mail ${n} is already used by ${who}. Each person has their own company e-mail.`,
    };
  }
}
