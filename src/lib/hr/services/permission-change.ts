// Owner decision 1b — grants of payroll-sensitive permissions need a SECOND person.
//
// A segregated duty (payroll preparation, approval, payment recording, post-approval
// cancellation, payroll administration, account creation or permission editing) or the admin role
// is never granted by one person. The employees API applies everything else at once — names,
// credentials, other modules, and every REVOCATION — but a grant becomes a PERMISSION_CHANGE
// request (HrConfigChange, migration 20261016140000) that another account editor approves by its
// fingerprint; it is applied in that transaction.
//
// Identity (decision 1: separation by person, not by account). The approver must be:
//   · a different account from the requester AND from the account being changed;
//   · a different PERSON: when accounts are linked to HR person records, the approver's person
//     differs from the requester's and from the subject's.
// The second person's approval of a grant is also the attestation that the account belongs to
// the person it claims — which is what stops one manager from creating extra accounts to hold
// the duties they may not combine. Option A (§12): on top of that, the account must belong to a
// VERIFIED person (../identity), and the requester and the approver are verified people too.
// Credential hashes wait in HrCredentialStage, never in the request row (§13, item 4).
// See docs/hr/SOD.md §11–§13.
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { recordEmployeeAudit, lockEmployeeForAdmin, diffEmployeeChange } from "@/lib/services/employee-audit";
import { HrError, TX, assertFresh, mapDbError } from "../core";
import { assertNoNewPayrollConflicts, sensitiveGrants, type AccountGrant, type ReviewedGrantSub } from "../sod";
import { assertSubjectVerified, assertVerifiedActor, identityOf, samePersonAsAny } from "../identity";
import { credentialVersion } from "@/lib/credential-version";
import { gainedPrivileges, isPrivilegedStored } from "@/lib/auth/privileged";
import { revokeSessions } from "@/lib/auth/session";
import { isSimpleMode } from "@/lib/simple-mode";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: string; permissions: Permissions; authTime?: Date | string };
type AuditCtx = { actorId: string; ipHash: string; userAgent: string | null };

// Option A (owner, 16 Oct) replaces the former HR_SOD_REQUIRE_PERSON_LINK switch: a grant goes
// only to a login of a VERIFIED person (../identity), checked at request and again at approval,
// and the requester and the approver are themselves verified. The approver still attests.
export const ATTESTATION_TEXT = "I confirm this account belongs to a distinct person.";
export const ATTESTATION_TEXT_AR = "أؤكد أن هذا الحساب يخص شخصًا مختلفًا";

const canEditAccounts = (a: Actor) => hasModuleAccess(a.permissions, "employees") && hasSubPrivilege(a.permissions, "employees", "edit");

/**
 * QA2 P1-B: a credential change (password, PIN, username) or a reactivation of an account that
 * holds a segregated duty or is admin is requested the same way. Only HASHES are kept (bcrypt
 * PIN verifier and password, the keyed PIN selector) — never the secret — and never shown.
 */
const stableJson = (v: unknown): string => JSON.stringify(sortKeys(v));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

export type CredentialChange = { username?: string; pin?: string; pinLookup?: string; password?: string; activate?: true };
export const credentialFields = (c?: CredentialChange | null): string[] =>
  c ? ([c.username !== undefined ? "username" : null, c.pin ? "pin" : null, c.password ? "password" : null, c.activate ? "active" : null].filter(Boolean) as string[]) : [];

/**
 * What the approver signs off against, and what makes a request stale: role, permissions,
 * username, active state, the credential digest, the linked person and its live verification
 * (QA2: a relink, a credential reset or a revoked verification after the request makes it stale).
 */
export async function subjectState(db: Tx | typeof prisma, accountId: string) {
  const e = await db.employee.findUniqueOrThrow({ where: { id: accountId }, select: { role: true, permissions: true, username: true, active: true, pin: true, password: true } });
  const id = await identityOf(db, accountId);
  return { role: e.role, permissions: (e.permissions as string | null) ?? null, username: e.username ?? null, active: e.active, cv: credentialVersion({ id: accountId, ...e }), personId: id.person?.id ?? null, personType: id.person?.type ?? null, verificationId: id.verified ? id.verification?.id ?? null : null };
}

