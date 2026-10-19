// Native HR — independent approval of configuration changes (owner decision F2, finding 9).
//
// The account map, HR accounting on/off and new leave types are never changed by one person.
// A policy manager REQUESTS a change (with a reason); nothing is applied. ANOTHER policy manager
// approves it by naming its fingerprint — the exact content and the value in force it was
// requested against — and it is applied in that same transaction, with audit rows for the
// request, the decision and the application. Until then the current settings stay in force.
//
//   PENDING ──approve (other manager, fingerprint, nothing changed since)──▶ APPLIED
//      ├──reject (other manager, note)──▶ REJECTED
//      └──withdraw (requester)──▶ WITHDRAWN
//
// Database (migration 20261016140000_hr_config_change): decidedBy <> requestedBy; one PENDING
// per target; a decided request never changes and none is deleted. These functions are the
// ONLY write path for the three settings — the old direct-apply functions are gone.
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, accountNames, assertCan, audit, bool, oneOf, reqText, text, mapDbError } from "../core";
import { ACCOUNT_KEYS, settings } from "./policy";
import { assertVerifiedActor, samePersonAsAny } from "../identity";
import { assertAttestationDecidable, attestationCurrentValue, prepareAttestation } from "./payroll-attest";
import { assertLegacyLinksBaselined } from "./journal-integrity";
import { GOSI_CASE_RULES, GOSI_TREATMENT_CASES } from "../gosi-treatments";
import { payrollReadiness } from "../readiness";
import { assertPayrollLive } from "../payroll-lock";
import { isSimpleMode } from "@/lib/simple-mode";

type Tx = Prisma.TransactionClient;
// P-2 (migration 20261017090000): LEAVE_TYPE_CONFIRM — a leave type's proposal mark cleared by a
// second policy manager (E-1); PAYROLL_CONTROL_ATTEST — a second-person, attested payroll control
// decision (./payroll-attest): a correction run under a proposal policy, or an earning adjustment
// for a separating person. An attestation applies nothing by itself. Review P1-A1: it can no
// longer accept pay left after a whole period of unpaid leave (D-2a open).
// P-2 rev3 item 3 (migration 20261017170000): GOSI_TREATMENT_SET — enable (or disable) one case of
// the D-4h GOSI difference matrix with the posting keys and the accountant's decision reference.
// Every case ships disabled; nothing is booked under a case until this change is applied.
// Phase 1 payroll lock (migration 20261017215000): PAYROLL_LIVE_SET — turn live payroll on (only while
// the readiness check is clean, at request AND at approval) or off. Two people, as every setting.
export const CONFIG_KINDS = ["ACCOUNT_MAP_SET", "ACCOUNTING_TOGGLE", "LEAVE_TYPE_CREATE", "LEAVE_TYPE_CONFIRM", "PAYROLL_CONTROL_ATTEST", "GOSI_TREATMENT_SET", "PAYROLL_LIVE_SET"] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];
const isSettingsKind = (k: string): k is ConfigKind => (CONFIG_KINDS as readonly string[]).includes(k);

type Prepared = { kind: ConfigKind; targetKey: string; payload: Record<string, unknown>; before: unknown };

const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;

/** What the approver approves: the kind, the target, the new content and the value it replaces. */
export function configFingerprint(p: { kind: string; targetKey: string; payload: unknown; before: unknown }): string {
  return createHash("sha256").update(JSON.stringify(canonical({ kind: p.kind, targetKey: p.targetKey, payload: p.payload, before: p.before ?? null }))).digest("hex").slice(0, 24);
}

async function postableAccount(db: Db, accountId: string) {
  const acc = await db.account.findUnique({ where: { id: accountId }, include: { _count: { select: { children: true } } } });
  if (!acc || !acc.isActive || !acc.allowPosting || acc._count.children > 0) throw new HrError("Choose an active posting (leaf) account.", 400);
  return acc;
}

