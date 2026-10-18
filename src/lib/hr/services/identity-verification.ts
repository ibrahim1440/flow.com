// Owner decision 1, Option A (16 Oct) — verified person identity, by a SECOND person.
//
// Two request kinds on HrConfigChange (enum values from migration 20261016160000):
//   · PERSON_VERIFY — an account editor asks that a person (an HR employee or an external
//     person) be verified; another account editor — another login AND another person than the
//     requester and the person verified, and themself verified — checks the identity document,
//     attests, and approves the exact fingerprint. The approval writes the HrIdentityVerification
//     row. For an employee whose existing duty-holding login is not linked yet, the request can
//     name that login: the approval links it in the same transaction (the only way such a login
//     is linked, since a direct link of a duty-holding login is refused).
//   · EXTERNAL_PERSON_CHANGE — create, edit, link a login to, unlink or deactivate an external
//     person (e.g. an outside accountant). Never an employee record, never on payroll, never a
//     payee. Editing a name or identity number, or deactivating, revokes the verification.
// Requests, decisions and applications are audited; a request is stale (refused) when the
// person's record changed after it was made.
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { HrError, TX, assertFresh, audit, accountNames, lock, mapDbError, text, reqText, oneOf } from "../core";
import { effectivePermissions, payrollDuties } from "../sod";
import { ID_NORM_VALID, idNumberValid, IDENTITY_DECISION_LOCK, revokeLoginAttestations, personsOf, externalKey, assertVerifiedActor, dbNormId, identityOf, identityOfMany, idDigest, liveVerification, maskId, normalizeName, revokeVerification, samePersonAsAny, verificationBootstrap, type PersonType } from "../identity";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: string; permissions: Permissions; authTime?: Date | string };

export const VERIFY_ATTESTATION_EN = "I checked this person's identity against an original identity document, and the login belongs to this person and no one else.";
export const VERIFY_ATTESTATION_AR = "تحققت من هوية هذا الشخص من وثيقة هوية أصلية، والحساب يخصّه وحده دون غيره.";
export const EXTERNAL_ATTESTATION_EN = "I confirm these details identify one real person who is not an employee, and that the login belongs to that person only.";
export const EXTERNAL_ATTESTATION_AR = "أؤكد أن هذه البيانات تخص شخصًا حقيقيًا واحدًا ليس موظفًا، وأن الحساب يخصّه وحده.";
export const EMPLOYEE_CHANGE_ATTESTATION_EN = "I checked the new identifying details against an original identity document of this same person.";
export const EMPLOYEE_CHANGE_ATTESTATION_AR = "تحققت من بيانات الهوية الجديدة من وثيقة هوية أصلية للشخص نفسه.";

const canEditAccounts = (a: Actor) => hasModuleAccess(a.permissions, "employees") && hasSubPrivilege(a.permissions, "employees", "edit");
function assertEditor(a: Actor) {
  if (!canEditAccounts(a)) throw new HrError("Insufficient permissions", 403, "FORBIDDEN");
}
const fp = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
const stableJson = (v: unknown): string => JSON.stringify(sortKeys(v));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/**
 * A verifier is verified — except before the one-time bootstrap is completed (review P1-1: a
 * persisted record, never re-opened by revocations). Bootstrap is still a second person, never
 * the same person as the requester by any link (checked by every decision).
 */
async function assertVerifierIdentity(tx: Tx, actor: Actor, step: string, allowBootstrap = true): Promise<boolean> {
  if (allowBootstrap && (await verificationBootstrap(tx))) return true;
  await assertVerifiedActor(actor, step, tx);
  return false;
}

/** What the approver signs off against for a person (stale check). Identity number as a digest. */
async function personState(db: Tx | typeof prisma, type: PersonType, id: string) {
  if (type === "EMPLOYEE") {
    const e = await db.hrEmployee.findUnique({ where: { id }, select: { id: true, employeeNo: true, fullNameAr: true, fullNameEn: true, status: true, accountId: true, private: { select: { idType: true, idNumber: true } } } });
    if (!e) return null;
    const v = await liveVerification(db, "EMPLOYEE", id);
    return { type, id, ref: e.employeeNo, name: e.fullNameAr, nameEn: e.fullNameEn ?? null, active: e.status !== "SEPARATED", accountId: e.accountId ?? null, idType: e.private?.idType ?? null, idDigest: idDigest(e.private?.idNumber), liveVerificationId: v?.id ?? null, liveVerificationAccountId: v?.accountId ?? null, _idNumber: e.private?.idNumber ?? null };
  }
  const x = await db.hrExternalPerson.findUnique({ where: { id } });
  if (!x) return null;
  const v = await liveVerification(db, "EXTERNAL", id);
  return { type, id, ref: x.organization ?? null, name: x.fullName, nameEn: null, active: x.active, accountId: x.accountId ?? null, idType: null, idDigest: idDigest(x.idNumber), liveVerificationId: v?.id ?? null, liveVerificationAccountId: v?.accountId ?? null, organization: x.organization ?? null, roleNote: x.roleNote ?? null, _idNumber: x.idNumber ?? null };
}
const publicState = <T extends { _idNumber?: unknown } | null>(s: T) => {
  if (!s) return null;
  const { _idNumber, ...rest } = s as { _idNumber?: unknown } & Record<string, unknown>;
  void _idNumber;
  return rest;
};