export function permissionFingerprint(accountId: string, desired: AccountGrant, credentials: CredentialChange | null, before: unknown): string {
  return createHash("sha256").update(JSON.stringify({ kind: "PERMISSION_CHANGE", accountId, desired: { role: desired.role, permissions: desired.permissions }, credentials: credentials ?? null, before })).digest("hex").slice(0, 24);
}

/**
 * Inside the employees API transaction: record the sensitive part of a change as a request —
 * a grant, and/or a credential change or reactivation of a duty-holding account. Called AFTER
 * the immediate part is written, so `before` is the account as it then stands.
 */
export async function requestPermissionChangeIn(tx: Tx, a: { actorId: string; accountId: string; accountName: string; desired: AccountGrant; before: AccountGrant; reason: string; credentials?: CredentialChange | null; confirmSubs?: ReviewedGrantSub[] }) {
  const granted = sensitiveGrants(a.desired, a.before);
  // A CONFIRMATION of reviewed subs the account already holds (inventory Option A, legacy one-editor
  // grants): they are named in `subs` like a grant, so the approver reviews them and the approval is
  // recorded as evidence; `confirms` says they were held already (nothing changes on approval).
  const confirms = (a.confirmSubs ?? []).filter((k) => !granted.subs.includes(k));
  const g = { ...granted, subs: [...granted.subs, ...confirms] };
  // Option A: the requester is a verified person, and a grant goes only to a verified person.
  await assertVerifiedActor({ id: a.actorId }, "PERMISSION_CHANGE_REQUEST", tx);
  // Owner decision (16 Oct): any privileged permission newly requested, too.
  if (g.duties.length || g.toAdmin || g.subs.length || gainedPrivileges(a.desired, a.before).length) await assertSubjectVerified(tx, a.accountId);
  // Owner security decision: granting a privileged permission to an account with no username is
  // refused — a privileged account signs in with username + PIN (or password), never a PIN alone.
  if (isPrivilegedStored(a.desired.permissions, a.desired.role)) {
    const finalUsername = a.credentials?.username !== undefined ? a.credentials.username : (await tx.employee.findUniqueOrThrow({ where: { id: a.accountId }, select: { username: true } })).username;
    if (!finalUsername) throw new HrError("A privileged account needs a username: it signs in with username and PIN.", 400, "USERNAME_REQUIRED");
  }
  const fields = credentialFields(a.credentials);
  const state = await subjectState(tx, a.accountId);
  // Review item 4: the payload (immutable) keeps the field NAMES only; the hashes and the new
  // username wait in HrCredentialStage, deleted when the request is decided or withdrawn.
  const cred = a.credentials ?? null;
  const payload = { accountId: a.accountId, accountName: a.accountName, role: a.desired.role, permissions: a.desired.permissions, grants: g.duties, subs: g.subs, confirms, toAdmin: g.toAdmin, credentials: cred?.activate ? { activate: true } : null, credentialFields: fields };
  try {
    const row = await tx.hrConfigChange.create({
      data: { kind: "PERMISSION_CHANGE", targetKey: `ACCOUNT:${a.accountId}`, payload: payload as Prisma.InputJsonValue, before: state as Prisma.InputJsonValue, fingerprint: permissionFingerprint(a.accountId, a.desired, a.credentials ?? null, confirms.length ? { ...state, confirms } : state), reason: a.reason, requestedBy: a.actorId },
    });
    if (cred && (cred.username !== undefined || cred.pin || cred.password)) await tx.hrCredentialStage.create({ data: { configChangeId: row.id, username: cred.username ?? null, pin: cred.pin && cred.pinLookup ? cred.pin : null, pinLookup: cred.pin && cred.pinLookup ? cred.pinLookup : null, password: cred.password ?? null } });
    // Field NAMES only — no hash or secret in the audit trail.
    await tx.hrAuditLog.create({ data: { action: "CONFIG_CHANGE_REQUEST", entityType: "HrConfigChange", entityId: row.id, after: { kind: "PERMISSION_CHANGE", accountId: a.accountId, grants: g.duties, subs: g.subs, confirms, toAdmin: g.toAdmin, credentialFields: fields, fingerprint: row.fingerprint }, reason: a.reason, actorId: a.actorId } });
    return { id: row.id, fingerprint: row.fingerprint, grants: g.duties, subs: g.subs, confirms, toAdmin: g.toAdmin, credentialFields: fields };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new HrError("A permission change for this account is already waiting for approval. Decide or withdraw it first.", 409, "CONFIG_PENDING");
    throw e;
  }
}

