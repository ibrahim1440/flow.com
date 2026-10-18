// Native HR — assets, training, reviews, incidents and offboarding.
import { revokeVerification } from "../identity";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, TX, assertCan, can, resolveScope, personInScope, audit, lock, assertNotSelf, int, oneOf, reqText, text, bool, mapDbError } from "../core";
import { dayString, isDay, monthOf, parseDay } from "../dates";
import { parseAmount } from "../money";
import { balances } from "./leave";
import { outstanding } from "./advances";
import { lockPeople, settlementJournalsIntact } from "./final-settlement";
import { separationCancelAttestation } from "./payroll-attest";
import { controlRefusal } from "./journal-integrity";

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}
const dayArg = (v: unknown, f: string) => {
  if (!isDay(v)) throw new HrError(`${f} must be a date.`, 400);
  return parseDay(v);
};

// ── Assets ─────────────────────────────────────────────────────────────────────────

export async function listAssets(actor: HrActor) {
  assertCan(actor, "assets_manage");
  const rows = await prisma.hrAsset.findMany({ orderBy: { tag: "asc" }, include: { assignments: { where: { returnedOn: null }, include: { employee: { select: { id: true, fullNameAr: true, employeeNo: true } } } } } });
  return rows.map((a) => ({ id: a.id, tag: a.tag, name: a.name, category: a.category, serialNo: a.serialNo, status: a.status, holder: a.assignments[0] ? { ...a.assignments[0].employee, assignmentId: a.assignments[0].id, since: dayString(a.assignments[0].assignedOn) } : null }));
}

export async function createAsset(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "assets_manage");
  return guarded(async () => {
    const a = await prisma.hrAsset.create({ data: { tag: reqText(b.tag, "tag", 30).toUpperCase(), name: reqText(b.name, "name", 120), category: reqText(b.category, "category", 60), serialNo: text(b.serialNo, "serialNo", { max: 80 }), notes: text(b.notes, "notes", { max: 500 }), createdBy: actor.id } });
    await audit(prisma, { action: "ASSET_CREATE", entityType: "HrAsset", entityId: a.id, after: a, actorId: actor.id });
    return a;
  });
}

export async function assignAsset(actor: HrActor, assetId: string, b: Record<string, unknown>) {
  assertCan(actor, "assets_manage");
  const employeeId = reqText(b.employeeId, "employeeId", 40);
  const assignedOn = dayArg(b.assignedOn, "assignedOn");
  return guarded(() => prisma.$transaction(async (tx) => {
    const person = await personInScope(tx, await resolveScope(actor, tx), employeeId);
    if (person.status === "SEPARATED") throw new HrError("This person has separated.", 409);
    const r = await tx.hrAsset.updateMany({ where: { id: assetId, status: "AVAILABLE" }, data: { status: "ASSIGNED" } });
    if (r.count !== 1) throw new HrError("This asset is not available.", 409);
    const x = await tx.hrAssetAssignment.create({ data: { assetId, employeeId, assignedOn, conditionOut: text(b.condition, "condition", { max: 200 }), assignedBy: actor.id } });
    await audit(tx, { action: "ASSET_ASSIGN", entityType: "HrAsset", entityId: assetId, employeeId, after: { assignmentId: x.id }, actorId: actor.id });
    return x;
  }, TX));
}

export async function returnAsset(actor: HrActor, assignmentId: string, b: Record<string, unknown>) {
  assertCan(actor, "assets_manage");
  const returnedOn = dayArg(b.returnedOn, "returnedOn");
  return guarded(() => prisma.$transaction(async (tx) => {
    const x = await tx.hrAssetAssignment.findUnique({ where: { id: assignmentId } });
    if (!x || x.returnedOn) throw new HrError("Open assignment not found.", 404);
    await personInScope(tx, await resolveScope(actor, tx), x.employeeId);
    if (returnedOn < x.assignedOn) throw new HrError("Return cannot precede assignment.", 400);
    await tx.hrAssetAssignment.update({ where: { id: assignmentId }, data: { returnedOn, conditionIn: text(b.condition, "condition", { max: 200 }), returnedBy: actor.id } });
    await tx.hrAsset.update({ where: { id: x.assetId }, data: { status: bool(b.retire, false) ? "RETIRED" : "AVAILABLE" } });
    await audit(tx, { action: "ASSET_RETURN", entityType: "HrAsset", entityId: x.assetId, employeeId: x.employeeId, actorId: actor.id });
    return { returned: true };
  }, TX));
}

// ── Training, reviews, incidents ───────────────────────────────────────────────────