/** The value in force for a target right now (compared at approval: a change since makes the request stale). */
async function currentValue(db: Db, kind: ConfigKind, payload: Record<string, unknown>): Promise<unknown> {
  if (kind === "ACCOUNT_MAP_SET") return (await db.hrAccountMap.findUnique({ where: { key: payload.key as string } }))?.accountId ?? null;
  if (kind === "ACCOUNTING_TOGGLE") return (await settings(db)).accountingEnabled;
  if (kind === "PAYROLL_LIVE_SET") return (await settings(db)).payrollLive;
  if (kind === "LEAVE_TYPE_CONFIRM") return (await db.hrLeaveType.findUnique({ where: { code: payload.code as string } }))?.isProposal ?? null;
  // The value attested against (policy content and pay record; or the attested adjustments).
  if (kind === "PAYROLL_CONTROL_ATTEST") return attestationCurrentValue(db, payload);
  if (kind === "GOSI_TREATMENT_SET") {
    const t = await db.hrGosiTreatment.findUnique({ where: { caseCode: payload.caseCode as string } });
    return t ? { enabled: t.enabled, debitKey: t.debitKey, creditKey: t.creditKey, decisionReference: t.decisionReference } : null;
  }
  return (await db.hrLeaveType.findUnique({ where: { code: payload.code as string } })) ? "EXISTS" : null;
}