/** Approve (apply) or reject a pending grant. The approver is another account editor and another person. */
export async function decidePermissionChange(actor: Actor, id: string, b: Record<string, unknown>, ctx: AuditCtx) {
  if (!canEditAccounts(actor)) throw new HrError("Insufficient permissions", 403, "FORBIDDEN");
  assertFresh(actor);
  const decision = b.decision === "APPROVE" || b.decision === "REJECT" ? b.decision : null;
  if (!decision) throw new HrError("decision must be APPROVE or REJECT.", 400);
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
  if (decision === "REJECT" && note.length < 3) throw new HrError("A reason is required to reject.", 400);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "HrConfigChange" WHERE "id" = ${id} FOR UPDATE`;
      const c = await tx.hrConfigChange.findUnique({ where: { id } });
      if (!c || c.kind !== "PERMISSION_CHANGE") throw new HrError("Configuration change not found", 404);
      if (c.status !== "PENDING") throw new HrError(`Only a pending change can be decided (this one is ${c.status}).`, 409);
      const p = c.payload as { accountId: string; accountName: string; role: string; permissions: string; grants: string[]; subs?: string[]; toAdmin: boolean; credentials: CredentialChange | null; credentialFields?: string[] };
      // Identity: never the requester, never the account itself — by account and by person.
      // SIMPLE MODE: a single owner may decide their own request / act on their own record.
      if (!isSimpleMode() && (c.requestedBy === actor.id)) throw new HrError("You requested this change; another account editor must decide it.", 403, "SELF_ACTION");
      // SIMPLE MODE: a single owner may decide their own request / act on their own record.
      if (!isSimpleMode() && (p.accountId === actor.id)) throw new HrError("Nobody approves a grant to their own account.", 403, "SELF_ACTION");
      if (await samePersonAsAny(tx, [c.requestedBy, p.accountId], actor.id)) throw new HrError("You are the same person as the requester or the account holder; another person must decide it.", 403, "SAME_PERSON");
      const now = new Date();
      if (decision === "REJECT") {
        const row = await tx.hrConfigChange.update({ where: { id }, data: { status: "REJECTED", decidedBy: actor.id, decidedAt: now, decisionNote: note } });
        await tx.hrCredentialStage.deleteMany({ where: { configChangeId: id } });
        await tx.hrAuditLog.create({ data: { action: "CONFIG_CHANGE_REJECT", entityType: "HrConfigChange", entityId: id, after: { kind: "PERMISSION_CHANGE", accountId: p.accountId }, reason: note, actorId: actor.id } });
        return { id: row.id, status: row.status, applied: false };
      }
      const expected = typeof b.expected === "string" ? b.expected : "";
      if (!expected) throw new HrError("expected must name the change you reviewed (its fingerprint).", 400);
      if (expected !== c.fingerprint) throw new HrError("This is not the change you reviewed. Reload it and review it again.", 409, "CONFIG_CHANGED");
      // The approver attests who holds the account. Accepts `attested` or `attest`; required for
      // every grant, on top of the subject's verified identity.
      if (b.attested !== true && b.attest !== true) throw new HrError("Confirm that this account belongs to a distinct person (attest) before approving.", 400, "ATTESTATION_REQUIRED");
      await assertVerifiedActor(actor, "PERMISSION_CHANGE_DECIDE", tx);
      if (p.grants.length || p.toAdmin || (p.subs?.length ?? 0) > 0 || gainedPrivileges({ permissions: p.permissions, role: p.role }, { permissions: c.before ? ((c.before as { permissions: string | null }).permissions ?? null) : null, role: c.before ? (c.before as { role: string }).role : p.role }).length) await assertSubjectVerified(tx, p.accountId);
      const subject = await identityOf(tx, p.accountId);
      if (!(await lockEmployeeForAdmin(tx, p.accountId))) throw new HrError("Employee not found", 404);
      const cur = await tx.employee.findUniqueOrThrow({ where: { id: p.accountId }, select: { role: true, active: true, permissions: true, name: true } });
      // Stale when anything the approver signed off against changed: grant, credentials, username,
      // active state or the linked person.
      // Compared key-order-independently: jsonb does not keep the order an object was written in.
      if (stableJson(await subjectState(tx, p.accountId)) !== stableJson(c.before)) throw new HrError("The setting changed after this request was made, so it is stale. Withdraw it and request again.", 409, "CONFIG_STALE");
      // The SoD pairs still hold at approval time (DutyConflictError → 409).
      const duties = assertNoNewPayrollConflicts({ permissions: p.permissions, role: p.role }, { permissions: cur.permissions as string, role: cur.role });
      // The staged hashes (review item 4); `credentials` in the payload carries only `activate`
      // (a request made before the stage existed may still carry them there).
      const stage = await tx.hrCredentialStage.findUnique({ where: { configChangeId: id } });
      const cred: CredentialChange = { ...(p.credentials ?? {}) };
      const currentUsername = (await tx.employee.findUniqueOrThrow({ where: { id: p.accountId }, select: { username: true } })).username;
      if (stage) {
        if (p.credentialFields?.includes("username")) cred.username = stage.username as string;
        if (stage.pin && stage.pinLookup) Object.assign(cred, { pin: stage.pin, pinLookup: stage.pinLookup });
        if (stage.password) cred.password = stage.password;
      }
      const missing = (p.credentialFields ?? []).filter((f) => f !== "active").some((f) => (f === "username" ? cred.username === undefined : !cred[f as "pin" | "password"]));
      if (missing) throw new HrError("The setting changed after this request was made, so it is stale. Withdraw it and request again.", 409, "CONFIG_STALE");
      // Owner security decision: a privileged account has a username (username + PIN sign-in).
      const finalUsername = cred.username !== undefined ? cred.username : currentUsername;
      if (isPrivilegedStored(p.permissions, p.role) && !finalUsername) throw new HrError("A privileged account needs a username: it signs in with username and PIN.", 400, "USERNAME_REQUIRED");
      const updated = await tx.employee.update({
        where: { id: p.accountId },
        data: {
          role: p.role, permissions: p.permissions,
          ...(cred.username !== undefined ? { username: cred.username } : {}),
          ...(cred.pin && cred.pinLookup ? { pin: cred.pin, pinLookup: cred.pinLookup } : {}),
          ...(cred.password ? { password: cred.password } : {}),
          ...(cred.activate ? { active: true } : {}),
        },
        select: { role: true, active: true, permissions: true },
      });
      await tx.hrCredentialStage.deleteMany({ where: { configChangeId: id } });
      // Promotion to privileged: the account's PIN-only sessions end now.
      if (isPrivilegedStored(p.permissions, p.role) && !isPrivilegedStored(cur.permissions as string, cur.role)) await revokeSessions(tx, p.accountId, "PROMOTED_PRIVILEGED", { method: "PIN" });
      // A changed credential changes the account's credential digest: every earlier session ends.
      await tx.hrConfigChange.update({ where: { id }, data: { status: "APPLIED", decidedBy: actor.id, decidedAt: now, decisionNote: `ATTESTED: ${ATTESTATION_TEXT}${note ? ` — ${note}` : ""}`.slice(0, 1000) } });
      await tx.hrAuditLog.create({ data: { action: "CONFIG_CHANGE_APPROVE", entityType: "HrConfigChange", entityId: id, after: { kind: "PERMISSION_CHANGE", accountId: p.accountId, fingerprint: c.fingerprint, credentialFields: p.credentialFields ?? [], sessionsRevoked: !!(cred.username !== undefined || cred.pin || cred.password), attestation: ATTESTATION_TEXT, attestationAr: ATTESTATION_TEXT_AR, attested: true, subjectPerson: subject.person ? { type: subject.person.type, id: subject.person.id } : null, subjectVerificationId: subject.verification?.id ?? null }, reason: note || null, actorId: actor.id } });
      await tx.hrAuditLog.create({ data: { action: "HR_EFFECTIVE_DUTIES_CHANGED", entityType: "Employee", entityId: p.accountId, before: { role: cur.role, duties: duties.before }, after: { role: p.role, duties: duties.after, configChangeId: id, requestedBy: c.requestedBy, approvedBy: actor.id }, actorId: actor.id } });
      const events = diffEmployeeChange({ role: cur.role, active: cur.active, permissions: cur.permissions as string }, { role: updated.role, active: updated.active, permissions: updated.permissions as string }, { pin: !!cred.pin, password: !!cred.password });
      await recordEmployeeAudit(tx, ctx, events.map((e) => ({ action: e.action, targetEmployeeId: p.accountId, targetName: cur.name, metadata: { ...e.metadata, configChangeId: id, requestedBy: c.requestedBy } })));
      return { id, status: "APPLIED", applied: true };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

export async function withdrawPermissionChange(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "HrConfigChange" WHERE "id" = ${id} FOR UPDATE`;
    const c = await tx.hrConfigChange.findUnique({ where: { id } });
    if (!c || c.kind !== "PERMISSION_CHANGE") throw new HrError("Configuration change not found", 404);
    if (c.requestedBy !== actor.id) throw new HrError("Only the person who requested this change can withdraw it.", 403, "NOT_REQUESTER");
    if (c.status !== "PENDING") throw new HrError(`Only a pending change can be withdrawn (this one is ${c.status}).`, 409);
    await tx.hrConfigChange.update({ where: { id }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
    await tx.hrCredentialStage.deleteMany({ where: { configChangeId: id } });
    await tx.hrAuditLog.create({ data: { action: "CONFIG_CHANGE_WITHDRAW", entityType: "HrConfigChange", entityId: id, after: { kind: "PERMISSION_CHANGE" }, actorId: actor.id } });
    return { id, status: "WITHDRAWN" };
  }, TX);
}

