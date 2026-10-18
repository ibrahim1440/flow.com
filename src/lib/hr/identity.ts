// Owner decision 1 — separation of duties is by PERSON, not by login — and Option A (16 Oct):
// every login that performs a payroll or payroll-administration action belongs to a VERIFIED
// person.
//
// A login's person is the record it is linked to: an HR employee (HrEmployee.accountId) or an
// external person such as an outside accountant (HrExternalPerson.accountId) — never both (DB
// trigger pair, migration 20261016160000). Links change over time, so "the same person" means:
// linked to that person NOW or AT ANY TIME (every link and unlink is in HrAuditLog), and one
// human is one person across both kinds of record: an external person and an employee with the
// same identity document number are the same person.
//
// A person is VERIFIED while they hold a live HrIdentityVerification — written only when a second
// person approves a PERSON_VERIFY request (services/identity-verification) — and the record is
// active (an employee not separated, an external person not deactivated).
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { HrError, audit, type Db } from "./core";

export type PersonType = "EMPLOYEE" | "EXTERNAL";
/** Person keys: an employee's id as is, an external person's id prefixed (never a payee id). */
export const externalKey = (id: string) => `X:${id}`;

// Review P1-2: ONE normal form for identity document numbers. The database function hr_norm_id
// (migration 20261016160000, made strict and locale-independent by 20261016180000) is the authority — it fills "idNumberNorm" on both kinds of record,
// and every uniqueness / same-person check compares that column. This is its mirror for display
// digests, kept identical and tested against it (tests/hr/integration/hr-identity.test.ts).
const FORMAT_CHARS = /[\u00AD\u034F\u061C\u0600-\u0605\u06DD\u070F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB]/g;
const SEPARATORS = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\-\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D.\u00B7\u2024\u2027\u3002\uFF0E\uFF61]/g;
export function normalizeIdNumber(v: string | null | undefined): string | null {
  if (v == null) return null;
  let t = v.normalize("NFKC").replace(FORMAT_CHARS, "");
  t = t.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  // Only ASCII a-z is upper-cased (toUpperCase would turn "ß" into "SS", ı into I, …).
  t = t.replace(SEPARATORS, "").replace(/[a-z]/g, (c) => c.toUpperCase());
  if (/^[0-9]+$/.test(t)) t = t.replace(/^0+/, "") || "0";
  return t || null;
}
/**
 * Owner rule (review NEW-3): after normalization an identity number is [A-Z0-9] only. Anything
 * else — another digit script, a combining mark, _ / , or a look-alike letter — is ambiguous and
 * refused (the database CHECKs refuse it too).
 */
export const ID_NORM_VALID = /^[A-Z0-9]+$/;
/** Blank (only ASCII spaces, tabs, line breaks) is "no number" on both sides; anything else must normalize to [A-Z0-9]+. */
export const idNumberValid = (v: string | null | undefined) => v == null || /^[ \t\n\r]*$/.test(v) || ID_NORM_VALID.test(normalizeIdNumber(v) ?? "");
/** The database's normal form of a number (the authority every guard uses). */
export async function dbNormId(db: Db, v: string | null | undefined): Promise<string | null> {
  if (v == null || v === "") return null;
  const [r] = await db.$queryRaw<{ n: string | null }[]>`SELECT hr_norm_id(${v}) AS n`;
  return r?.n ?? null;
}
/** A digest for stale checks and audit rows — the number itself is private data. */
export const idDigest = (v: string | null | undefined) => {
  const n = normalizeIdNumber(v);
  return n ? createHash("sha256").update(`hr:id:v1:${n}`).digest("hex").slice(0, 24) : null;
};
export const maskId = (v: string | null | undefined) => {
  const n = normalizeIdNumber(v);
  return n ? `••••${n.slice(-4)}` : null;
};
/** Name comparison for the one-identity warning (not a control: the attestation is). */
export const normalizeName = (v: string | null | undefined) => (v ?? "").normalize("NFKC").toLowerCase().replace(/[ً-ْ]/g, "").replace(/\s+/g, " ").trim();

