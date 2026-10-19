// Native HR — second-person payroll control ATTESTATIONS (HrConfigChange PAYROLL_CONTROL_ATTEST).
// P-2 review corrections P1-A1 and P1-B2.
//
// An attestation is a second person's signed statement that lets ONE named control exception
// through. It never changes an amount. What may be attested, and by whom:
//
//   · PROPOSAL_CORRECTION — a correction run of a month whose policy is still a proposal (E-1,
//     D-8a). Bound to the corrected run, to the exact policy content (fingerprint) and to that
//     run's approved pay record (digest). Used by ONE correction run only: the run records it
//     (HrPayrollRun.controlAttestationId, unique), so a cancelled run spends it — it expires with
//     the run.
//   · SEPARATION_EARNING — an earning adjustment for a person whose separation is initiated or
//     completed (P1-B2, SEPARATION_EARNING_REVIEW). Bound to the DRAFT run, the person and the
//     exact set of their earning adjustments (digest): any change needs a new attestation, and
//     it never outlives that run.
//   · UNPAID_FULL_PERIOD — NOT AVAILABLE (P1-A1). Whether pay may remain after a whole period of
//     unpaid leave is the accountant's decision D-2a, still open; no attestation can decide it.
//     New requests are refused, and a request made before this change can only be rejected or
//     withdrawn. The block clears only through corrected leave / attendance data.
//
// Independence (future-safe, whoever the owner later names under D-6c): neither the requester
// nor the attester (the approving second person) may be — by PERSON, not only by login — a payee
// of the run concerned, nor anyone who prepared or approved it. Checked when the attestation is
// decided AND every time it is relied on. No duty is added here: who may attest (D-6c) is the
// owner's decision; today any second policy manager may, subject to these exclusions.
import { createHash } from "node:crypto";
import { HrError, type Db, oneOf, reqText } from "../core";
import { personsOf, samePersonAsAny } from "../identity";
import { isSimpleMode } from "@/lib/simple-mode";
import { policyFingerprint } from "./policy";

export const ATTEST_SUBJECTS = ["PROPOSAL_CORRECTION", "SEPARATION_EARNING", "SEPARATION_CANCEL", "UNPAID_FULL_PERIOD"] as const;
export type AttestSubject = (typeof ATTEST_SUBJECTS)[number];
export const ATTESTATION_NOT_AVAILABLE = "ATTESTATION_NOT_AVAILABLE";
export const ATTESTER_CONFLICT = "ATTESTER_CONFLICT";
export const ATTESTATION_SPENT = "ATTESTATION_SPENT";

export const attestTarget = {
  proposalCorrection: (correctsRunId: string) => `PAYROLL_ATTEST:PROPOSAL_CORRECTION:${correctsRunId}`,
  separationEarning: (runId: string, employeeId: string) => `PAYROLL_ATTEST:SEPARATION_EARNING:${runId}:${employeeId}`,
  separationCancel: (separationId: string) => `PAYROLL_ATTEST:SEPARATION_CANCEL:${separationId}`,
};

