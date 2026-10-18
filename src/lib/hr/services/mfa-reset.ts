// Owner security decision (16 Oct): a privileged account that lost both its authenticator and
// its recovery codes is reset by a SECOND person, never by itself.
//
//   · Request (MFA_RESET on HrConfigChange, migration 20261016180000): an account editor who is
//     a verified person asks to reset another account's two-step verification, with a reason.
//     Nobody requests a reset of their own account.
//   · Decision: another account editor — another login AND another person than the requester
//     and the account holder, themself verified, with a recent strong authentication (step-up)
//     — attests that they confirmed the holder's identity out of band, and approves the exact
//     fingerprint. A request is stale when the account's MFA state changed since.
//   · Apply: the TOTP secret and every recovery code are deleted and EVERY session of the
//     account is revoked; the holder enrolls again at their next sign-in.
// Each step is audited (HrAuditLog and AuthAuditLog). No credential or link is changed here,
// so a reset never bypasses identity verification.
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { HrError, TX, assertFresh, audit, accountNames, mapDbError } from "../core";
import { assertVerifiedActor, identityOfMany, samePersonAsAny } from "../identity";
import { revokeSessions } from "@/lib/auth/session";
import { isPrivilegedStored, privilegeReasons } from "@/lib/auth/privileged";
import { effectivePermissions } from "../sod";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: string; permissions: Permissions; authTime?: Date | string };

export const MFA_RESET_ATTESTATION_EN = "I confirmed out of band that the account holder is asking for this reset, and checked their identity.";
export const MFA_RESET_ATTESTATION_AR = "تأكدت بوسيلة مستقلة أن صاحب الحساب هو من يطلب إعادة التعيين، وتحققت من هويته.";

const canEditAccounts = (a: Actor) => hasModuleAccess(a.permissions, "employees") && hasSubPrivilege(a.permissions, "employees", "edit");
function assertEditor(a: Actor) {
  if (!canEditAccounts(a)) throw new HrError("Insufficient permissions", 403, "FORBIDDEN");
}

/** What the approver signs off against: the account's MFA state (stale check). */
async function mfaState(db: Tx | typeof prisma, accountId: string) {
  const m = await db.authMfa.findUnique({ where: { employeeId: accountId }, select: { enrolledAt: true, createdAt: true } });
  const codes = await db.authRecoveryCode.count({ where: { employeeId: accountId, usedAt: null } });
  return { accountId, enrolledAt: m?.enrolledAt?.toISOString() ?? null, createdAt: m?.createdAt.toISOString() ?? null, recoveryCodesRemaining: codes };
}
// Compared key-order-independently: jsonb does not keep the order an object was written in.
const stableJson = (v: unknown): string => JSON.stringify(sortKeys(v));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
const fingerprintOf = (accountId: string, before: unknown) => createHash("sha256").update(JSON.stringify({ kind: "MFA_RESET", accountId, before })).digest("hex").slice(0, 24);

async function authAuditTx(tx: Tx, e: { userId: string; action: string; reasonCode?: string; metadata?: Record<string, unknown> }) {
  await tx.authAuditLog.create({ data: { userId: e.userId, action: e.action, result: "SUCCESS", ipHash: "internal", reasonCode: e.reasonCode ?? null, metadata: (e.metadata ?? undefined) as never } });
}