const nonEmpty = (s: Set<string>) => (s.size ? [...s] : [""]);

/** Every HR person linked — now or ever — to any of these logins, including the same human under the other kind of record. */
export async function personsOf(db: Db, accountIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(accountIds.filter(Boolean))];
  if (!ids.length) return new Set();
  const [emps, exts, ever] = await Promise.all([
    db.hrEmployee.findMany({ where: { accountId: { in: ids } }, select: { id: true } }),
    db.hrExternalPerson.findMany({ where: { accountId: { in: ids } }, select: { id: true } }),
    // Every link ever made (after.accountId) and every link ever removed or swapped away
    // (before.accountId) — QA2 P2-1: an unlink does not erase who the login belonged to.
    db.$queryRaw<{ entityType: string; entityId: string }[]>`SELECT DISTINCT "entityType", "entityId" FROM "HrAuditLog" WHERE "entityType" IN ('HrEmployee', 'HrExternalPerson') AND "action" IN ('ACCOUNT_LINK', 'ACCOUNT_UNLINK') AND (("after"->>'accountId') = ANY(${ids}) OR ("before"->>'accountId') = ANY(${ids}))`,
  ]);
  const empIds = new Set([...emps.map((r) => r.id), ...ever.filter((r) => r.entityType === "HrEmployee").map((r) => r.entityId)]);
  const extIds = new Set([...exts.map((r) => r.id), ...ever.filter((r) => r.entityType === "HrExternalPerson").map((r) => r.entityId)]);
  // One human, one person: the same identity document number on both kinds of record.
  if (empIds.size || extIds.size) {
    const cross = await db.$queryRaw<{ kind: string; id: string }[]>`
      SELECT 'EMPLOYEE' AS kind, p."employeeId" AS id FROM "HrEmployeePrivate" p JOIN "HrExternalPerson" x ON p."idNumberNorm" = x."idNumberNorm"
        WHERE x.id = ANY(${nonEmpty(extIds)}) AND p."idNumberNorm" IS NOT NULL
      UNION
      SELECT 'EXTERNAL' AS kind, x.id FROM "HrExternalPerson" x JOIN "HrEmployeePrivate" p ON p."idNumberNorm" = x."idNumberNorm"
        WHERE p."employeeId" = ANY(${nonEmpty(empIds)}) AND x."idNumberNorm" IS NOT NULL`;
    for (const r of cross) (r.kind === "EMPLOYEE" ? empIds : extIds).add(r.id);
  }
  return new Set([...empIds, ...[...extIds].map(externalKey)]);
}

/** True when the actor's login is one of `accounts`, or the actor is (or was) the same person as one of them. */
export async function samePersonAsAny(db: Db, accounts: Iterable<string>, actorId: string): Promise<boolean> {
  const set = new Set(accounts);
  if (set.has(actorId)) return true;
  if (!set.size) return false;
  const [mine, theirs] = await Promise.all([personsOf(db, [actorId]), personsOf(db, [...set])]);
  for (const p of mine) if (theirs.has(p)) return true;
  return false;
}

// ── Verified identity (Option A) ─────────────────────────────────────────────────────

export type LinkedPerson = { type: PersonType; id: string; name: string; active: boolean; idNumber: string | null };

/** The person this login is linked to now, if any. */
export async function linkedPerson(db: Db, accountId: string): Promise<LinkedPerson | null> {
  const emp = await db.hrEmployee.findUnique({ where: { accountId }, select: { id: true, fullNameAr: true, status: true, private: { select: { idNumber: true } } } });
  if (emp) return { type: "EMPLOYEE", id: emp.id, name: emp.fullNameAr, active: emp.status !== "SEPARATED", idNumber: emp.private?.idNumber ?? null };
  const ext = await db.hrExternalPerson.findUnique({ where: { accountId }, select: { id: true, fullName: true, active: true, idNumber: true } });
  if (ext) return { type: "EXTERNAL", id: ext.id, name: ext.fullName, active: ext.active, idNumber: ext.idNumber };
  return null;
}