/** Pending (or all) permission requests — for account editors. Names and duty keys only. */
export async function listPermissionChanges(actor: Actor, onlyPending: boolean) {
  if (!canEditAccounts(actor)) throw new HrError("Insufficient permissions", 403, "FORBIDDEN");
  const rows = await prisma.hrConfigChange.findMany({ where: { kind: { in: ["PERMISSION_CHANGE", "PERMISSION_REVIEW"] }, ...(onlyPending ? { status: "PENDING" } : {}) }, orderBy: { requestedAt: "desc" }, take: 200 });
  const ids = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter(Boolean) as string[])];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  return rows.map((r) => {
    // Never the credentials themselves (hashes stay server-side): only which fields would change.
    const p = r.payload as { accountId: string; accountName: string; role: string; grants?: string[]; subs?: string[]; confirms?: string[]; toAdmin?: boolean; revoked?: string[]; fromAdmin?: boolean; credentialFields?: string[] };
    return { id: r.id, kind: r.kind, credentialFields: p.credentialFields ?? [], revoked: p.revoked ?? [], fromAdmin: p.fromAdmin ?? false, attestation: r.kind === "PERMISSION_CHANGE" ? ATTESTATION_TEXT : null, status: r.status, fingerprint: r.fingerprint, reason: r.reason, accountId: p.accountId, accountName: p.accountName, role: p.role, grants: p.grants ?? [], subs: p.subs ?? [], confirms: p.confirms ?? [], toAdmin: p.toAdmin ?? false, requestedByName: names.get(r.requestedBy) ?? null, requestedAt: r.requestedAt, decidedByName: r.decidedBy ? names.get(r.decidedBy) ?? null : null, mine: r.requestedBy === actor.id, isSubject: p.accountId === actor.id };
  });
}