export async function requestMfaReset(actor: Actor, b: Record<string, unknown>) {
  assertEditor(actor);
  const accountId = typeof b.accountId === "string" ? b.accountId : "";
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  if (!accountId) throw new HrError("accountId is required.", 400);
  if (reason.length < 3) throw new HrError("A reason is required.", 400);
  if (accountId === actor.id) throw new HrError("Nobody resets their own two-step verification; another account editor must request it.", 403, "SELF_ACTION");
  try {
    return await prisma.$transaction(async (tx) => {
      await assertVerifiedActor(actor, "MFA_RESET_REQUEST", tx);
      // Re-test AUTH-F: never requested by the holder's own person under another login (current
      // links, link history, shared identity number) — refused at request, not only at decision.
      if (await samePersonAsAny(tx, [accountId], actor.id)) throw new HrError("You are the same person as the account holder; another person must request it.", 403, "SAME_PERSON");
      const acc = await tx.employee.findUnique({ where: { id: accountId }, select: { id: true, name: true } });
      if (!acc) throw new HrError("Employee not found", 404);
      const before = await mfaState(tx, accountId);
      if (!before.enrolledAt && !before.createdAt) throw new HrError("This account has no two-step verification to reset.", 409, "MFA_NOT_ENROLLED");
      const fingerprint = fingerprintOf(accountId, before);
      const row = await tx.hrConfigChange.create({ data: { kind: "MFA_RESET", targetKey: `MFA:${accountId}`, payload: { accountId, accountName: acc.name } as Prisma.InputJsonValue, before: before as Prisma.InputJsonValue, fingerprint, reason, requestedBy: actor.id } });
      await audit(tx, { action: "CONFIG_CHANGE_REQUEST", entityType: "HrConfigChange", entityId: row.id, after: { kind: "MFA_RESET", accountId, fingerprint }, reason, actorId: actor.id });
      await authAuditTx(tx, { userId: accountId, action: "MFA_RESET_REQUESTED", metadata: { configChangeId: row.id, requestedBy: actor.id } });
      return { id: row.id, fingerprint, status: "PENDING" };
    }, TX);
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new HrError("An MFA reset for this account is already waiting for a decision.", 409, "CONFIG_PENDING");
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

export async function decideMfaReset(actor: Actor, id: string, b: Record<string, unknown>) {
  assertEditor(actor);
  assertFresh(actor);
  const decision = b.decision === "APPROVE" || b.decision === "REJECT" ? b.decision : null;
  if (!decision) throw new HrError("decision must be APPROVE or REJECT.", 400);
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
  if (decision === "REJECT" && note.length < 3) throw new HrError("A reason is required to reject.", 400);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "HrConfigChange" WHERE "id" = ${id} FOR UPDATE`;
      const c = await tx.hrConfigChange.findUnique({ where: { id } });
      if (!c || c.kind !== "MFA_RESET") throw new HrError("Configuration change not found", 404);
      if (c.status !== "PENDING") throw new HrError(`Only a pending change can be decided (this one is ${c.status}).`, 409);
      const p = c.payload as { accountId: string };
      if (c.requestedBy === actor.id) throw new HrError("You requested this change; another account editor must decide it.", 403, "SELF_ACTION");
      if (p.accountId === actor.id) throw new HrError("Nobody decides a reset of their own two-step verification.", 403, "SELF_ACTION");
      if (await samePersonAsAny(tx, [c.requestedBy, p.accountId], actor.id)) throw new HrError("You are the same person as the requester or the account holder; another person must decide it.", 403, "SAME_PERSON");
      const now = new Date();
      if (decision === "REJECT") {
        await tx.hrConfigChange.update({ where: { id }, data: { status: "REJECTED", decidedBy: actor.id, decidedAt: now, decisionNote: note } });
        await audit(tx, { action: "CONFIG_CHANGE_REJECT", entityType: "HrConfigChange", entityId: id, after: { kind: "MFA_RESET", accountId: p.accountId }, reason: note, actorId: actor.id });
        return { id, status: "REJECTED", applied: false };
      }
      const expected = typeof b.expected === "string" ? b.expected : "";
      if (!expected) throw new HrError("expected must name the change you reviewed (its fingerprint).", 400);
      if (expected !== c.fingerprint) throw new HrError("This is not the change you reviewed. Reload it and review it again.", 409, "CONFIG_CHANGED");
      if (b.attested !== true && b.attest !== true) throw new HrError("Confirm that you checked the account holder's identity (attest) before approving.", 400, "ATTESTATION_REQUIRED");
      await assertVerifiedActor(actor, "MFA_RESET_DECIDE", tx);
      if (stableJson(await mfaState(tx, p.accountId)) !== stableJson(c.before)) throw new HrError("The setting changed after this request was made, so it is stale. Withdraw it and request again.", 409, "CONFIG_STALE");
      // Apply: the factor and its codes go, and every session of the account ends.
      await tx.authRecoveryCode.deleteMany({ where: { employeeId: p.accountId } });
      await tx.authMfa.deleteMany({ where: { employeeId: p.accountId } });
      const sessionsRevoked = await revokeSessions(tx, p.accountId, "MFA_RESET");
      await tx.hrConfigChange.update({ where: { id }, data: { status: "APPLIED", decidedBy: actor.id, decidedAt: now, decisionNote: `ATTESTED: ${MFA_RESET_ATTESTATION_EN}${note ? ` — ${note}` : ""}`.slice(0, 1000) } });
      await audit(tx, { action: "CONFIG_CHANGE_APPROVE", entityType: "HrConfigChange", entityId: id, after: { kind: "MFA_RESET", accountId: p.accountId, fingerprint: c.fingerprint, attestation: MFA_RESET_ATTESTATION_EN, attestationAr: MFA_RESET_ATTESTATION_AR, attested: true, sessionsRevoked }, reason: note || null, actorId: actor.id });
      await authAuditTx(tx, { userId: p.accountId, action: "MFA_RESET_APPLIED", reasonCode: "SECOND_PERSON", metadata: { configChangeId: id, requestedBy: c.requestedBy, approvedBy: actor.id, sessionsRevoked } });
      return { id, status: "APPLIED", applied: true, sessionsRevoked };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

export async function withdrawMfaReset(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "HrConfigChange" WHERE "id" = ${id} FOR UPDATE`;
    const c = await tx.hrConfigChange.findUnique({ where: { id } });
    if (!c || c.kind !== "MFA_RESET") throw new HrError("Configuration change not found", 404);
    if (c.requestedBy !== actor.id) throw new HrError("Only the person who requested this change can withdraw it.", 403, "NOT_REQUESTER");
    if (c.status !== "PENDING") throw new HrError(`Only a pending change can be withdrawn (this one is ${c.status}).`, 409);
    await tx.hrConfigChange.update({ where: { id }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
    await audit(tx, { action: "CONFIG_CHANGE_WITHDRAW", entityType: "HrConfigChange", entityId: id, after: { kind: "MFA_RESET" }, actorId: actor.id });
    return { id, status: "WITHDRAWN" };
  }, TX);
}

/** Pending and recent MFA resets, for account editors. */
export async function listMfaResets(actor: Actor) {
  assertEditor(actor);
  const rows = await prisma.hrConfigChange.findMany({ where: { kind: "MFA_RESET" }, orderBy: { requestedAt: "desc" }, take: 50 });
  const names = await accountNames(prisma, rows.flatMap((r) => [r.requestedBy, r.decidedBy].filter((x): x is string => !!x)));
  return rows.map((r) => ({ id: r.id, status: r.status, fingerprint: r.fingerprint, reason: r.reason, accountId: (r.payload as { accountId: string }).accountId, accountName: (r.payload as { accountName?: string }).accountName ?? null, requestedBy: r.requestedBy, requestedByName: names.get(r.requestedBy) ?? null, requestedAt: r.requestedAt, decidedBy: r.decidedBy, decidedByName: r.decidedBy ? names.get(r.decidedBy) ?? null : null, decidedAt: r.decidedAt, decisionNote: r.decisionNote, mine: r.requestedBy === actor.id }));
}

/**
 * The MFA report: every active privileged account, why it is privileged, whether it has a
 * username and whether two-step verification is enrolled — so an administrator can see who must
 * still enroll before AUTH_MFA_MODE=required is switched on.
 */
export async function mfaReport(actor: Actor) {
  assertEditor(actor);
  const accounts = await prisma.employee.findMany({ where: { active: true }, select: { id: true, name: true, username: true, role: true, permissions: true }, orderBy: { name: "asc" } });
  const privileged = accounts.filter((a) => isPrivilegedStored(a.permissions as string | null, a.role));
  const mfa = await prisma.authMfa.findMany({ where: { employeeId: { in: privileged.map((a) => a.id) } }, select: { employeeId: true, enrolledAt: true } });
  const enrolled = new Map(mfa.map((m) => [m.employeeId, m.enrolledAt]));
  // Owner decision (16 Oct): a privileged permission is exercised only by an individual account
  // (a verified person). Holders that are not keep it, but are BLOCKED until verified — listed here.
  const ids = await identityOfMany(prisma, privileged.map((a) => a.id));
  const rows = privileged.map((a) => ({ id: a.id, name: a.name, username: a.username ?? null, role: a.role, reasons: privilegeReasons(effectivePermissions(a.permissions as string | null, a.role), a.role), mfaEnrolled: !!enrolled.get(a.id), mfaEnrolledAt: enrolled.get(a.id) ?? null, verified: !!ids.get(a.id)?.verified, blocked: !ids.get(a.id)?.verified }));
  return { mode: process.env.AUTH_MFA_MODE === "required" ? "required" : "enrolled", privilegedCount: rows.length, unenrolledCount: rows.filter((r) => !r.mfaEnrolled).length, withoutUsernameCount: rows.filter((r) => !r.username).length, blockedCount: rows.filter((r) => r.blocked).length, accounts: rows };
}