export async function liveVerification(db: Db, type: PersonType, id: string) {
  return db.hrIdentityVerification.findFirst({ where: { subjectType: type, subjectId: id, revokedAt: null } });
}

export type IdentityStatus = { person: LinkedPerson | null; verification: { id: string; verifiedAt: Date; verifiedBy: string; accountId: string | null } | null; verified: boolean; personVerified: boolean };

/**
 * A login is verified when its person is active and holds a live verification that attests THIS
 * login (review P2-4): linking another login to a verified person does not verify that login
 * until a second person attests it. `personVerified` says the person is verified at all.
 */
export async function identityOf(db: Db, accountId: string): Promise<IdentityStatus> {
  const person = await linkedPerson(db, accountId);
  const v = person ? await liveVerification(db, person.type, person.id) : null;
  return { person, verification: v ? { id: v.id, verifiedAt: v.verifiedAt, verifiedBy: v.verifiedBy, accountId: v.accountId } : null, verified: !!person && person.active && !!v && v.accountId === accountId, personVerified: !!person && !!v };
}

/** Identity status of many logins at once (reports). */
export async function identityOfMany(db: Db, accountIds: string[]): Promise<Map<string, IdentityStatus>> {
  const ids = [...new Set(accountIds)];
  const [emps, exts] = await Promise.all([
    db.hrEmployee.findMany({ where: { accountId: { in: ids } }, select: { id: true, accountId: true, fullNameAr: true, status: true } }),
    db.hrExternalPerson.findMany({ where: { accountId: { in: ids } }, select: { id: true, accountId: true, fullName: true, active: true } }),
  ]);
  const live = await db.hrIdentityVerification.findMany({ where: { revokedAt: null, subjectId: { in: [...emps.map((e) => e.id), ...exts.map((e) => e.id)] } } });
  const lv = new Map(live.map((v) => [`${v.subjectType}:${v.subjectId}`, v]));
  const out = new Map<string, IdentityStatus>();
  for (const id of ids) out.set(id, { person: null, verification: null, verified: false, personVerified: false });
  const put = (accountId: string, person: LinkedPerson) => {
    const v = lv.get(`${person.type}:${person.id}`);
    out.set(accountId, { person, verification: v ? { id: v.id, verifiedAt: v.verifiedAt, verifiedBy: v.verifiedBy, accountId: v.accountId } : null, verified: person.active && !!v && v.accountId === accountId, personVerified: !!v });
  };
  for (const e of emps) put(e.accountId as string, { type: "EMPLOYEE", id: e.id, name: e.fullNameAr, active: e.status !== "SEPARATED", idNumber: null });
  for (const x of exts) put(x.accountId as string, { type: "EXTERNAL", id: x.id, name: x.fullName, active: x.active, idNumber: null });
  return out;
}

export const IDENTITY_NOT_VERIFIED_EN = "Your login is not linked to a verified person, so you are blocked from payroll actions until your identity is verified.";
export const IDENTITY_NOT_VERIFIED_AR = "حسابك غير مرتبط بشخص موثّق الهوية؛ أنت محظور من إجراءات الرواتب حتى التوثيق.";

/**
 * Option A, enforced server-side: a sensitive payroll action (prepare, rebuild, adjust, submit,
 * approve, pay, cancel) or a payroll-administration action is refused — 403
 * IDENTITY_NOT_VERIFIED, audited — unless the actor's login is linked to a verified person.
 * Holding the duty is checked first (403 FORBIDDEN stays the answer to a missing duty).
 */