async function prepare(db: Db, kind: ConfigKind, b: Record<string, unknown>): Promise<Prepared> {
  if (kind === "ACCOUNT_MAP_SET") {
    // Review P2-A4: never while a journal link from before posted lines were frozen has no baseline.
    await assertLegacyLinksBaselined(db);
    const key = oneOf(b.key, "key", ACCOUNT_KEYS);
    const accountId = reqText(b.accountId, "accountId", 40);
    await postableAccount(db, accountId);
    const payload = { key, accountId };
    const before = await currentValue(db, kind, payload);
    if (before === accountId) throw new HrError("This key is already mapped to that account.", 400);
    // Re-review R1: while payroll is locked a mapped key is never remapped (the DB refuses it too).
    if (before !== null) await assertPayrollLive("ACCOUNT_REMAP", db);
    return { kind, targetKey: `ACCOUNT_MAP:${key}`, payload, before };
  }
  if (kind === "PAYROLL_LIVE_SET") {
    if (typeof b.payrollLive !== "boolean") throw new HrError("payrollLive must be true or false.", 400);
    const payload = { payrollLive: b.payrollLive };
    const before = await currentValue(db, kind, payload);
    if (before === b.payrollLive) throw new HrError(`Live payroll is already ${b.payrollLive ? "on" : "off"}.`, 400);
    if (b.payrollLive) await assertPayrollReady(db);
    await assertSwitchAllowed(db, b.payrollLive);
    return { kind, targetKey: "SETTINGS:payrollLive", payload, before };
  }
  if (kind === "ACCOUNTING_TOGGLE") {
    if (typeof b.accountingEnabled !== "boolean") throw new HrError("accountingEnabled must be true or false.", 400);
    const payload = { accountingEnabled: b.accountingEnabled };
    const before = await currentValue(db, kind, payload);
    if (before === b.accountingEnabled) throw new HrError(`HR accounting is already ${b.accountingEnabled ? "on" : "off"}.`, 400);
    return { kind, targetKey: "SETTINGS:accountingEnabled", payload, before };
  }
  if (kind === "LEAVE_TYPE_CONFIRM") {
    const t = await db.hrLeaveType.findUnique({ where: { id: reqText(b.leaveTypeId, "leaveTypeId", 40) } });
    if (!t) throw new HrError("Leave type not found.", 404);
    if (!t.isProposal) throw new HrError(`Leave type ${t.code} is already confirmed.`, 400);
    // The confirmed entitlement is part of what the approver reviews (fingerprint), not only the code.
    const payload = { code: t.code, leaveTypeId: t.id, paid: t.paid, tracksBalance: t.tracksBalance, accrualDaysPerYear: t.accrualDaysPerYear?.toString() ?? null, allowNegative: t.allowNegative };
    return { kind, targetKey: `LEAVE_TYPE_CONFIRM:${t.code}`, payload, before: true };
  }
  if (kind === "PAYROLL_CONTROL_ATTEST") return { kind, ...(await prepareAttestation(db, b)) };
  if (kind === "GOSI_TREATMENT_SET") {
    const caseCode = oneOf(b.caseCode, "caseCode", GOSI_TREATMENT_CASES);
    const t = await db.hrGosiTreatment.findUnique({ where: { caseCode } });
    if (!t) throw new HrError("This GOSI treatment case is not in the matrix.", 404);
    if (typeof b.enabled !== "boolean") throw new HrError("enabled must be true or false.", 400);
    let payload: Record<string, unknown>;
    if (b.enabled) {
      if (!t.posting) throw new HrError(`${caseCode} never posts (the difference is linked to what already booked it), so it has no treatment to enable.`, 400, "GOSI_TREATMENT_NO_POSTING");
      // Only keys of the account map exist. The keys the D-4h draft proposes and the map does not have
      // (EMPLOYEE_RECEIVABLE, EMPLOYEE_REFUND_PAYABLE, GOSI_DISPUTED_RECEIVABLE, GOSI_ROUNDING) are refused
      // here until the accountant approves adding them — none is added by this code.
      const debitKey = oneOf(b.debitKey, "debitKey", ACCOUNT_KEYS);
      const creditKey = oneOf(b.creditKey, "creditKey", ACCOUNT_KEYS);
      if (debitKey === creditKey) throw new HrError("debitKey and creditKey must differ.", 400);
      // Review rev8 P3: only the keys of the case's proposed entry (never an arbitrary pair).
      const fam = GOSI_CASE_RULES[caseCode].keys;
      if (!fam.debit.includes(debitKey) || !fam.credit.includes(creditKey)) {
        const named = (k: readonly string[]) => (k.length ? k.join(" or ") : "no key named yet");
        throw new HrError(`${caseCode} posts Dr ${named(fam.debit)} / Cr ${named(fam.credit)} (the proposed entry); Dr ${debitKey} / Cr ${creditKey} is not that entry.`, 400, "GOSI_TREATMENT_KEYS");
      }
      payload = { caseCode, enabled: true, debitKey, creditKey, decisionReference: reqText(b.decisionReference, "decisionReference", 200, 3) };
    } else payload = { caseCode, enabled: false, debitKey: null, creditKey: null, decisionReference: text(b.decisionReference, "decisionReference", { max: 200 }) };
    const before = await currentValue(db, kind, payload);
    if ((before as { enabled?: boolean } | null)?.enabled === false && !b.enabled) throw new HrError(`${caseCode} is already disabled.`, 400);
    return { kind, targetKey: `GOSI_TREATMENT:${caseCode}`, payload, before };
  }
  const accrual = b.accrualDaysPerYear === undefined || b.accrualDaysPerYear === null || b.accrualDaysPerYear === "" ? null : new Prisma.Decimal(String(b.accrualDaysPerYear));
  if (accrual && (accrual.isNaN() || accrual.lessThan(0) || accrual.greaterThan(366))) throw new HrError("accrualDaysPerYear is out of range.", 400);
  const payload = {
    code: reqText(b.code, "code", 20).toUpperCase(), nameAr: reqText(b.nameAr, "nameAr", 80),
    paid: bool(b.paid, true), tracksBalance: bool(b.tracksBalance, true), accrualDaysPerYear: accrual?.toString() ?? null,
    allowNegative: bool(b.allowNegative, false), isProposal: bool(b.isProposal, true),
  };
  if (await currentValue(db, kind, payload)) throw new HrError(`A leave type with code ${payload.code} already exists.`, 409, "DUPLICATE");
  return { kind, targetKey: `LEAVE_TYPE:${payload.code}`, payload, before: null };
}