export async function performanceFor(actor: HrActor, employeeId: string) {
  assertCan(actor, "performance_manage");
  await personInScope(prisma, await resolveScope(actor), employeeId);
  const [trainings, reviews, incidents] = await Promise.all([
    prisma.hrTraining.findMany({ where: { employeeId }, orderBy: { startDate: "desc" } }),
    prisma.hrReview.findMany({ where: { employeeId }, orderBy: { createdAt: "desc" } }),
    prisma.hrIncident.findMany({ where: { employeeId }, orderBy: { occurredOn: "desc" } }),
  ]);
  return {
    trainings: trainings.map((t) => ({ ...t, startDate: dayString(t.startDate), endDate: t.endDate ? dayString(t.endDate) : null })),
    reviews,
    incidents: incidents.map((i) => ({ ...i, occurredOn: dayString(i.occurredOn) })),
  };
}

export async function addTraining(actor: HrActor, employeeId: string, b: Record<string, unknown>) {
  assertCan(actor, "performance_manage");
  await personInScope(prisma, await resolveScope(actor), employeeId);
  const t = await guarded(() => prisma.hrTraining.create({ data: { employeeId, title: reqText(b.title, "title", 160), provider: text(b.provider, "provider", { max: 120 }), startDate: dayArg(b.startDate, "startDate"), endDate: b.endDate ? dayArg(b.endDate, "endDate") : null, status: oneOf(b.status, "status", ["PLANNED", "COMPLETED", "CANCELLED"] as const, "PLANNED"), notes: text(b.notes, "notes", { max: 1000 }), createdBy: actor.id } }));
  await audit(prisma, { action: "TRAINING_ADD", entityType: "HrTraining", entityId: t.id, employeeId, actorId: actor.id });
  return t;
}

export async function addReview(actor: HrActor, employeeId: string, b: Record<string, unknown>) {
  assertCan(actor, "performance_manage");
  return guarded(async () => {
    const person = await personInScope(prisma, await resolveScope(actor), employeeId);
    assertNotSelf(actor, person, "review");
    const r = await prisma.hrReview.create({ data: { employeeId, periodLabel: reqText(b.periodLabel, "periodLabel", 40), reviewerAccountId: actor.id, rating: int(b.rating, "rating", { min: 1, max: 5, required: true }) as number, strengths: text(b.strengths, "strengths", { max: 2000 }), improvements: text(b.improvements, "improvements", { max: 2000 }), status: "SUBMITTED", submittedAt: new Date() } });
    await audit(prisma, { action: "REVIEW_SUBMIT", entityType: "HrReview", entityId: r.id, employeeId, actorId: actor.id });
    return r;
  });
}

export async function addIncident(actor: HrActor, employeeId: string, b: Record<string, unknown>) {
  assertCan(actor, "performance_manage");
  const person = await personInScope(prisma, await resolveScope(actor), employeeId);
  assertNotSelf(actor, person, "record an incident");
  const i = await guarded(() => prisma.hrIncident.create({ data: { employeeId, occurredOn: dayArg(b.occurredOn, "occurredOn"), category: oneOf(b.category, "category", ["WARNING", "MISCONDUCT", "SAFETY", "ATTENDANCE", "OTHER"] as const), description: reqText(b.description, "description", 2000, 5), actionTaken: text(b.actionTaken, "actionTaken", { max: 1000 }), confidential: bool(b.confidential, true), recordedBy: actor.id } }));
  await audit(prisma, { action: "INCIDENT_ADD", entityType: "HrIncident", entityId: i.id, employeeId, actorId: actor.id });
  return i;
}

// ── Offboarding ────────────────────────────────────────────────────────────────────

export async function initiateSeparation(actor: HrActor, employeeId: string, b: Record<string, unknown>) {
  assertCan(actor, "offboard");
  const type = oneOf(b.type, "type", ["RESIGNATION", "TERMINATION", "END_OF_CONTRACT", "OTHER"] as const);
  const noticeDate = dayArg(b.noticeDate, "noticeDate");
  const lastWorkingDay = dayArg(b.lastWorkingDay, "lastWorkingDay");
  if (lastWorkingDay < noticeDate) throw new HrError("The last working day cannot precede the notice date.", 400);
  const reason = reqText(b.reason, "reason", 1000, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    await lockPeople(tx, [employeeId]);
    const person = await personInScope(tx, await resolveScope(actor, tx), employeeId);
    assertNotSelf(actor, person, "process the separation");
    if (person.status === "SEPARATED") throw new HrError("Already separated.", 409);
    if (lastWorkingDay < person.hireDate) throw new HrError("The last working day precedes the hire date.", 400);
    const s = await tx.hrSeparation.create({ data: { employeeId, type, noticeDate, lastWorkingDay, reason, deactivateAccount: bool(b.deactivateAccount, true), initiatedBy: actor.id } });
    await tx.hrEmployee.update({ where: { id: employeeId }, data: { status: "NOTICE", version: { increment: 1 } } });
    await audit(tx, { action: "SEPARATION_INITIATE", entityType: "HrSeparation", entityId: s.id, employeeId, before: { status: person.status }, after: { type, lastWorkingDay: dayString(lastWorkingDay) }, reason, actorId: actor.id });
    return s;
  }, TX));
}

