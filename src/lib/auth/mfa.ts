// Multi-factor authentication for privileged accounts (owner security decision, 16 Oct).
//
//   · Enrollment: a TOTP secret (RFC 6238) is generated and stored ENCRYPTED (AES-256-GCM, key
//     AUTH_MFA_KEY from the environment); the account scans the QR (or types the manual key)
//     and confirms with a first valid code. Only then is it enrolled, and ten one-time recovery
//     codes are shown — once; only their keyed hashes are kept.
//   · After enrollment a code is required at every sign-in and every step-up. Each TOTP code is
//     accepted once (lastStep); a recovery code is used once.
//   · Lost device and codes: an MFA reset is a second-person, attested request (./mfa-reset).
//   · AUTH_MFA_MODE: "enrolled" (default — required once enrolled) or "required" (privileged
//     accounts without enrollment may only enroll; every other API answers 403
//     MFA_ENROLLMENT_REQUIRED). Preview and testing environments enroll first, then switch.
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret, mfaKey, newRecoveryCodes, newSecret, otpauthUri, recoveryHash, verifyTotp } from "./totp";

export type MfaMode = "enrolled" | "required";
export const mfaMode = (): MfaMode => (process.env.AUTH_MFA_MODE === "required" ? "required" : "enrolled");
export const mfaConfigured = () => !!mfaKey();

export async function isEnrolled(employeeId: string): Promise<boolean> {
  return !!(await prisma.authMfa.findUnique({ where: { employeeId }, select: { enrolledAt: true } }))?.enrolledAt;
}

export async function mfaStatus(employeeId: string) {
  const m = await prisma.authMfa.findUnique({ where: { employeeId } });
  const remaining = m?.enrolledAt ? await prisma.authRecoveryCode.count({ where: { employeeId, usedAt: null } }) : 0;
  return { configured: mfaConfigured(), mode: mfaMode(), enrolled: !!m?.enrolledAt, enrolledAt: m?.enrolledAt ?? null, pending: !!m && !m.enrolledAt, recoveryCodesRemaining: remaining };
}

export class MfaError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly messageAr: string = message) { super(message); }
}

/** Start (or restart) enrollment: a new secret, not yet active. Returns what the app needs to show. */
export async function startEnrollment(employeeId: string, accountLabel: string) {
  const key = mfaKey();
  if (!key) throw new MfaError("Two-step verification is not configured on this server.", 503, "MFA_NOT_CONFIGURED", "التحقق بخطوتين غير مهيأ على هذا الخادم.");
  if (await isEnrolled(employeeId)) throw new MfaError("Two-step verification is already enabled for this account.", 409, "MFA_ALREADY_ENROLLED", "التحقق بخطوتين مفعّل لهذا الحساب أصلًا.");
  const secret = newSecret();
  await prisma.authMfa.upsert({ where: { employeeId }, create: { employeeId, secretEnc: encryptSecret(secret, key) }, update: { secretEnc: encryptSecret(secret, key), enrolledAt: null, lastStep: null } });
  return { secret, otpauth: otpauthUri(secret, accountLabel) };
}

/** Confirm enrollment with a first valid code; returns the recovery codes (shown once). */
export async function confirmEnrollment(employeeId: string, code: string): Promise<string[]> {
  const key = mfaKey();
  if (!key) throw new MfaError("Two-step verification is not configured on this server.", 503, "MFA_NOT_CONFIGURED", "التحقق بخطوتين غير مهيأ على هذا الخادم.");
  const m = await prisma.authMfa.findUnique({ where: { employeeId } });
  if (!m || m.enrolledAt) throw new MfaError("Start the enrollment first.", 409, "MFA_NOT_PENDING", "ابدأ التفعيل أولًا.");
  const step = verifyTotp(decryptSecret(m.secretEnc, key), String(code ?? "").trim(), Date.now(), null);
  if (step === null) throw new MfaError("The verification code is not valid.", 400, "MFA_CODE_INVALID", "رمز التحقق غير صحيح.");
  const codes = newRecoveryCodes();
  await prisma.$transaction(async (tx) => {
    await tx.authMfa.update({ where: { employeeId }, data: { enrolledAt: new Date(), lastStep: step } });
    await tx.authRecoveryCode.deleteMany({ where: { employeeId } });
    await tx.authRecoveryCode.createMany({ data: codes.map((c) => ({ employeeId, codeHash: recoveryHash(c, key) })) });
  });
  return codes;
}

/**
 * Check a second-factor answer for an enrolled account: a 6-digit TOTP code (each step once) or
 * a recovery code (each once). Returns how it was satisfied, or null.
 */
export async function verifySecondFactor(employeeId: string, answer: string): Promise<"TOTP" | "RECOVERY" | null> {
  const key = mfaKey();
  const m = await prisma.authMfa.findUnique({ where: { employeeId } });
  if (!key || !m?.enrolledAt) return null;
  const a = String(answer ?? "").trim();
  if (/^\d{6}$/.test(a)) {
    const step = verifyTotp(decryptSecret(m.secretEnc, key), a, Date.now(), m.lastStep);
    if (step === null) return null;
    // Conditional write: two concurrent uses of one code cannot both pass.
    const r = await prisma.authMfa.updateMany({ where: { employeeId, OR: [{ lastStep: null }, { lastStep: { lt: step } }] }, data: { lastStep: step } });
    return r.count === 1 ? "TOTP" : null;
  }
  const hash = recoveryHash(a, key);
  const r = await prisma.authRecoveryCode.updateMany({ where: { employeeId, codeHash: hash, usedAt: null }, data: { usedAt: new Date() } });
  return r.count === 1 ? "RECOVERY" : null;
}