/** Apply an approved change inside the approval's transaction; returns the audit before/after. */
async function apply(tx: Tx, c: { id: string; requestedBy: string; kind: ConfigKind; payload: Record<string, unknown> }, approverId: string): Promise<{ action: string; entityType: string; entityId: string; before: unknown; after: unknown }> {
  if (c.kind === "GOSI_TREATMENT_SET") {
    const caseCode = c.payload.caseCode as string;
    const before = await tx.hrGosiTreatment.findUniqueOrThrow({ where: { caseCode } });
    const on = c.payload.enabled === true;
    // The DB requires this applied change, by two people, on the row (20261017170000).
    const row = await tx.hrGosiTreatment.update({ where: { caseCode }, data: {
      enabled: on, debitKey: on ? (c.payload.debitKey as string) : null, creditKey: on ? (c.payload.creditKey as string) : null,
      decisionReference: (c.payload.decisionReference as string | null) ?? null, requestedBy: c.requestedBy, approvedBy: approverId, approvedAt: new Date(), configChangeId: c.id, updatedAt: new Date(),
    } });
    return { action: "GOSI_TREATMENT_SET", entityType: "HrGosiTreatment", entityId: caseCode, before, after: row };
  }
  if (c.kind === "ACCOUNT_MAP_SET") {
    const key = c.payload.key as string, accountId = c.payload.accountId as string;
    await assertLegacyLinksBaselined(tx); // P2-A4, again at approval (the DB refuses it too)
    await postableAccount(tx, accountId); // still a postable leaf at approval time
    const before = await tx.hrAccountMap.findUnique({ where: { key } });
    if (before) await assertPayrollLive("ACCOUNT_REMAP", tx); // R1, again at approval
    const row = await tx.hrAccountMap.upsert({ where: { key }, create: { key, accountId, updatedBy: approverId }, update: { accountId, updatedBy: approverId } });
    return { action: "ACCOUNT_MAP_SET", entityType: "HrAccountMap", entityId: key, before, after: row };
  }
  if (c.kind === "PAYROLL_LIVE_SET") {
    const before = await settings(tx);
    const on = c.payload.payrollLive === true;
    // Independent review F5 / re-review R2: no permission, login or identity change can slip in
    // between the readiness re-check and the switch — the tables it reads were SHARE-locked as the
    // decision's first statement (decideConfigChange), before the Serializable snapshot.
    if (on) await assertPayrollReady(tx);
    await assertSwitchAllowed(tx, on);
    // The DB guard requires this applied change, by two people, to turn it on (20261017215000).
    const row = await tx.hrSettings.update({ where: { id: "singleton" }, data: { payrollLive: on, payrollLiveChangeId: on ? c.id : null, updatedBy: approverId } });
    return { action: "PAYROLL_LIVE_SET", entityType: "HrSettings", entityId: "singleton", before, after: row };
  }
  if (c.kind === "ACCOUNTING_TOGGLE") {
    const before = await settings(tx);
    const row = await tx.hrSettings.update({ where: { id: "singleton" }, data: { accountingEnabled: c.payload.accountingEnabled as boolean, updatedBy: approverId } });
    return { action: "SETTINGS_UPDATE", entityType: "HrSettings", entityId: "singleton", before, after: row };
  }
  if (c.kind === "LEAVE_TYPE_CONFIRM") {
    const before = await tx.hrLeaveType.findUniqueOrThrow({ where: { id: c.payload.leaveTypeId as string } });
    const n = await tx.hrLeaveType.updateMany({ where: { id: before.id, isProposal: true }, data: { isProposal: false } });
    if (n.count !== 1) throw new HrError("This leave type changed after the request; request again.", 409, "CONFIG_STALE");
    return { action: "LEAVE_TYPE_CONFIRM", entityType: "HrLeaveType", entityId: before.id, before: { isProposal: true }, after: { isProposal: false, code: before.code } };
  }
  if (c.kind === "PAYROLL_CONTROL_ATTEST") {
    // Nothing is changed: the applied request IS the record payroll checks (./payroll-controls).
    return { action: "PAYROLL_CONTROL_ATTEST", entityType: "HrPayrollAttestation", entityId: String(c.payload.subject), before: null, after: { ...c.payload } };
  }
  const p = c.payload;
  const t = await tx.hrLeaveType.create({
    data: { code: p.code as string, nameAr: p.nameAr as string, paid: p.paid as boolean, tracksBalance: p.tracksBalance as boolean, accrualDaysPerYear: p.accrualDaysPerYear === null ? null : new Prisma.Decimal(p.accrualDaysPerYear as string), allowNegative: p.allowNegative as boolean, isProposal: p.isProposal as boolean },
  });
  return { action: "LEAVE_TYPE_CREATE", entityType: "HrLeaveType", entityId: t.id, before: null, after: t };
}