/** What still blocks completion. Blocking: unreturned assets, open advances, pending leave. */
export async function clearance(actor: HrActor, separationId: string) {
  assertCan(actor, "offboard");
  const s = await prisma.hrSeparation.findUnique({ where: { id: separationId } });
  if (!s) throw new HrError("Separation not found", 404);
  await personInScope(prisma, await resolveScope(actor), s.employeeId);
  const [assets, advances, leaves, run, fin] = await Promise.all([
    prisma.hrAssetAssignment.findMany({ where: { employeeId: s.employeeId, returnedOn: null }, include: { asset: { select: { tag: true, name: true } } } }),
    prisma.hrAdvance.findMany({ where: { employeeId: s.employeeId, status: { in: ["REQUESTED", "APPROVED", "DISBURSED"] } } }),
    prisma.hrLeaveRequest.count({ where: { employeeId: s.employeeId, status: "PENDING" } }),
    prisma.hrPayrollLine.findFirst({ where: { employeeId: s.employeeId, run: { periodMonth: monthOf(s.lastWorkingDay), status: { in: ["APPROVED", "PAID"] } } }, select: { run: { select: { runNo: true, status: true } } } }),
    // P-2 finding 8: the financial settlement is its own record (it never completes the separation, nor the reverse).
    prisma.hrFinalSettlement.findFirst({ where: { separationId, status: { not: "CANCELLED" } }, select: { id: true, settlementNo: true, status: true, journalEntryId: true, paymentProofDocumentId: true, paymentJournalEntryId: true } }),
  ]);
  // Review P1-B1: re-checked here, not only at closing — the settlement's HR-linked journals must still stand.
  const finJournalsOk = fin ? await settlementJournalsIntact(prisma, fin) : false;
  const adv = await Promise.all(advances.map(async (a) => ({ advanceNo: a.advanceNo, status: a.status, outstanding: (await outstanding(prisma, a.id)).outstanding.toFixed(2) })));
  const items = [
    { key: "ASSETS", ok: assets.length === 0, blocking: true, detail: assets.map((a) => `${a.asset.tag} ${a.asset.name}`) },
    { key: "ADVANCES", ok: adv.length === 0, blocking: true, detail: adv.map((a) => `${a.advanceNo} ${a.status} ${a.outstanding}`) },
    { key: "PENDING_LEAVE", ok: leaves === 0, blocking: true, detail: leaves ? [`${leaves} طلب إجازة بانتظار القرار`] : [] },
    { key: "FINAL_PAYROLL", ok: !!run, blocking: false, detail: run ? [`المسير #${run.run.runNo} · ${run.run.status === "PAID" ? "مصروف" : "معتمد"}`] : ["لا يوجد مسير معتمد يغطي آخر يوم عمل بعد"] },
    // P-2 finding 8: done ONLY when the final settlement is CLOSED with its verified payment
    // evidence — never because a figure was typed in. `manual` marks hand-entered notes.
    { key: "SETTLEMENT", ok: fin?.status === "CLOSED" && !!fin.paymentProofDocumentId && !!fin.paymentJournalEntryId && finJournalsOk, blocking: false, manual: s.eosAmount !== null || s.otherSettlement !== null || s.leaveEncashmentDays !== null, detail: fin ? [`${fin.settlementNo} · ${fin.status}${finJournalsOk ? "" : " · JOURNAL_INTEGRITY"}`] : [] },
  ];
  return { separation: { ...s, noticeDate: dayString(s.noticeDate), lastWorkingDay: dayString(s.lastWorkingDay), eosAmount: s.eosAmount?.toFixed(2) ?? null, otherSettlement: s.otherSettlement?.toFixed(2) ?? null, leaveEncashmentDays: s.leaveEncashmentDays?.toString() ?? null }, items, leaveBalances: await balances(prisma, s.employeeId), canComplete: items.every((i) => i.ok || !i.blocking) };
}