export async function assertVerifiedActor(actor: { id: string }, step: string, db: Db = prisma) {
  // Review NEW-9: inside a transaction, the actor's live verification row is share-locked, so a
  // concurrent revocation waits for this action to commit (or this action sees it).
  if (db !== prisma) await db.$queryRaw`SELECT 1 FROM "HrIdentityVerification" WHERE "accountId" = ${actor.id} AND "revokedAt" IS NULL FOR SHARE`;
  const s = await identityOf(db, actor.id);
  if (s.verified) return s;
  // Written on its own (not in the caller's transaction): the refusal rolls that back.
  await audit(prisma, { action: "IDENTITY_NOT_VERIFIED_REFUSED", entityType: "Employee", entityId: actor.id, after: { step, linked: !!s.person, personType: s.person?.type ?? null, personActive: s.person?.active ?? null, verified: false }, actorId: actor.id }).catch(() => undefined);
  throw new HrError(IDENTITY_NOT_VERIFIED_EN, 403, "IDENTITY_NOT_VERIFIED");
}

export const SUBJECT_NOT_VERIFIED_EN = "This login is not linked to a verified person. Link it to an employee or an external person and have that identity verified before granting payroll or account-administration duties.";

/** A grant of a segregated duty (or the admin role) goes only to a login of a verified person — at request and at approval. */
export async function assertSubjectVerified(db: Db, accountId: string) {
  if (!(await identityOf(db, accountId)).verified) throw new HrError(SUBJECT_NOT_VERIFIED_EN, 409, "SUBJECT_NOT_VERIFIED");
}

/**
 * Bootstrap of the verification register (review P1-1): ONCE. Until the first verification is
 * approved, the approver need not be verified (still a second person, never the same person by
 * any link; audited as bootstrap). That approval writes the single HrIdentityBootstrap row, and
 * from then on every verifier is verified — even if every verification is later revoked.
 * Callers hold the identity-decision lock, so two first decisions cannot both see bootstrap.
 */
export async function verificationBootstrap(db: Db): Promise<boolean> {
  return !(await db.hrIdentityBootstrap.findUnique({ where: { id: "singleton" }, select: { id: true } }));
}

/** Every identity decision runs under this one transaction-scoped lock (review P1-1). */
export const IDENTITY_DECISION_LOCK = "identity-decisions";

/**
 * Review NEW-1: a verification attests ONE login. When that login is unlinked from its person
 * (or moved to another), every live verification that names it is revoked — otherwise unlink →
 * credential reset → relink would bring back a "verified" login whose credentials one editor set.
 * Audited. Returns the revoked verification ids.
 */
export async function revokeLoginAttestations(db: Db, accountId: string, actorId: string, reason: string) {
  const live = await db.hrIdentityVerification.findMany({ where: { accountId, revokedAt: null }, select: { id: true, subjectType: true, subjectId: true } });
  for (const v of live) {
    await db.hrIdentityVerification.update({ where: { id: v.id }, data: { revokedAt: new Date(), revokedBy: actorId, revokeReason: reason.slice(0, 300) } });
    await audit(db, { action: "IDENTITY_VERIFICATION_REVOKED", entityType: v.subjectType === "EMPLOYEE" ? "HrEmployee" : "HrExternalPerson", entityId: v.subjectId, employeeId: v.subjectType === "EMPLOYEE" ? v.subjectId : null, before: { verificationId: v.id, accountId }, reason, actorId });
  }
  return live.map((v) => v.id);
}

/** Review NEW-1: a login named by any live verification, linked to its person or not. */
export async function loginAttested(db: Db, accountId: string): Promise<boolean> {
  return !!(await db.hrIdentityVerification.findFirst({ where: { accountId, revokedAt: null }, select: { id: true } }));
}

/** Revoke the live verification of a person (identifying data changed, deactivated, separated). Audited. */
export async function revokeVerification(db: Db, type: PersonType, id: string, actorId: string, reason: string) {
  const v = await liveVerification(db, type, id);
  if (!v) return null;
  await db.hrIdentityVerification.update({ where: { id: v.id }, data: { revokedAt: new Date(), revokedBy: actorId, revokeReason: reason.slice(0, 300) } });
  await audit(db, { action: "IDENTITY_VERIFICATION_REVOKED", entityType: type === "EMPLOYEE" ? "HrEmployee" : "HrExternalPerson", entityId: id, employeeId: type === "EMPLOYEE" ? id : null, before: { verificationId: v.id }, reason, actorId });
  return v.id;
}