/** A login that may be linked: exists and is linked to nobody (employee or external). */
async function assertLoginFree(tx: Tx, accountId: string) {
  const acc = await tx.employee.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!acc) throw new HrError("Login account not found.", 400);
  const [e, x] = await Promise.all([tx.hrEmployee.findUnique({ where: { accountId }, select: { id: true } }), tx.hrExternalPerson.findUnique({ where: { accountId }, select: { id: true } })]);
  if (e || x) throw new HrError("This login is already linked to another person.", 409, "ACCOUNT_TAKEN");
}

/**
 * One human, one person record (review P1-2, P2-3): an identity number whose NORMAL FORM (the
 * database's hr_norm_id — the same column every guard compares) is already on another employee
 * record or another external person is refused. The database guards refuse it too; this gives
 * the named, coded answer first.
 */
export async function assertIdNumberFree(tx: Tx, idNumber: string | null | undefined, self: { employeeId?: string | null; externalId?: string | null } = {}) {
  const norm = await dbNormId(tx, idNumber);
  // Review NEW-3: an ambiguous number is refused, never folded into another.
  if (!idNumberValid(idNumber) || (norm && !ID_NORM_VALID.test(norm))) throw new HrError("The identity number may contain only Latin letters A-Z and digits 0-9 (spaces, dashes and dots are ignored).", 400, "IDENTITY_NUMBER_INVALID");
  if (!norm) return;
  const emp = await tx.$queryRaw<{ employeeNo: string; id: string }[]>`SELECT e."employeeNo", e.id FROM "HrEmployeePrivate" p JOIN "HrEmployee" e ON e.id = p."employeeId" WHERE p."idNumberNorm" = ${norm} LIMIT 1`;
  if (emp.length && emp[0].id !== self.employeeId) throw new HrError(`This identity number belongs to employee record ${emp[0].employeeNo}. One person has one record: link the login to that employee instead.`, 409, "IDENTITY_DUPLICATE");
  const ext = await tx.hrExternalPerson.findFirst({ where: { idNumberNorm: norm, ...(self.externalId ? { id: { not: self.externalId } } : {}) }, select: { id: true } });
  if (ext) throw new HrError(self.employeeId !== undefined ? "This identity number belongs to an external person. One person has one record." : "Another external person already has this identity number.", 409, "IDENTITY_DUPLICATE");
}

/** The external-person checks: the number (as above) and a name-match warning for the approver. */
async function oneIdentityChecks(tx: Tx, idNumber: string | null, fullName: string, selfId: string | null) {
  await assertIdNumberFree(tx, idNumber, { externalId: selfId });
  const n = normalizeName(fullName);
  const [emps, exts] = await Promise.all([
    tx.hrEmployee.findMany({ select: { employeeNo: true, fullNameAr: true, fullNameEn: true } }),
    tx.hrExternalPerson.findMany({ where: selfId ? { id: { not: selfId } } : {}, select: { id: true, fullName: true } }),
  ]);
  return [
    ...emps.filter((e) => normalizeName(e.fullNameAr) === n || (e.fullNameEn && normalizeName(e.fullNameEn) === n)).map((e) => ({ kind: "EMPLOYEE_NAME_MATCH", ref: e.employeeNo })),
    ...exts.filter((x) => normalizeName(x.fullName) === n).map((x) => ({ kind: "EXTERNAL_NAME_MATCH", ref: x.id })),
  ];
}

// ── PERSON_VERIFY ─────────────────────────────────────────────────────────────────────