type Row = Prisma.HrConfigChangeGetPayload<object>;
export function configChangeDto(r: Row, names?: Map<string, string>) {
  return {
    id: r.id, kind: r.kind, targetKey: r.targetKey, payload: r.payload, before: r.before, fingerprint: r.fingerprint, reason: r.reason, status: r.status,
    requestedBy: r.requestedBy, requestedByName: names?.get(r.requestedBy) ?? null, requestedAt: r.requestedAt,
    decidedBy: r.decidedBy, decidedByName: r.decidedBy ? names?.get(r.decidedBy) ?? null : null, decidedAt: r.decidedAt, decisionNote: r.decisionNote,
  };
}

/** GAP-9: live payroll is never turned on while the pre-activation readiness check reports anything. */
/**
 * Turning live payroll ON is never an application action (re-review R4; RC3 QA F3), whichever database
 * role the application connects as — the tables' owner included:
 *   · the database turns a switch on only inside the owner-run Phase 2 release step (hr_release_step_active:
 *     SET LOCAL hiqbah.release_step = 'phase2-activation'), which the application never sets;
 *   · under the release grants the runtime login cannot write the switch columns at all.
 * The application asks the database (the same guard), never the role's name, and answers 409
 * PAYROLL_NOT_READY plainly instead of failing at the write. Turning it OFF needs only the privilege.
 */
async function assertSwitchAllowed(db: Db, on: boolean) {
  const [p] = await db.$queryRaw<{ step: boolean; priv: boolean }[]>`SELECT hr_release_step_active() AS step, has_column_privilege(current_user, '"HrSettings"', 'payrollLive', 'UPDATE') AND has_column_privilege(current_user, '"HrSettings"', 'payrollLiveChangeId', 'UPDATE') AS priv`;
  if (!p?.priv || (on && !p.step)) throw new HrError("Live payroll cannot be switched from the application: this database reserves the switch for an owner-run release step (a migration). Ask the owner.", 409, "PAYROLL_NOT_READY");
}

async function assertPayrollReady(db: Db) {
  const r = await payrollReadiness(db);
  if (!r.ready) throw new HrError(`Live payroll cannot be turned on: the readiness check has ${r.findings.length} finding(s) (${[...new Set(r.findings.map((f) => f.code))].join(", ")}). Resolve them first.`, 409, "PAYROLL_NOT_READY");
}