/**
 * Record the final settlement figures. End of service is ENTERED with a mandatory basis
 * note — no statutory formula ships. These are notes only: the money is settled through the
 * final-settlement record (./final-settlement — evidenced, reviewed, approved, posted, paid),
 * NEVER through a payroll adjustment (refused: EOS_MISCLASSIFIED).
 */
export async function recordSettlement(actor: HrActor, separationId: string, b: Record<string, unknown>) {
  assertCan(actor, "offboard");
  const parse = (v: unknown, f: string) => (v === undefined || v === null || v === "" ? null : (() => { try { return new Prisma.Decimal(parseAmount(v, { allowZero: true }).toString()); } catch (e) { throw new HrError(`${f}: ${(e as Error).message}`, 400); } })());
  const eosAmount = parse(b.eosAmount, "eosAmount");
  const eosBasisNote = text(b.eosBasisNote, "eosBasisNote", { max: 1000 });
  if (eosAmount && (!eosBasisNote || eosBasisNote.length < 10)) throw new HrError("Explain how the end-of-service amount was determined (at least 10 characters).", 400);
  let encash: Prisma.Decimal | null = null;
  if (b.leaveEncashmentDays !== undefined && b.leaveEncashmentDays !== null && b.leaveEncashmentDays !== "") {
    try { encash = new Prisma.Decimal(String(b.leaveEncashmentDays)); } catch { throw new HrError("leaveEncashmentDays must be a number.", 400); }
  }
  return guarded(() => prisma.$transaction(async (tx) => {
    const s = await tx.hrSeparation.findUnique({ where: { id: separationId }, include: { employee: true } });
    if (!s || s.status !== "INITIATED") throw new HrError("Open separation not found", 404);
    await personInScope(tx, await resolveScope(actor, tx), s.employeeId);
    assertNotSelf(actor, s.employee, "record the settlement");
    // Review rev9 P3: the EOS amount on record is part of the end-of-service match, so it is
    // recorded once (DB: hr_separation_guard). A different figure is settled through the final
    // settlement record, not by editing this note.
    if (s.eosAmount !== null && !(eosAmount && eosAmount.equals(s.eosAmount))) throw new HrError(`The end-of-service amount on record (${s.eosAmount.toFixed(2)}) is recorded once and never changes; settle a different figure through the final settlement.`, 409, "EOS_AMOUNT_RECORDED");
    const row = await tx.hrSeparation.update({ where: { id: separationId }, data: { eosAmount, eosBasisNote, leaveEncashmentDays: encash, otherSettlement: parse(b.otherSettlement, "otherSettlement"), settlementNotes: text(b.settlementNotes, "settlementNotes", { max: 2000 }) } });
    await audit(tx, { action: "SETTLEMENT_RECORD", entityType: "HrSeparation", entityId: separationId, employeeId: s.employeeId, after: { eosAmount: eosAmount?.toFixed(2) ?? null, leaveEncashmentDays: encash?.toString() ?? null }, actorId: actor.id });
    return row;
  }, TX));
}

export async function completeSeparation(actor: HrActor, separationId: string) {
  assertCan(actor, "offboard");
  const c = await clearance(actor, separationId);
  if (!c.canComplete) throw new HrError(`Clearance is incomplete: ${c.items.filter((i) => !i.ok && i.blocking).map((i) => i.key).join(", ")}.`, 409, "CLEARANCE");
  return guarded(() => prisma.$transaction(async (tx) => {
    const s = await tx.hrSeparation.findUniqueOrThrow({ where: { id: separationId }, include: { employee: true } });
    if (s.status !== "INITIATED") throw new HrError("This separation is not open.", 409);
    assertNotSelf(actor, s.employee, "complete the separation");
    await lock(tx, `leave:${s.employeeId}`);
    await tx.hrSeparation.update({ where: { id: separationId }, data: { status: "COMPLETED", completedBy: actor.id, completedAt: new Date() } });
    await tx.hrEmployee.update({ where: { id: s.employeeId }, data: { status: "SEPARATED", separationDate: s.lastWorkingDay, version: { increment: 1 } } });
    await tx.hrContract.updateMany({ where: { employeeId: s.employeeId, status: "ACTIVE" }, data: { status: "ENDED", endDate: s.lastWorkingDay, endedAt: new Date(), endReason: `Separation: ${s.type}` } });
    await tx.hrShiftAssignment.updateMany({ where: { employeeId: s.employeeId, effectiveTo: null }, data: { effectiveTo: s.lastWorkingDay } });
    let deactivated = false;
    if (s.deactivateAccount && s.employee.accountId) {
      await tx.employee.update({ where: { id: s.employee.accountId }, data: { active: false } });
      deactivated = true;
    }
    // Review P3-7: a separated person is no longer a verified identity — revoked, with its audit row.
    await revokeVerification(tx, "EMPLOYEE", s.employeeId, actor.id, "Separation completed.");
    await audit(tx, { action: "SEPARATION_COMPLETE", entityType: "HrSeparation", entityId: separationId, employeeId: s.employeeId, after: { lastWorkingDay: dayString(s.lastWorkingDay), accountDeactivated: deactivated }, actorId: actor.id });
    return { completed: true, accountDeactivated: deactivated };
  }, TX));
}