export async function requestVerification(actor: Actor, b: Record<string, unknown>) {
  assertEditor(actor);
  const subjectType = oneOf(b.subjectType, "subjectType", ["EMPLOYEE", "EXTERNAL"] as const);
  const subjectId = reqText(b.subjectId, "subjectId", 40);
  const linkAccountId = text(b.linkAccountId, "linkAccountId", { max: 40 });
  const reason = reqText(b.reason, "reason", 300, 5);
  try {
    return await prisma.$transaction(async (tx) => {
      const s = await personState(tx, subjectType, subjectId);
      if (!s) throw new HrError("Person not found.", 404);
      if (!s.active) throw new HrError("An inactive or separated person is not verified.", 409, "PERSON_INACTIVE");
      if (linkAccountId) {
        if (subjectType !== "EMPLOYEE") throw new HrError("An external person's login is linked through an external person change.", 400);
        if (s.accountId) throw new HrError("This person already has a login.", 409, "ACCOUNT_TAKEN");
        await assertLoginFree(tx, linkAccountId);
      }
      // Review P2-4: a verification attests one login. A verified person whose CURRENT login is
      // not the attested one (linked later) is verified again for that login — by a second person.
      const login = linkAccountId ?? s.accountId;
      if (s.liveVerificationId && s.liveVerificationAccountId === login) throw new HrError("This person's identity is already verified.", 409, "ALREADY_VERIFIED");
      const before = publicState(s);
      const payload = { subjectType, subjectId, subjectName: s.name, ref: s.ref, idMasked: maskId(s._idNumber), hasIdNumber: !!s._idNumber, accountId: s.accountId, linkAccountId: linkAccountId ?? null, attestation: VERIFY_ATTESTATION_EN };
      const targetKey = `PERSON:${subjectType}:${subjectId}`;
      const row = await tx.hrConfigChange.create({ data: { kind: "PERSON_VERIFY", targetKey, payload: payload as Prisma.InputJsonValue, before: before as Prisma.InputJsonValue, fingerprint: fp({ kind: "PERSON_VERIFY", targetKey, payload, before }), reason, requestedBy: actor.id } });
      await audit(tx, { action: "CONFIG_CHANGE_REQUEST", entityType: "HrConfigChange", entityId: row.id, after: { kind: "PERSON_VERIFY", subjectType, subjectId, linkAccountId: linkAccountId ?? null, fingerprint: row.fingerprint }, reason, actorId: actor.id });
      return { id: row.id, fingerprint: row.fingerprint, status: row.status };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    if ((e as { code?: string }).code === "P2002") throw new HrError("A request for this person is already waiting for a decision. Decide or withdraw it first.", 409, "CONFIG_PENDING");
    mapDbError(e);
  }
}

// ── EXTERNAL_PERSON_CHANGE ──────────────────────────────────────────────────────────────

const OPS = ["CREATE", "UPDATE", "LINK", "UNLINK", "DEACTIVATE"] as const;
type Op = (typeof OPS)[number];

export async function requestExternalChange(actor: Actor, b: Record<string, unknown>) {
  assertEditor(actor);
  const op = oneOf(b.op, "op", OPS);
  const reason = reqText(b.reason, "reason", 300, 5);
  try {
    return await prisma.$transaction(async (tx) => {
      // Creating or changing an identity record is an administration action: a verified requester
      // (or the bootstrap of an empty register).
      await assertVerifierIdentity(tx, actor, `EXTERNAL_PERSON_${op}`);
      const externalId = op === "CREATE" ? null : reqText(b.externalId, "externalId", 40);
      const s = externalId ? await personState(tx, "EXTERNAL", externalId) : null;
      if (externalId && !s) throw new HrError("Person not found.", 404);
      if (s && !s.active && op !== "UNLINK") throw new HrError("This external person is deactivated.", 409, "PERSON_INACTIVE");
      const change: Record<string, unknown> = { op, externalId };
      let warnings: { kind: string; ref: string }[] = [];
      if (op === "CREATE" || op === "UPDATE") {
        const fullName = op === "CREATE" ? reqText(b.fullName, "fullName", 160, 3) : (text(b.fullName, "fullName", { max: 160, min: 3 }) ?? (s!.name as string));
        // Kept as entered (trimmed); the database derives the normal form every check compares.
        const idNumber = "idNumber" in b || op === "CREATE" ? text(b.idNumber, "idNumber", { max: 40 }) : ((s!._idNumber as string | null) ?? null);
        const organization = "organization" in b || op === "CREATE" ? text(b.organization, "organization", { max: 160 }) : (s as { organization?: string | null }).organization ?? null;
        const roleNote = "roleNote" in b || op === "CREATE" ? text(b.roleNote, "roleNote", { max: 300 }) : (s as { roleNote?: string | null }).roleNote ?? null;
        warnings = await oneIdentityChecks(tx, idNumber, fullName, externalId);
        const identifying = op === "CREATE" || fullName !== s!.name || idDigest(idNumber) !== s!.idDigest;
        Object.assign(change, { fullName, idNumber, organization, roleNote, identifying });
        if (op === "CREATE") {
          const accountId = text(b.accountId, "accountId", { max: 40 });
          if (accountId) await assertLoginFree(tx, accountId);
          change.accountId = accountId ?? null;
        }
      } else if (op === "LINK") {
        const accountId = reqText(b.accountId, "accountId", 40);
        if (s!.accountId) throw new HrError("This person already has a login. Unlink it first.", 409, "ACCOUNT_TAKEN");
        await assertLoginFree(tx, accountId);
        change.accountId = accountId;
      } else if (op === "UNLINK") {
        if (!s!.accountId) throw new HrError("This person has no login to unlink.", 409);
        change.accountId = s!.accountId;
      }
      const before = publicState(s);
      // The identity number is kept in the request (needed to apply it exactly as reviewed) but
      // is never listed: every output and audit row shows the masked form or a digest.
      const payload = { ...change, idDigest: "idNumber" in change ? idDigest(change.idNumber as string | null) : undefined, idMasked: "idNumber" in change ? maskId(change.idNumber as string | null) : undefined, subjectName: (change.fullName as string) ?? s?.name ?? null, warnings, attestation: op === "UNLINK" || op === "DEACTIVATE" ? null : EXTERNAL_ATTESTATION_EN };
      const targetKey = externalId ? `EXTERNAL:${externalId}` : `EXTERNAL:NEW:${idDigest(change.idNumber as string | null) ?? normalizeName(change.fullName as string)}`;
      const row = await tx.hrConfigChange.create({
        data: { kind: "EXTERNAL_PERSON_CHANGE", targetKey, payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue, before: (before ?? Prisma.JsonNull) as Prisma.InputJsonValue, fingerprint: fp({ kind: "EXTERNAL_PERSON_CHANGE", targetKey, payload, before }), reason, requestedBy: actor.id },
      });
      await audit(tx, { action: "CONFIG_CHANGE_REQUEST", entityType: "HrConfigChange", entityId: row.id, after: { kind: "EXTERNAL_PERSON_CHANGE", op, externalId, accountId: change.accountId ?? null, warnings, fingerprint: row.fingerprint }, reason, actorId: actor.id });
      return { id: row.id, fingerprint: row.fingerprint, status: row.status, warnings };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    if ((e as { code?: string }).code === "P2002") throw new HrError("A request for this person is already waiting for a decision. Decide or withdraw it first.", 409, "CONFIG_PENDING");
    mapDbError(e);
  }
}

// ── Decide / withdraw / list ──────────────────────────────────────────────────────────

const KINDS = ["PERSON_VERIFY", "EXTERNAL_PERSON_CHANGE", "EMPLOYEE_IDENTITY_CHANGE"] as const;

export async function decideIdentityRequest(actor: Actor, id: string, b: Record<string, unknown>) {
  assertEditor(actor);
  assertFresh(actor);
  const decision = b.decision === "APPROVE" || b.decision === "REJECT" ? b.decision : null;
  if (!decision) throw new HrError("decision must be APPROVE or REJECT.", 400);
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
  if (decision === "REJECT" && note.length < 3) throw new HrError("A reason is required to reject.", 400);
  try {
    return await prisma.$transaction(async (tx) => {
      // Review P1-1: every identity decision is serialised on one lock, so the bootstrap check and
      // its record, and any two decisions on related people, never interleave.
      await lock(tx, IDENTITY_DECISION_LOCK);
      await tx.$queryRaw`SELECT 1 FROM "HrConfigChange" WHERE "id" = ${id} FOR UPDATE`;
      const c = await tx.hrConfigChange.findUnique({ where: { id } });
      if (!c || !(KINDS as readonly string[]).includes(c.kind)) throw new HrError("Configuration change not found", 404);
      if (c.status !== "PENDING") throw new HrError(`Only a pending change can be decided (this one is ${c.status}).`, 409);
      const p = c.payload as Record<string, unknown>;
      const subjectType: PersonType = c.kind === "PERSON_VERIFY" ? (p.subjectType as PersonType) : c.kind === "EMPLOYEE_IDENTITY_CHANGE" ? "EMPLOYEE" : "EXTERNAL";
      const subjectId = (c.kind === "PERSON_VERIFY" ? p.subjectId : c.kind === "EMPLOYEE_IDENTITY_CHANGE" ? p.employeeId : p.externalId) as string | null;
      const before = c.before as Record<string, unknown> | null;
      // Every login of the person concerned: now, the one being linked or unlinked.
      const subjectLogins = [before?.accountId, p.accountId, p.linkAccountId].filter((x): x is string => typeof x === "string" && !!x);
      if (c.requestedBy === actor.id) throw new HrError("You requested this change; another account editor must decide it.", 403, "SELF_ACTION");
      if (subjectLogins.includes(actor.id)) throw new HrError("You cannot verify or change your own identity record.", 403, "SELF_ACTION");
      const mine = await identityOf(tx, actor.id);
      if (subjectId && mine.person && mine.person.type === subjectType && mine.person.id === subjectId) throw new HrError("You cannot verify or change your own identity record.", 403, "SELF_ACTION");
      // Review NEW-2: the decider is compared with the SUBJECT PERSON too — by its current link,
      // every link it ever had (audit history) and the identity number shared across records.
      if (subjectId && (await personsOf(tx, [actor.id])).has(subjectType === "EMPLOYEE" ? subjectId : externalKey(subjectId))) throw new HrError("You are the same person as the person concerned; another person must decide it.", 403, "SAME_PERSON");
      if (await samePersonAsAny(tx, [c.requestedBy, ...subjectLogins], actor.id)) throw new HrError("You are the same person as the requester or the account holder; another person must decide it.", 403, "SAME_PERSON");
      const now = new Date();
      if (decision === "REJECT") {
        await tx.hrConfigChange.update({ where: { id }, data: { status: "REJECTED", decidedBy: actor.id, decidedAt: now, decisionNote: note } });
        await audit(tx, { action: "CONFIG_CHANGE_REJECT", entityType: "HrConfigChange", entityId: id, after: { kind: c.kind, subjectType, subjectId }, reason: note, actorId: actor.id });
        return { id, status: "REJECTED", applied: false };
      }
      const expected = typeof b.expected === "string" ? b.expected : "";
      if (!expected) throw new HrError("expected must name the change you reviewed (its fingerprint).", 400);
      if (expected !== c.fingerprint) throw new HrError("This is not the change you reviewed. Reload it and review it again.", 409, "CONFIG_CHANGED");
      const needsAttest = c.kind !== "EXTERNAL_PERSON_CHANGE" || !["UNLINK", "DEACTIVATE"].includes(p.op as string);
      if (needsAttest && b.attested !== true && b.attest !== true) throw new HrError("Confirm that you checked this person's identity (attest) before approving.", 400, "ATTESTATION_REQUIRED");
      const bootstrap = await assertVerifierIdentity(tx, actor, c.kind, c.kind !== "EMPLOYEE_IDENTITY_CHANGE");
      if (subjectId) {
        const nowState = publicState(await personState(tx, subjectType, subjectId));
        if (stableJson(nowState) !== stableJson(before)) throw new HrError("The setting changed after this request was made, so it is stale. Withdraw it and request again.", 409, "CONFIG_STALE");
      }
      const result = c.kind === "PERSON_VERIFY" ? await applyVerify(tx, c, p, actor.id, bootstrap) : c.kind === "EMPLOYEE_IDENTITY_CHANGE" ? await applyEmployeeIdentity(tx, c, p, actor.id) : await applyExternal(tx, c, p, actor.id);
      const [attestation, attestationAr] = c.kind === "PERSON_VERIFY" ? [VERIFY_ATTESTATION_EN, VERIFY_ATTESTATION_AR] : c.kind === "EMPLOYEE_IDENTITY_CHANGE" ? [EMPLOYEE_CHANGE_ATTESTATION_EN, EMPLOYEE_CHANGE_ATTESTATION_AR] : needsAttest ? [EXTERNAL_ATTESTATION_EN, EXTERNAL_ATTESTATION_AR] : [null, null];
      await tx.hrConfigChange.update({ where: { id }, data: { status: "APPLIED", decidedBy: actor.id, decidedAt: now, decisionNote: `${attestation ? `ATTESTED: ${attestation}` : "APPROVED"}${note ? ` — ${note}` : ""}`.slice(0, 1000) } });
      await audit(tx, { action: "CONFIG_CHANGE_APPROVE", entityType: "HrConfigChange", entityId: id, after: { kind: c.kind, op: p.op ?? null, subjectType, subjectId: result.subjectId, fingerprint: c.fingerprint, attestation, attestationAr, attested: needsAttest, bootstrap }, reason: note || null, actorId: actor.id });
      return { id, status: "APPLIED", applied: true, ...result };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

type Change = Prisma.HrConfigChangeGetPayload<object>;

async function applyVerify(tx: Tx, c: Change, p: Record<string, unknown>, actorId: string, bootstrap: boolean) {
  const subjectType = p.subjectType as PersonType;
  const subjectId = p.subjectId as string;
  const link = p.linkAccountId as string | null;
  if (link) {
    await assertLoginFree(tx, link);
    await tx.hrEmployee.update({ where: { id: subjectId }, data: { accountId: link, version: { increment: 1 } } });
    await audit(tx, { action: "ACCOUNT_LINK", entityType: "HrEmployee", entityId: subjectId, employeeId: subjectId, before: { accountId: null }, after: { accountId: link, configChangeId: c.id, requestedBy: c.requestedBy, approvedBy: actorId }, actorId });
  }
  // The login this verification attests (review P2-4); a re-attestation replaces the old row.
  const login = link ?? (subjectType === "EMPLOYEE" ? (await tx.hrEmployee.findUniqueOrThrow({ where: { id: subjectId }, select: { accountId: true } })).accountId : (await tx.hrExternalPerson.findUniqueOrThrow({ where: { id: subjectId }, select: { accountId: true } })).accountId);
  await revokeVerification(tx, subjectType, subjectId, actorId, "Verified again for the login now linked.");
  const v = await tx.hrIdentityVerification.create({ data: { subjectType, subjectId, requestedBy: c.requestedBy, verifiedBy: actorId, configChangeId: c.id, accountId: login ?? null, note: c.reason } });
  // Review P1-1: the bootstrap completes with this approval, once and for good.
  if (bootstrap) await tx.hrIdentityBootstrap.create({ data: { id: "singleton", verificationId: v.id, requestedBy: c.requestedBy, approvedBy: actorId } });
  await audit(tx, { action: "IDENTITY_VERIFIED", entityType: subjectType === "EMPLOYEE" ? "HrEmployee" : "HrExternalPerson", entityId: subjectId, employeeId: subjectType === "EMPLOYEE" ? subjectId : null, after: { verificationId: v.id, configChangeId: c.id, requestedBy: c.requestedBy, verifiedBy: actorId, accountId: login ?? null, linkedAccountId: link ?? null, bootstrap }, actorId });
  return { subjectId, verificationId: v.id };
}

async function applyExternal(tx: Tx, c: Change, p: Record<string, unknown>, actorId: string) {
  const op = p.op as Op;
  const idNumber = "idNumber" in p ? ((p.idNumber as string | null) ?? null) : undefined;
  const who = { configChangeId: c.id, requestedBy: c.requestedBy, approvedBy: actorId };
  if (op === "CREATE" || op === "UPDATE") {
    // Re-checked now: a record created since the request may hold the same number.
    await oneIdentityChecks(tx, idNumber ?? null, p.fullName as string, (p.externalId as string | null) ?? null);
  }
  if (op === "CREATE") {
    if (p.accountId) await assertLoginFree(tx, p.accountId as string);
    const x = await tx.hrExternalPerson.create({ data: { fullName: p.fullName as string, idNumber: idNumber ?? null, organization: (p.organization as string | null) ?? null, roleNote: (p.roleNote as string | null) ?? null, accountId: (p.accountId as string | null) ?? null, createdBy: c.requestedBy } });
    await audit(tx, { action: "EXTERNAL_PERSON_CREATE", entityType: "HrExternalPerson", entityId: x.id, after: { fullName: x.fullName, idMasked: maskId(x.idNumber), organization: x.organization, ...who }, actorId });
    if (x.accountId) await audit(tx, { action: "ACCOUNT_LINK", entityType: "HrExternalPerson", entityId: x.id, before: { accountId: null }, after: { accountId: x.accountId, ...who }, actorId });
    return { subjectId: x.id };
  }
  const xid = p.externalId as string;
  if (op === "UPDATE") {
    await tx.hrExternalPerson.update({ where: { id: xid }, data: { fullName: p.fullName as string, idNumber: idNumber ?? null, organization: (p.organization as string | null) ?? null, roleNote: (p.roleNote as string | null) ?? null } });
    await audit(tx, { action: "EXTERNAL_PERSON_UPDATE", entityType: "HrExternalPerson", entityId: xid, after: { fullName: p.fullName, idMasked: p.idMasked ?? null, organization: p.organization ?? null, identifying: !!p.identifying, ...who }, actorId });
    if (p.identifying) await revokeVerification(tx, "EXTERNAL", xid, actorId, "Identifying details changed (name or identity number).");
  } else if (op === "LINK") {
    await assertLoginFree(tx, p.accountId as string);
    await tx.hrExternalPerson.update({ where: { id: xid }, data: { accountId: p.accountId as string } });
    await audit(tx, { action: "ACCOUNT_LINK", entityType: "HrExternalPerson", entityId: xid, before: { accountId: null }, after: { accountId: p.accountId, ...who }, actorId });
    // Review P2-4: an approved, attested link of a VERIFIED person carries the verification over
    // to the new login (a new row naming it; the old one is revoked).
    const live = await liveVerification(tx, "EXTERNAL", xid);
    if (live) {
      await revokeVerification(tx, "EXTERNAL", xid, actorId, "Login changed; verified again for the new login.");
      const v = await tx.hrIdentityVerification.create({ data: { subjectType: "EXTERNAL", subjectId: xid, requestedBy: c.requestedBy, verifiedBy: actorId, configChangeId: c.id, accountId: p.accountId as string, note: c.reason } });
      await audit(tx, { action: "IDENTITY_VERIFIED", entityType: "HrExternalPerson", entityId: xid, after: { verificationId: v.id, configChangeId: c.id, requestedBy: c.requestedBy, verifiedBy: actorId, accountId: p.accountId, viaLink: true }, actorId });
    }
  } else if (op === "UNLINK") {
    await tx.hrExternalPerson.update({ where: { id: xid }, data: { accountId: null } });
    await audit(tx, { action: "ACCOUNT_UNLINK", entityType: "HrExternalPerson", entityId: xid, before: { accountId: p.accountId }, after: { accountId: null, ...who }, actorId });
    await revokeLoginAttestations(tx, p.accountId as string, actorId, "Login unlinked from its person.");
  } else if (op === "DEACTIVATE") {
    await tx.hrExternalPerson.update({ where: { id: xid }, data: { active: false } });
    await audit(tx, { action: "EXTERNAL_PERSON_DEACTIVATE", entityType: "HrExternalPerson", entityId: xid, after: { active: false, ...who }, actorId });
    await revokeVerification(tx, "EXTERNAL", xid, actorId, "External person deactivated.");
  }
  return { subjectId: xid };
}

// ── EMPLOYEE_IDENTITY_CHANGE (review P2-3) ─────────────────────────────────────────────

/**
 * Whether an employee's identifying details (name, identity document) are guarded: the person
 * is verified, or their login holds a segregated duty or the admin role. Guarded changes are
 * requests a second person approves; the verification is revoked only when the change applies.
 */
export async function identityGuarded(tx: Tx, employeeId: string): Promise<boolean> {
  if (await liveVerification(tx, "EMPLOYEE", employeeId)) return true;
  const e = await tx.hrEmployee.findUnique({ where: { id: employeeId }, select: { account: { select: { role: true, permissions: true } } } });
  const a = e?.account;
  return !!a && (a.role === "admin" || payrollDuties(effectivePermissions(a.permissions as string | null, a.role)).length > 0);
}

export type EmployeeIdentityFields = { fullNameAr?: string; fullNameEn?: string | null; idType?: string | null; idNumber?: string | null };

/** Inside the caller's transaction: record a guarded identifying change as a request (nothing applied). */
export async function requestEmployeeIdentityChangeIn(tx: Tx, actorId: string, employeeId: string, changes: EmployeeIdentityFields, reason: string) {
  if ("idNumber" in changes) await assertIdNumberFree(tx, changes.idNumber, { employeeId });
  const s = await personState(tx, "EMPLOYEE", employeeId);
  if (!s) throw new HrError("Person not found.", 404);
  const before = publicState(s);
  const fields = Object.keys(changes);
  // The new identity number stays in the request (needed to apply it exactly as reviewed); every
  // listing and audit row shows it masked.
  const payload = { employeeId, subjectName: s.name, ref: s.ref, fields, changes, idMasked: "idNumber" in changes ? maskId(changes.idNumber) : null, accountId: s.accountId, attestation: EMPLOYEE_CHANGE_ATTESTATION_EN };
  const targetKey = `IDENTITY:EMPLOYEE:${employeeId}`;
  if (await tx.hrConfigChange.findFirst({ where: { targetKey, status: "PENDING" }, select: { id: true } })) throw new HrError("A request for this person is already waiting for a decision. Decide or withdraw it first.", 409, "CONFIG_PENDING");
  const row = await tx.hrConfigChange.create({ data: { kind: "EMPLOYEE_IDENTITY_CHANGE", targetKey, payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue, before: before as Prisma.InputJsonValue, fingerprint: fp({ kind: "EMPLOYEE_IDENTITY_CHANGE", targetKey, payload, before }), reason: reason.trim().length >= 5 ? reason.trim().slice(0, 300) : "Identifying details change", requestedBy: actorId } });
  await audit(tx, { action: "CONFIG_CHANGE_REQUEST", entityType: "HrConfigChange", entityId: row.id, employeeId, after: { kind: "EMPLOYEE_IDENTITY_CHANGE", employeeId, fields, fingerprint: row.fingerprint }, reason, actorId });
  return { id: row.id, fingerprint: row.fingerprint, fields };
}

async function applyEmployeeIdentity(tx: Tx, c: Change, p: Record<string, unknown>, actorId: string) {
  const employeeId = p.employeeId as string;
  const ch = p.changes as EmployeeIdentityFields;
  if ("idNumber" in ch) await assertIdNumberFree(tx, ch.idNumber, { employeeId });
  const person: Record<string, unknown> = {};
  if ("fullNameAr" in ch) person.fullNameAr = ch.fullNameAr;
  if ("fullNameEn" in ch) person.fullNameEn = ch.fullNameEn ?? null;
  if (Object.keys(person).length) await tx.hrEmployee.update({ where: { id: employeeId }, data: { ...person, version: { increment: 1 } } });
  const priv: Record<string, unknown> = {};
  if ("idType" in ch) priv.idType = ch.idType ?? null;
  if ("idNumber" in ch) priv.idNumber = ch.idNumber ?? null;
  if (Object.keys(priv).length) await tx.hrEmployeePrivate.upsert({ where: { employeeId }, create: { employeeId, ...priv, updatedBy: actorId }, update: { ...priv, updatedBy: actorId } });
  await audit(tx, { action: "EMPLOYEE_IDENTITY_CHANGE_APPLIED", entityType: "HrEmployee", entityId: employeeId, employeeId, after: { fields: Object.keys(ch), idMasked: p.idMasked ?? null, configChangeId: c.id, requestedBy: c.requestedBy, approvedBy: actorId }, actorId });
  // The verification checked the old details: it ends now that the new ones apply (not before).
  await revokeVerification(tx, "EMPLOYEE", employeeId, actorId, "Identifying details changed (approved request).");
  return { subjectId: employeeId };
}

export async function withdrawIdentityRequest(actor: Actor, id: string) {
  assertEditor(actor);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "HrConfigChange" WHERE "id" = ${id} FOR UPDATE`;
    const c = await tx.hrConfigChange.findUnique({ where: { id } });
    if (!c || !(KINDS as readonly string[]).includes(c.kind)) throw new HrError("Configuration change not found", 404);
    if (c.requestedBy !== actor.id) throw new HrError("Only the person who requested this change can withdraw it.", 403, "NOT_REQUESTER");
    if (c.status !== "PENDING") throw new HrError(`Only a pending change can be withdrawn (this one is ${c.status}).`, 409);
    await tx.hrConfigChange.update({ where: { id }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
    await audit(tx, { action: "CONFIG_CHANGE_WITHDRAW", entityType: "HrConfigChange", entityId: id, after: { kind: c.kind }, actorId: actor.id });
    return { id, status: "WITHDRAWN" };
  }, TX);
}

/**
 * The identity register for account editors: external persons, the identity of every login
 * (linked person, verified or not), and identity requests. Identity numbers masked.
 */
export async function identityRegister(actor: Actor) {
  assertEditor(actor);
  const [externals, logins, rows, employees] = await Promise.all([
    prisma.hrExternalPerson.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.employee.findMany({ select: { id: true, name: true, role: true, active: true }, orderBy: { name: "asc" } }),
    prisma.hrConfigChange.findMany({ where: { kind: { in: [...KINDS] } }, orderBy: { requestedAt: "desc" }, take: 200 }),
    prisma.hrEmployee.findMany({ where: { status: { not: "SEPARATED" } }, select: { id: true, employeeNo: true, fullNameAr: true, accountId: true }, orderBy: { employeeNo: "asc" } }),
  ]);
  const status = await identityOfMany(prisma, logins.map((l) => l.id));
  const live = await prisma.hrIdentityVerification.findMany({ where: { revokedAt: null } });
  const lv = new Map(live.map((v) => [`${v.subjectType}:${v.subjectId}`, v]));
  const names = await accountNames(prisma, [...rows.flatMap((r) => [r.requestedBy, r.decidedBy]), ...live.map((v) => v.verifiedBy), ...externals.map((x) => x.accountId)]);
  return {
    externalPersons: externals.map((x) => {
      const v = lv.get(`EXTERNAL:${x.id}`);
      return { id: x.id, fullName: x.fullName, idMasked: maskId(x.idNumber), organization: x.organization, roleNote: x.roleNote, accountId: x.accountId, accountName: x.accountId ? names.get(x.accountId) ?? null : null, active: x.active, verified: !!v && x.active, verifiedAt: v?.verifiedAt ?? null, verifiedByName: v ? names.get(v.verifiedBy) ?? null : null };
    }),
    employees: employees.map((e) => ({ id: e.id, employeeNo: e.employeeNo, name: e.fullNameAr, accountId: e.accountId, verified: lv.has(`EMPLOYEE:${e.id}`) })),
    logins: logins.map((l) => {
      const s = status.get(l.id)!;
      return { id: l.id, name: l.name, role: l.role, active: l.active, personType: s.person?.type ?? null, personId: s.person?.id ?? null, personName: s.person?.name ?? null, verified: s.verified };
    }),
    requests: rows.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return { id: r.id, kind: r.kind, op: (p.op as string) ?? null, status: r.status, fingerprint: r.fingerprint, reason: r.reason, subjectType: r.kind === "EMPLOYEE_IDENTITY_CHANGE" ? "EMPLOYEE" : (p.subjectType as string) ?? "EXTERNAL", subjectId: (p.subjectId as string) ?? (p.employeeId as string) ?? (p.externalId as string) ?? null, subjectName: (p.subjectName as string) ?? null, idMasked: (p.idMasked as string) ?? null, organization: (p.organization as string) ?? null, accountId: (p.accountId as string) ?? (p.linkAccountId as string) ?? null, warnings: (p.warnings as unknown[]) ?? [], attestation: r.kind === "PERSON_VERIFY" ? VERIFY_ATTESTATION_EN : r.kind === "EMPLOYEE_IDENTITY_CHANGE" ? EMPLOYEE_CHANGE_ATTESTATION_EN : (p.attestation as string | null) ?? null, attestationAr: r.kind === "PERSON_VERIFY" ? VERIFY_ATTESTATION_AR : r.kind === "EMPLOYEE_IDENTITY_CHANGE" ? EMPLOYEE_CHANGE_ATTESTATION_AR : p.attestation ? EXTERNAL_ATTESTATION_AR : null, fields: (p.fields as string[]) ?? [], requestedByName: names.get(r.requestedBy) ?? null, requestedAt: r.requestedAt, decidedByName: r.decidedBy ? names.get(r.decidedBy) ?? null : null, mine: r.requestedBy === actor.id };
    }),
    // Review NEW-6: the persisted one-time record decides, never the live rows (revocations
    // never re-open the bootstrap).
    bootstrap: await verificationBootstrap(prisma),
  };
}