export async function requestConfigChange(actor: HrActor, kind: ConfigKind, b: Record<string, unknown>) {
  assertCan(actor, "policy_manage");
  await assertVerifiedActor(actor, "CONFIG_CHANGE_REQUEST");
  const reason = reqText(b.reason, "reason", 300, 5);
  try {
    return await prisma.$transaction(async (tx) => {
      const p = await prepare(tx, kind, b);
      const row = await tx.hrConfigChange.create({ data: { kind, targetKey: p.targetKey, payload: p.payload as Prisma.InputJsonValue, before: (p.before ?? Prisma.JsonNull) as Prisma.InputJsonValue, fingerprint: configFingerprint(p), reason, requestedBy: actor.id } });
      await audit(tx, { action: "CONFIG_CHANGE_REQUEST", entityType: "HrConfigChange", entityId: row.id, after: { kind, targetKey: p.targetKey, payload: p.payload, before: p.before, fingerprint: row.fingerprint }, reason, actorId: actor.id });
      return { ...configChangeDto(row), applied: false };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    if ((e as { code?: string }).code === "P2002") throw new HrError("A change to this setting is already waiting for approval. Decide or withdraw it first.", 409, "CONFIG_PENDING");
    mapDbError(e);
  }
}

/**
 * Approve or reject. Approval names the fingerprint the approver reviewed (missing → 400,
 * different → 409) and is refused when the value in force changed since the request (409 stale);
 * the change is then applied in this transaction. The row is locked first, so a concurrent
 * decision or withdrawal either lands before (no longer PENDING → 409) or waits.
 */
export async function decideConfigChange(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "policy_manage");
  await assertVerifiedActor(actor, "CONFIG_CHANGE_DECIDE");
  const decision = oneOf(b.decision, "decision", ["APPROVE", "REJECT"] as const);
  const note = text(b.note, "note", { max: 500 });
  if (decision === "REJECT" && (!note || note.length < 3)) throw new HrError("A reason is required to reject.", 400);
  // F5: turning live payroll on is decided at SERIALIZABLE (readiness re-check + switch in one snapshot).
  const kindOf = await prisma.hrConfigChange.findUnique({ where: { id }, select: { kind: true } });
  const txOptions = kindOf?.kind === "PAYROLL_LIVE_SET" ? { ...TX, isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : TX;
  try {
    return await prisma.$transaction(async (tx) => {
      // Re-review R2: the live-payroll decision reads logins, their permissions and every person
      // link. Those tables are SHARE-locked as the FIRST statement — before the Serializable snapshot
      // is taken (LOCK is a utility statement) — so a reactivation, a new administrator, a grant or a
      // link / verification in flight either commits before the snapshot (and is seen by the
      // readiness re-check) or waits until this decision has committed. Writers wait; nobody slips in.
      if (kindOf?.kind === "PAYROLL_LIVE_SET") {
        await tx.$executeRawUnsafe(`LOCK TABLE "Employee", "HrEmployee", "HrEmployeePrivate", "HrExternalPerson", "HrIdentityVerification", "HrAuditLog" IN SHARE MODE`);
      }
      await tx.$queryRaw`SELECT 1 FROM "HrConfigChange" WHERE "id" = ${id} FOR UPDATE`;
      const c = await tx.hrConfigChange.findUnique({ where: { id } });
      // Only the settings kinds (QA2 P1-A: an allow-list). Permission grants and revocation reviews
      // have their own path and authority (./permission-change) and are invisible here.
      if (!c || !isSettingsKind(c.kind)) throw new HrError("Configuration change not found", 404);
      if (c.status !== "PENDING") throw new HrError(`Only a pending change can be decided (this one is ${c.status}).`, 409);
      // SIMPLE MODE: a single owner may decide their own request / act on their own record.
      if (!isSimpleMode() && (c.requestedBy === actor.id)) throw new HrError("You requested this change; another policy manager must decide it.", 403, "SELF_ACTION");
      // Decision 1: another PERSON too — not a second account of the requester's linked person.
      if (await samePersonAsAny(tx, [c.requestedBy], actor.id)) throw new HrError("You are the same person as the requester; another person must decide it.", 403, "SAME_PERSON");
      const now = new Date();
      if (decision === "REJECT") {
        const row = await tx.hrConfigChange.update({ where: { id }, data: { status: "REJECTED", decidedBy: actor.id, decidedAt: now, decisionNote: note } });
        await audit(tx, { action: "CONFIG_CHANGE_REJECT", entityType: "HrConfigChange", entityId: id, after: { kind: c.kind, targetKey: c.targetKey }, reason: note, actorId: actor.id });
        return { ...configChangeDto(row), applied: false };
      }
      const expected = typeof b.expected === "string" ? b.expected : "";
      if (!expected) throw new HrError("expected must name the change you reviewed (its fingerprint).", 400);
      if (expected !== c.fingerprint) throw new HrError("This is not the change you reviewed. Reload it and review it again.", 409, "CONFIG_CHANGED");
      const payload = c.payload as Record<string, unknown>;
      const kind = c.kind as ConfigKind;
      // P-2: a payroll attestation is approved only with the approver's own attestation.
      if (kind === "PAYROLL_CONTROL_ATTEST" && b.attested !== true) throw new HrError("Approving a payroll attestation needs your own attestation (attested: true) that you reviewed it.", 400, "ATTESTATION_REQUIRED");
      // Review P1-A1: the subject must still be attestable, and neither person may be a payee,
      // preparer or approver of the run concerned.
      if (kind === "PAYROLL_CONTROL_ATTEST") await assertAttestationDecidable(tx, c, actor.id);
      const now2 = await currentValue(tx, kind, payload);
      // Canonical (sorted-key) comparison: jsonb does not keep the key order it was written with.
      if (JSON.stringify(canonical(now2 ?? null)) !== JSON.stringify(canonical(c.before ?? null))) throw new HrError("The setting changed after this request was made, so it is stale. Withdraw it and request again.", 409, "CONFIG_STALE");
      // Marked APPLIED first, so what it changes can name it (the GOSI treatment guard requires that).
      const row = await tx.hrConfigChange.update({ where: { id }, data: { status: "APPLIED", decidedBy: actor.id, decidedAt: now, decisionNote: note } });
      const applied = await apply(tx, { id, requestedBy: c.requestedBy, kind, payload }, actor.id);
      await audit(tx, { action: "CONFIG_CHANGE_APPROVE", entityType: "HrConfigChange", entityId: id, after: { kind: c.kind, targetKey: c.targetKey, fingerprint: c.fingerprint }, reason: note, actorId: actor.id });
      // The application itself, on the changed record, naming both people.
      await audit(tx, { action: applied.action, entityType: applied.entityType, entityId: applied.entityId, before: applied.before, after: { ...(applied.after as object), configChangeId: id, requestedBy: c.requestedBy, approvedBy: actor.id }, reason: c.reason, actorId: actor.id });
      return { ...configChangeDto(row), applied: true };
    }, txOptions);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

export async function withdrawConfigChange(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "policy_manage");
  const note = text(b.note, "note", { max: 500 });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "HrConfigChange" WHERE "id" = ${id} FOR UPDATE`;
      const c = await tx.hrConfigChange.findUnique({ where: { id } });
      if (!c || !isSettingsKind(c.kind)) throw new HrError("Configuration change not found", 404);
      if (c.requestedBy !== actor.id) throw new HrError("Only the person who requested this change can withdraw it.", 403, "NOT_REQUESTER");
      if (c.status !== "PENDING") throw new HrError(`Only a pending change can be withdrawn (this one is ${c.status}).`, 409);
      const row = await tx.hrConfigChange.update({ where: { id }, data: { status: "WITHDRAWN", decidedAt: new Date(), decisionNote: note } });
      await audit(tx, { action: "CONFIG_CHANGE_WITHDRAW", entityType: "HrConfigChange", entityId: id, after: { kind: c.kind, targetKey: c.targetKey }, reason: note, actorId: actor.id });
      return { ...configChangeDto(row), applied: false };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

export async function listConfigChanges(actor: HrActor, q: { status?: string | null }) {
  assertCan(actor, "policy_manage");
  const status = q.status === "pending" ? "PENDING" : null;
  const rows = await prisma.hrConfigChange.findMany({ where: { kind: { in: [...CONFIG_KINDS] }, ...(status ? { status } : {}) }, orderBy: { requestedAt: "desc" }, take: 200 });
  const names = await accountNames(prisma, rows.flatMap((r) => [r.requestedBy, r.decidedBy]));
  return rows.map((r) => ({ ...configChangeDto(r, names), mine: r.requestedBy === actor.id }));
}