export async function cancelSeparation(actor: HrActor, separationId: string, b: Record<string, unknown>) {
  assertCan(actor, "offboard");
  const reason = reqText(b.reason, "reason", 500, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    const owner = await tx.hrSeparation.findUnique({ where: { id: separationId }, select: { employeeId: true } });
    if (owner) await lockPeople(tx, [owner.employeeId]);
    const s = await tx.hrSeparation.findUnique({ where: { id: separationId } });
    if (!s || s.status !== "INITIATED") throw new HrError("Open separation not found", 404);
    await personInScope(tx, await resolveScope(actor, tx), s.employeeId);
    // Round-3 R3: a separation with final-settlement records is never cancelled by one person. A live
    // settlement is cancelled first; then an independent second person attests the cancellation
    // (PAYROLL_CONTROL_ATTEST / SEPARATION_CANCEL). The settlement records stay on record for good,
    // and keep counting in the end-of-service check (./final-settlement separationEarningContext).
    let attestationId: string | null = null;
    const settlements = await tx.hrFinalSettlement.findMany({ where: { separationId }, select: { settlementNo: true, status: true } });
    if (settlements.length) {
      const live = settlements.filter((x) => x.status !== "CANCELLED");
      if (live.length) throw new HrError(`This separation has a final settlement in progress (${live.map((x) => `${x.settlementNo} ${x.status}`).join(", ")}); cancel the settlement first.`, 409, "SETTLEMENT_LIVE");
      attestationId = await separationCancelAttestation(tx, separationId, s.employeeId, actor.id);
      if (!attestationId) throw await controlRefusal(new HrError("This separation has final-settlement records, so cancelling it needs an independent second person's attestation (PAYROLL_CONTROL_ATTEST, subject SEPARATION_CANCEL) — not from you and not from the person concerned. The settlement records stay on record either way.", 409, "SEPARATION_CANCEL_ATTESTATION"), { entityType: "HrSeparation", entityId: separationId, step: "CANCEL", actorId: actor.id });
    }
    await tx.hrSeparation.update({ where: { id: separationId }, data: { status: "CANCELLED", cancelledBy: actor.id, cancelledAt: new Date() } });
    const p = await tx.hrEmployee.findUniqueOrThrow({ where: { id: s.employeeId } });
    const restored = p.probationEndDate && p.probationEndDate >= s.createdAt ? "PROBATION" : "ACTIVE";
    await tx.hrEmployee.update({ where: { id: s.employeeId }, data: { status: restored, version: { increment: 1 } } });
    await audit(tx, { action: "SEPARATION_CANCEL", entityType: "HrSeparation", entityId: separationId, employeeId: s.employeeId, reason, after: attestationId ? { attestationId, settlements } : undefined, actorId: actor.id });
    return { cancelled: true };
  }, TX));
}

export async function openSeparationFor(actor: HrActor, employeeId: string) {
  assertCan(actor, "offboard");
  await personInScope(prisma, await resolveScope(actor), employeeId);
  const all = await prisma.hrSeparation.findMany({ where: { employeeId }, orderBy: { createdAt: "desc" } });
  const s = all.find((x) => x.status === "INITIATED") ?? null;
  const dto = (x: (typeof all)[number]) => ({ id: x.id, type: x.type, noticeDate: dayString(x.noticeDate), lastWorkingDay: dayString(x.lastWorkingDay), status: x.status, reason: x.reason, eosAmount: x.eosAmount?.toFixed(2) ?? null, eosBasisNote: x.eosBasisNote, leaveEncashmentDays: x.leaveEncashmentDays?.toString() ?? null, otherSettlement: x.otherSettlement?.toFixed(2) ?? null, completedAt: x.completedAt });
  return { separation: s ? dto(s) : null, history: all.map(dto) };
}

export function canSeeIncidents(actor: HrActor) {
  return can(actor, "performance_manage");
}