/** Round-3 R3: the final-settlement records of a separation, as attested (any status; never deleted). */
export async function settlementRecordOf(db: Db, separationId: string) {
  const rows = await db.hrFinalSettlement.findMany({ where: { separationId }, orderBy: { id: "asc" }, select: { id: true, settlementNo: true, status: true, totalAmount: true } });
  return rows.map((r) => ({ id: r.id, settlementNo: r.settlementNo, status: r.status, total: r.totalAmount?.toFixed(2) ?? null }));
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
export const digestOf = (x: unknown) => createHash("sha256").update(JSON.stringify(canonical(x))).digest("hex").slice(0, 24);

// ── Who is involved in a run ────────────────────────────────────────────────────────

/**
 * Everyone who PREPARED a run: who created it, rebuilt it, added an adjustment to it or
 * submitted it (fields and audit rows that already exist).
 */
export async function runPreparerIds(db: Db, run: { id: string; preparedBy: string; submittedBy: string | null }): Promise<Set<string>> {
  const [adjustments, rows] = await Promise.all([
    db.hrPayrollAdjustment.findMany({ where: { runId: run.id }, select: { createdBy: true } }),
    db.hrAuditLog.findMany({ where: { entityType: "HrPayrollRun", entityId: run.id, action: { in: ["PAYROLL_PREPARE", "PAYROLL_REBUILD", "PAYROLL_ADJUSTMENT", "PAYROLL_SUBMIT"] } }, select: { actorId: true } }),
  ]);
  const ids = [run.preparedBy, run.submittedBy, ...adjustments.map((a) => a.createdBy), ...rows.map((r) => r.actorId)];
  return new Set(ids.filter((x): x is string => !!x));
}

/** Who approved lines of the run. */
export async function runApproverIds(db: Db, runId: string): Promise<Set<string>> {
  const rows = await db.hrPayrollLine.findMany({ where: { runId, approvedBy: { not: null } }, select: { approvedBy: true } });
  return new Set(rows.map((r) => r.approvedBy as string));
}

/** Whether `actorId` is (or was) the same person as one of these employees. */
export async function isPersonOf(db: Db, employeeIds: string[], actorId: string): Promise<boolean> {
  // SIMPLE MODE: the single owner is never refused as "the same person" as a payee / subject.
  if (isSimpleMode()) return false;
  if (!employeeIds.length) return false;
  if ((await db.hrEmployee.count({ where: { id: { in: employeeIds }, accountId: actorId } })) > 0) return true;
  const mine = await personsOf(db, [actorId]);
  return employeeIds.some((id) => mine.has(id));
}

/** Whether `actorId` is paid by a line of the run (login linked now or when built, or the same person). */
export async function isRunPayee(db: Db, runId: string, actorId: string): Promise<boolean> {
  if ((await db.hrPayrollLine.count({ where: { runId, OR: [{ employee: { accountId: actorId } }, { snapshot: { path: ["payeeAccountId"], equals: actorId } }] } })) > 0) return true;
  const ids = (await db.hrPayrollLine.findMany({ where: { runId }, select: { employeeId: true } })).map((l) => l.employeeId);
  return isPersonOf(db, ids, actorId);
}

/** Refuse when any of `people` (requester / attester) prepared or approved the run, or is paid by it. */
async function assertIndependentOfRun(db: Db, run: { id: string; preparedBy: string; submittedBy: string | null }, people: string[], what: string) {
  const preparers = await runPreparerIds(db, run);
  const approvers = await runApproverIds(db, run.id);
  for (const who of people) {
    if (await samePersonAsAny(db, preparers, who)) throw new HrError(`${what}: the requester and the attester may not have prepared the run concerned.`, 403, ATTESTER_CONFLICT);
    if (await samePersonAsAny(db, approvers, who)) throw new HrError(`${what}: the requester and the attester may not have approved the run concerned.`, 403, ATTESTER_CONFLICT);
    if (await isRunPayee(db, run.id, who)) throw new HrError(`${what}: the requester and the attester may not be paid by the run concerned.`, 403, ATTESTER_CONFLICT);
  }
}

// ── Pay record and adjustment digests ───────────────────────────────────────────────

/** The approved pay record of a run: every line's figures and the run totals (status excluded). */
export async function payRecordOf(db: Db, runId: string): Promise<string> {
  const run = await db.hrPayrollRun.findUniqueOrThrow({ where: { id: runId }, include: { lines: { select: { employeeId: true, gross: true, deductions: true, net: true, employer: true } } } });
  return digestOf({
    runId, month: run.periodMonth, kind: run.kind, policyId: run.policyId,
    totals: [run.totalGross.toFixed(2), run.totalDeductions.toFixed(2), run.totalNet.toFixed(2), run.totalEmployer.toFixed(2)],
    lines: run.lines.map((l) => [l.employeeId, l.gross.toFixed(2), l.deductions.toFixed(2), l.net.toFixed(2), l.employer.toFixed(2)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
}

/** One person's EARNING adjustments in one run, as attested (id, amount, category). */
export async function earningAdjustmentsOf(db: Db, runId: string, employeeId: string) {
  const rows = await db.hrPayrollAdjustment.findMany({ where: { runId, employeeId, kind: "EARNING" }, orderBy: { id: "asc" }, select: { id: true, amount: true, category: true } });
  return rows.map((r) => ({ id: r.id, amount: r.amount.toFixed(2), category: r.category }));
}

// ── Request (prepare) and staleness (current value) ─────────────────────────────────

type Prepared = { targetKey: string; payload: Record<string, unknown>; before: unknown };

export async function prepareAttestation(db: Db, b: Record<string, unknown>): Promise<Prepared> {
  const subject = oneOf(b.subject, "subject", ATTEST_SUBJECTS);
  if (subject === "UNPAID_FULL_PERIOD") throw unpaidUnavailable();
  const attestation = reqText(b.attestation, "attestation", 1000, 20);
  if (subject === "PROPOSAL_CORRECTION") {
    const correctsRunId = reqText(b.correctsRunId, "correctsRunId", 40);
    const run = await db.hrPayrollRun.findUnique({ where: { id: correctsRunId }, include: { policy: { include: { contributionRules: true } } } });
    if (!run || !["APPROVED", "PAID"].includes(run.status)) throw new HrError("A correction attestation names an APPROVED or PAID run.", 400);
    if (!run.policy.isProposal) throw new HrError("That run's policy is confirmed; a correction needs no attestation.", 400);
    const payload = { subject, correctsRunId, month: run.periodMonth, policyId: run.policy.id, policyVersion: run.policy.version, policyFingerprint: policyFingerprint(run.policy), payRecord: await payRecordOf(db, run.id), attestation };
    return { targetKey: attestTarget.proposalCorrection(correctsRunId), payload, before: await attestationCurrentValue(db, payload) };
  }
  if (subject === "SEPARATION_CANCEL") {
    // Round-3 R3: a separation that has final-settlement records is cancelled only with a second
    // person's attestation. The settlement records themselves stay (they are never deleted).
    const separationId = reqText(b.separationId, "separationId", 40);
    const sep = await db.hrSeparation.findUnique({ where: { id: separationId } });
    if (!sep || sep.status !== "INITIATED") throw new HrError("A separation-cancel attestation names an open (INITIATED) separation.", 400);
    const settlements = await settlementRecordOf(db, separationId);
    if (!settlements.length) throw new HrError("This separation has no final-settlement record; it is cancelled without an attestation.", 400);
    const payload = { subject, separationId, employeeId: sep.employeeId, settlements, digest: digestOf(settlements), attestation };
    return { targetKey: attestTarget.separationCancel(separationId), payload, before: await attestationCurrentValue(db, payload) };
  }
  // SEPARATION_EARNING
  const runId = reqText(b.runId, "runId", 40);
  const employeeId = reqText(b.employeeId, "employeeId", 40);
  const run = await db.hrPayrollRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "DRAFT") throw new HrError("A separation-earning attestation names a DRAFT run.", 400);
  const adjustments = await earningAdjustmentsOf(db, runId, employeeId);
  if (!adjustments.length) throw new HrError("This person has no earning adjustment in that run; there is nothing to attest.", 400);
  const payload = { subject, runId, employeeId, month: run.periodMonth, adjustments, digest: digestOf(adjustments), attestation };
  return { targetKey: attestTarget.separationEarning(runId, employeeId), payload, before: await attestationCurrentValue(db, payload) };
}

/** The state an attestation was requested against; approval is refused when it changed (stale). */
export async function attestationCurrentValue(db: Db, payload: Record<string, unknown>): Promise<unknown> {
  if (payload.subject === "PROPOSAL_CORRECTION") {
    const run = await db.hrPayrollRun.findUnique({ where: { id: payload.correctsRunId as string }, include: { policy: { include: { contributionRules: true } } } });
    return run ? { policyId: run.policy.id, isProposal: run.policy.isProposal, policyFingerprint: policyFingerprint(run.policy), payRecord: await payRecordOf(db, run.id) } : null;
  }
  if (payload.subject === "SEPARATION_CANCEL") {
    const sep = await db.hrSeparation.findUnique({ where: { id: payload.separationId as string }, select: { status: true } });
    return sep ? { status: sep.status, digest: digestOf(await settlementRecordOf(db, payload.separationId as string)) } : null;
  }
  if (payload.subject === "SEPARATION_EARNING") {
    const run = await db.hrPayrollRun.findUnique({ where: { id: payload.runId as string }, select: { status: true } });
    return run ? { runStatus: run.status, digest: digestOf(await earningAdjustmentsOf(db, payload.runId as string, payload.employeeId as string)) } : null;
  }
  return null;
}

function unpaidUnavailable() {
  return new HrError("An attestation cannot release pay for a whole period of unpaid leave: how much (if anything) remains is the accountant's decision D-2a, which is still open. Correct the leave or attendance data and rebuild the run.", 409, ATTESTATION_NOT_AVAILABLE);
}

/**
 * Before an attestation is APPROVED (inside the decision's transaction): the subject must still be
 * available, and neither the requester nor the attester may be a payee, preparer or approver of
 * the run concerned.
 */
export async function assertAttestationDecidable(db: Db, c: { payload: unknown; requestedBy: string }, attesterId: string) {
  const p = c.payload as Record<string, unknown>;
  if (p.subject === "UNPAID_FULL_PERIOD") throw unpaidUnavailable();
  if (p.subject === "PROPOSAL_CORRECTION") {
    const run = await db.hrPayrollRun.findUniqueOrThrow({ where: { id: p.correctsRunId as string } });
    await assertIndependentOfRun(db, run, [c.requestedBy, attesterId], "Proposal-correction attestation");
    return;
  }
  if (p.subject === "SEPARATION_CANCEL") {
    // The person leaving neither requests nor decides their own separation's cancellation.
    if (await isPersonOf(db, [p.employeeId as string], attesterId) || await isPersonOf(db, [p.employeeId as string], c.requestedBy)) throw new HrError("Separation-cancel attestation: the person concerned can neither request nor give it.", 403, ATTESTER_CONFLICT);
    return;
  }
  if (p.subject === "SEPARATION_EARNING") {
    const run = await db.hrPayrollRun.findUniqueOrThrow({ where: { id: p.runId as string } });
    // The requester may be the preparer (they raise it); the ATTESTER is independent of the run.
    await assertIndependentOfRun(db, run, [attesterId], "Separation-earning attestation");
    if (await isPersonOf(db, [p.employeeId as string], c.requestedBy)) throw new HrError("Separation-earning attestation: the payee cannot request it.", 403, ATTESTER_CONFLICT);
  }
}

// ── Use ─────────────────────────────────────────────────────────────────────────────

async function applied(db: Db, targetKey: string) {
  return db.hrConfigChange.findMany({ where: { kind: "PAYROLL_CONTROL_ATTEST", targetKey, status: "APPLIED" }, orderBy: { decidedAt: "desc" } });
}

/**
 * The applied PROPOSAL_CORRECTION attestation a correction run may rely on, or null. Valid only
 * while the corrected month's policy content and the corrected run's pay record are exactly what
 * was attested, while no OTHER run has used it (a cancelled run spends it), and while neither
 * person behind it prepared, approved or is paid by this correction run (`runId`, once it exists)
 * — `actorId` (the person acting now) included.
 */
export async function proposalCorrectionAttestation(db: Db, a: { correctsRunId: string; policyId: string; runId?: string; actorId: string }): Promise<{ id: string } | { refused: string } | null> {
  const rows = (await applied(db, attestTarget.proposalCorrection(a.correctsRunId))).filter((r) => (r.payload as { policyId?: string }).policyId === a.policyId);
  if (!rows.length) return null;
  const policy = await db.hrPayrollPolicy.findUniqueOrThrow({ where: { id: a.policyId }, include: { contributionRules: true } });
  const record = await payRecordOf(db, a.correctsRunId);
  let why = "";
  for (const r of rows) {
    const p = r.payload as { policyFingerprint?: string; payRecord?: string };
    if (p.policyFingerprint !== policyFingerprint(policy)) { why = "the policy content changed after it was attested"; continue; }
    if (p.payRecord !== record) { why = "the corrected run's pay record changed after it was attested"; continue; }
    const user = await db.hrPayrollRun.findFirst({ where: { controlAttestationId: r.id, ...(a.runId ? { id: { not: a.runId } } : {}) }, select: { runNo: true, status: true } });
    if (user) { why = `it was already used by correction run #${user.runNo} (${user.status}); an attestation expires with its run`; continue; }
    const people = [r.requestedBy, r.decidedBy as string];
    if (await samePersonAsAny(db, people, a.actorId)) { why = "the person acting now requested or gave it"; continue; }
    if (a.runId) {
      const run = await db.hrPayrollRun.findUniqueOrThrow({ where: { id: a.runId } });
      try { await assertIndependentOfRun(db, run, people, "Proposal-correction attestation"); } catch (e) { why = (e as Error).message; continue; }
    }
    return { id: r.id };
  }
  return { refused: why };
}

/**
 * The applied SEPARATION_EARNING attestation for this person in this run, or null: valid only for
 * the exact earning adjustments attested, with an attester who still neither prepared nor approved
 * (any line of) the run and is not the payee. Re-review N4: the attester never approves the run
 * either — `approveLines` refuses them (`assertSeparationEarningsApprovable`).
 */
export async function separationEarningAttestationRow(db: Db, run: { id: string; preparedBy: string; submittedBy: string | null }, employeeId: string): Promise<{ id: string; attester: string; requester: string } | null> {
  const rows = await applied(db, attestTarget.separationEarning(run.id, employeeId));
  if (!rows.length) return null;
  const digest = digestOf(await earningAdjustmentsOf(db, run.id, employeeId));
  const preparers = await runPreparerIds(db, run);
  const approvers = await runApproverIds(db, run.id);
  for (const r of rows) {
    if ((r.payload as { digest?: string }).digest !== digest) continue;
    const attester = r.decidedBy as string;
    if (await samePersonAsAny(db, preparers, attester)) continue;
    if (await samePersonAsAny(db, approvers, attester)) continue;
    if (await isPersonOf(db, [employeeId], attester)) continue;
    return { id: r.id, attester, requester: r.requestedBy };
  }
  return null;
}

export async function separationEarningAttestation(db: Db, run: { id: string; preparedBy: string; submittedBy: string | null }, employeeId: string): Promise<string | null> {
  return (await separationEarningAttestationRow(db, run, employeeId))?.id ?? null;
}

/**
 * Round-3 R3: the applied SEPARATION_CANCEL attestation that lets `actorId` cancel this separation,
 * or null — valid only while the separation's settlement records are exactly what was attested,
 * and only when the person acting now REQUESTED it (review rev9 P3: the cancellation is the one that
 * was attested — the DB checks the same, hr_separation_guard), neither gave it nor is the person
 * concerned (a second person decides).
 */
export async function separationCancelAttestation(db: Db, separationId: string, employeeId: string, actorId: string): Promise<string | null> {
  const rows = await applied(db, attestTarget.separationCancel(separationId));
  if (!rows.length) return null;
  const digest = digestOf(await settlementRecordOf(db, separationId));
  for (const r of rows) {
    if ((r.payload as { digest?: string }).digest !== digest) continue;
    if (r.requestedBy !== actorId) continue;
    if (await samePersonAsAny(db, [r.decidedBy as string], actorId)) continue;
    if (await isPersonOf(db, [employeeId], actorId)) continue;
    return r.id;
  }
  return null;
}