// ── Post-hoc review of immediate revocations (orchestrator ruling on decision 1b) ─────────

/**
 * A revocation applies at once — removing access never waits — and leaves a PERMISSION_REVIEW
 * item that a different account editor (another login AND another person than the one who
 * revoked and the account itself) acknowledges afterwards. It never blocks anything; until it
 * is acknowledged the conflicts report lists it.
 */
export async function recordRevocationReviewIn(tx: Tx, a: { actorId: string; accountId: string; accountName: string; revoked: string[]; fromAdmin: boolean; before: AccountGrant; after: AccountGrant }) {
  const payload = { accountId: a.accountId, accountName: a.accountName, revoked: a.revoked, fromAdmin: a.fromAdmin, role: a.after.role };
  const row = await tx.hrConfigChange.create({
    data: { kind: "PERMISSION_REVIEW", targetKey: `REVIEW:${a.accountId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, payload: payload as Prisma.InputJsonValue, before: { role: a.before.role, permissions: a.before.permissions } as Prisma.InputJsonValue, fingerprint: createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24), reason: "Immediate revocation — post-hoc review", requestedBy: a.actorId },
  });
  await tx.hrAuditLog.create({ data: { action: "PERMISSION_REVOKED_PENDING_REVIEW", entityType: "HrConfigChange", entityId: row.id, after: { accountId: a.accountId, revoked: a.revoked, fromAdmin: a.fromAdmin }, actorId: a.actorId } });
  return { id: row.id };
}

export async function acknowledgeRevocationReview(actor: Actor, id: string, b: Record<string, unknown>) {
  if (!canEditAccounts(actor)) throw new HrError("Insufficient permissions", 403, "FORBIDDEN");
  assertFresh(actor);
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "HrConfigChange" WHERE "id" = ${id} FOR UPDATE`;
    const c = await tx.hrConfigChange.findUnique({ where: { id } });
    if (!c || c.kind !== "PERMISSION_REVIEW") throw new HrError("Configuration change not found", 404);
    if (c.status !== "PENDING") throw new HrError(`Only a pending change can be decided (this one is ${c.status}).`, 409);
    const p = c.payload as { accountId: string };
    // SIMPLE MODE: a single owner may decide their own request / act on their own record.
    if (!isSimpleMode() && (c.requestedBy === actor.id)) throw new HrError("You requested this change; another account editor must decide it.", 403, "SELF_ACTION");
    // SIMPLE MODE: a single owner may decide their own request / act on their own record.
    if (!isSimpleMode() && (p.accountId === actor.id)) throw new HrError("You cannot review the revocation of your own account.", 403, "SELF_ACTION");
    if (await samePersonAsAny(tx, [c.requestedBy, p.accountId], actor.id)) throw new HrError("You are the same person as the requester or the account holder; another person must decide it.", 403, "SAME_PERSON");
    await assertVerifiedActor(actor, "PERMISSION_REVIEW_ACKNOWLEDGE", tx);
    await tx.hrConfigChange.update({ where: { id }, data: { status: "APPLIED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note || "Reviewed" } });
    await tx.hrAuditLog.create({ data: { action: "PERMISSION_REVOCATION_REVIEWED", entityType: "HrConfigChange", entityId: id, after: { accountId: p.accountId }, reason: note || null, actorId: actor.id } });
    return { id, status: "APPLIED" };
  }, TX);
}
