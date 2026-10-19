// Native HR — repeated deferral of advance installments (P-2 finding 2). Controls only.
//
// • The outstanding balance stays visible: `deferralReport` lists every disbursed advance whose
//   installments payroll has deferred, with the balance, the deferral count and what is open.
// • Deferrals are COUNTED CONSECUTIVELY (review P2-B7, S-3.5): the run of approved/paid runs,
//   latest first, in which an installment of the advance was deferred and none was taken; a run
//   that takes an installment ends the streak. After N consecutive (policy
//   `advanceDeferralEscalateAfter`, an accountant decision) a review item is raised, once, and the
//   preparer must acknowledge it when submitting a run of that person (services/payroll submitRun).
// • The way out is a SECOND-PERSON request (HrConfigChange-style): RESCHEDULE the remaining
//   installments (re-validated against the caps), or COLLECTION (take them out of payroll —
//   HELD — and collect them by an agreed method; a repayment then covers them). Never a
//   write-off: the outstanding balance is unchanged by either, and nothing is deducted that a
//   second person did not approve.
//
//   PENDING ──approve (other person, fingerprint, nothing changed since)──▶ APPLIED
//      ├──reject (other person, note)──▶ REJECTED
//      └──withdraw (requester)──▶ WITHDRAWN
// Database (migration 20261017100000_hr_p2_settlements): four eyes, one PENDING per advance,
// content immutable, nothing deleted; RESCHEDULED installments are history.
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, accountNames, assertAny, assertCan, assertNotSelf, audit, inScope, lock, mapDbError, oneOf, reqText, resolveScope, text, int } from "../core";
import { addMonths, isMonth, monthOf } from "../dates";
import { assertVerifiedActor, samePersonAsAny } from "../identity";
import { activePolicyFor } from "./policy";
import { capRefusal, installmentCapCheck, outstanding, schedule } from "./advances";
import { isSimpleMode } from "@/lib/simple-mode";

type Tx = Prisma.TransactionClient;
const ZERO = new Prisma.Decimal(0);

const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
const fingerprintOf = (x: unknown) => createHash("sha256").update(JSON.stringify(canonical(x))).digest("hex").slice(0, 24);

// ── Deferral count ────────────────────────────────────────────────────────────────

/**
 * Per advance: the CONSECUTIVE deferrals (latest approved/paid runs first, stopping at a run that
 * took an installment of it), the total number of deferring runs, and the latest deferred month.
 */
export async function deferralCounts(db: Db, advanceIds: string[]): Promise<Map<string, { count: number; total: number; lastMonth: string | null }>> {
  const out = new Map<string, { count: number; total: number; lastMonth: string | null }>();
  if (!advanceIds.length) return out;
  const rows = await db.$queryRaw<{ advanceId: string; runId: string; month: string; runNo: number; deferred: boolean; taken: boolean }[]>`
    SELECT i."advanceId" AS "advanceId", r."id" AS "runId", r."periodMonth" AS month, r."runNo" AS "runNo",
           bool_or((l."snapshot" -> 'deferredInstallments') @> jsonb_build_array(i."id")) AS deferred,
           bool_or(COALESCE(l."snapshot" -> 'installments', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', i."id"))) AS taken
      FROM "HrAdvanceInstallment" i
      JOIN "HrPayrollLine" l ON (l."snapshot" -> 'deferredInstallments') @> jsonb_build_array(i."id")
                             OR COALESCE(l."snapshot" -> 'installments', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', i."id"))
      JOIN "HrPayrollRun" r ON r."id" = l."runId"
     WHERE r."status" IN ('APPROVED', 'PAID') AND i."advanceId" = ANY(${advanceIds}::text[])
     GROUP BY 1, 2, 3, 4`;
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.advanceId, [...(by.get(r.advanceId) ?? []), r]);
  for (const [advanceId, list] of by) {
    list.sort((a, b) => b.month.localeCompare(a.month) || Number(b.runNo) - Number(a.runNo));
    let count = 0;
    for (const r of list) { if (r.deferred && !r.taken) count++; else break; }
    const deferring = list.filter((r) => r.deferred);
    out.set(advanceId, { count, total: deferring.length, lastMonth: deferring[0]?.month ?? null });
  }
  return out;
}

/** Open escalations (review items) of the advances of the people paid by a run (P2-B7). */
export async function escalatedAdvancesOf(db: Db, runId: string): Promise<{ reviewItemId: string; advanceNo: string; deferralCount: number }[]> {
  const people = (await db.hrPayrollLine.findMany({ where: { runId }, select: { employeeId: true } })).map((l) => l.employeeId);
  if (!people.length) return [];
  const items = await db.hrAdvanceReviewItem.findMany({ where: { status: "OPEN", advance: { employeeId: { in: people } } }, include: { advance: { select: { advanceNo: true } } }, orderBy: { createdAt: "asc" } });
  return items.map((i) => ({ reviewItemId: i.id, advanceNo: i.advance.advanceNo, deferralCount: i.deferralCount }));
}

/**
 * Raise a review item for every advance whose deferrals reached the policy's N. With `runId`:
 * the advances that run defers now (the run itself counts once when it is not yet approved);
 * called by payroll after building a run. Without: a scan of every disbursed advance (approved
 * runs only), under the policy in force today. Idempotent: one OPEN item per advance (DB).
 */
export async function escalateDeferrals(tx: Tx, opts: { runId?: string; actorId: string; on?: Date }): Promise<number> {
  let threshold: number | null;
  let candidates: Map<string, number>; // advanceId → runs to add (0 or 1)
  if (opts.runId) {
    const run = await tx.hrPayrollRun.findUniqueOrThrow({ where: { id: opts.runId }, include: { policy: true } });
    threshold = run.policy.advanceDeferralEscalateAfter;
    const lines = await tx.hrPayrollLine.findMany({ where: { runId: opts.runId }, select: { snapshot: true } });
    const ids = lines.flatMap((l) => ((l.snapshot as { deferredInstallments?: string[] } | null)?.deferredInstallments ?? []));
    if (!ids.length || threshold === null) return 0;
    const takenIds = lines.flatMap((l) => ((l.snapshot as { installments?: { id: string }[] } | null)?.installments ?? []).map((x) => x.id));
    const inst = await tx.hrAdvanceInstallment.findMany({ where: { id: { in: [...ids, ...takenIds] } }, select: { id: true, advanceId: true } });
    const takenAdv = new Set(inst.filter((i) => takenIds.includes(i.id)).map((i) => i.advanceId));
    const self = ["APPROVED", "PAID"].includes(run.status) ? 0 : 1;
    // A run that also takes an installment of the advance ends its streak: not a candidate.
    candidates = new Map(inst.filter((i) => ids.includes(i.id) && !takenAdv.has(i.advanceId)).map((i) => [i.advanceId, self]));
  } else {
    threshold = (await activePolicyFor(tx, opts.on ?? new Date()))?.advanceDeferralEscalateAfter ?? null;
    if (threshold === null) return 0;
    const open = await tx.hrAdvance.findMany({ where: { status: "DISBURSED" }, select: { id: true } });
    candidates = new Map(open.map((a) => [a.id, 0]));
  }
  const counts = await deferralCounts(tx, [...candidates.keys()]);
  let raised = 0;
  for (const [advanceId, extra] of candidates) {
    const n = (counts.get(advanceId)?.count ?? 0) + extra;
    if (n < threshold) continue;
    if (await tx.hrAdvanceReviewItem.findFirst({ where: { advanceId, status: "OPEN" } })) continue;
    const o = await outstanding(tx, advanceId);
    if (o.advance.status !== "DISBURSED") continue;
    const item = await tx.hrAdvanceReviewItem.create({ data: { advanceId, reason: "DEFERRAL_ESCALATION", deferralCount: n, threshold, outstanding: o.outstanding, createdBy: opts.actorId } });
    await audit(tx, { action: "ADVANCE_DEFERRAL_ESCALATED", entityType: "HrAdvance", entityId: advanceId, employeeId: o.advance.employeeId, after: { reviewItemId: item.id, deferralCount: n, threshold, outstanding: o.outstanding.toFixed(2), runId: opts.runId ?? null }, actorId: opts.actorId });
    raised++;
  }
  return raised;
}

export async function scanDeferrals(actor: HrActor, today: Date) {
  assertAny(actor, ["advances_manage", "advances_approve"]);
  if (!(await resolveScope(actor)).all) throw new HrError("The deferral scan needs the all-branches duty.", 403);
  return prisma.$transaction(async (tx) => ({ raised: await escalateDeferrals(tx, { actorId: actor.id, on: today }) }), TX);
}

// ── Report (read only) ────────────────────────────────────────────────────────────

/** Disbursed advances with anything deferred, overdue, escalated or pending. Changes nothing. */
export async function deferralReport(actor: HrActor, today: Date) {
  assertAny(actor, ["advances_manage", "advances_approve", "payroll_approve", "policy_manage"]);
  const scope = await resolveScope(actor);
  const policy = await activePolicyFor(prisma, today);
  const advances = await prisma.hrAdvance.findMany({
    where: { status: "DISBURSED", ...(scope.all ? {} : { employee: { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.reportIds } }] } }) },
    include: { employee: { select: { id: true, employeeNo: true, fullNameAr: true } }, installments: true, reviewItems: { where: { status: "OPEN" } }, recoveryRequests: { where: { status: "PENDING" } } },
    orderBy: { advanceNo: "asc" },
  });
  const counts = await deferralCounts(prisma, advances.map((a) => a.id));
  const thisMonth = monthOf(today);
  const rows = [];
  for (const a of advances) {
    const c = counts.get(a.id) ?? { count: 0, total: 0, lastMonth: null };
    const overdue = a.installments.filter((i) => i.status === "SCHEDULED" && i.dueMonth < thisMonth);
    const held = a.installments.filter((i) => i.status === "HELD");
    if (!c.total && !overdue.length && !held.length && !a.reviewItems.length && !a.recoveryRequests.length) continue;
    const o = await outstanding(prisma, a.id);
    rows.push({
      advanceId: a.id, advanceNo: a.advanceNo, employee: a.employee,
      outstanding: o.outstanding.toFixed(2), reserved: o.reserved.toFixed(2),
      deferralCount: c.count, deferralsTotal: c.total, lastDeferredMonth: c.lastMonth,
      overdueInstallments: overdue.length, overdueAmount: overdue.reduce((s, i) => s.plus(i.amount), ZERO).toFixed(2),
      heldInstallments: held.length, heldAmount: held.reduce((s, i) => s.plus(i.amount), ZERO).toFixed(2),
      openReviewItem: a.reviewItems[0] ? { id: a.reviewItems[0].id, deferralCount: a.reviewItems[0].deferralCount, threshold: a.reviewItems[0].threshold, createdAt: a.reviewItems[0].createdAt } : null,
      pendingRequest: a.recoveryRequests[0] ? { id: a.recoveryRequests[0].id, kind: a.recoveryRequests[0].kind, fingerprint: a.recoveryRequests[0].fingerprint } : null,
    });
  }
  return { asOfMonth: thisMonth, escalateAfter: policy?.advanceDeferralEscalateAfter ?? null, rows };
}

// ── Second-person recovery requests ──────────────────────────────────────────────

const METHODS = ["DIRECT_REPAYMENT", "FINAL_SETTLEMENT", "OTHER"] as const;

/** The state a request is made against: outstanding balance and the installments it would replace. */
async function recoveryBefore(db: Db, advanceId: string) {
  const o = await outstanding(db, advanceId);
  const remaining = o.advance.installments.filter((i) => i.status === "SCHEDULED").sort((x, y) => x.seq - y.seq);
  return {
    o,
    before: { outstanding: o.outstanding.toFixed(2), reserved: o.reserved.toFixed(2), remaining: remaining.map((i) => ({ id: i.id, seq: i.seq, dueMonth: i.dueMonth, amount: i.amount.toFixed(2) })) },
    remaining,
    remainingTotal: remaining.reduce((s, i) => s.plus(i.amount), ZERO),
  };
}

type Payload = { installmentCount?: number; firstInstallmentMonth?: string; method?: string; expectedBy?: string | null; note?: string | null };

function parsePayload(kind: "RESCHEDULE" | "COLLECTION", b: Record<string, unknown>, today: Date): Payload {
  if (kind === "RESCHEDULE") {
    const installmentCount = int(b.installmentCount, "installmentCount", { min: 1, max: 120, required: true }) as number;
    const firstInstallmentMonth = typeof b.firstInstallmentMonth === "string" ? b.firstInstallmentMonth : "";
    if (!isMonth(firstInstallmentMonth)) throw new HrError("firstInstallmentMonth must look like 2026-11.", 400);
    if (firstInstallmentMonth < monthOf(today)) throw new HrError("Installments cannot start in a past month.", 400);
    return { installmentCount, firstInstallmentMonth };
  }
  const expectedBy = text(b.expectedBy, "expectedBy", { max: 7 });
  if (expectedBy && !isMonth(expectedBy)) throw new HrError("expectedBy must look like 2026-11.", 400);
  return { method: oneOf(b.method, "method", METHODS), expectedBy, note: text(b.note, "note", { max: 500 }) };
}

function requestDto(r: Prisma.HrAdvanceRecoveryRequestGetPayload<object>, names?: Map<string, string>) {
  return {
    id: r.id, advanceId: r.advanceId, kind: r.kind, payload: r.payload, before: r.before, fingerprint: r.fingerprint, reason: r.reason, status: r.status,
    requestedBy: r.requestedBy, requestedByName: names?.get(r.requestedBy) ?? null, requestedAt: r.requestedAt,
    decidedBy: r.decidedBy, decidedByName: r.decidedBy ? names?.get(r.decidedBy) ?? null : null, decidedAt: r.decidedAt, decisionNote: r.decisionNote,
  };
}

async function loadAdvance(tx: Tx, actor: HrActor, advanceId: string) {
  const a = await tx.hrAdvance.findUnique({ where: { id: advanceId }, include: { employee: true } });
  if (!a || !inScope(await resolveScope(actor, tx), a.employee)) throw new HrError("Advance not found", 404);
  return a;
}

export async function requestRecovery(actor: HrActor, advanceId: string, b: Record<string, unknown>, today: Date) {
  assertCan(actor, "advances_manage");
  await assertVerifiedActor(actor, "ADVANCE_RECOVERY_REQUEST");
  const kind = oneOf(b.kind, "kind", ["RESCHEDULE", "COLLECTION"] as const);
  const reason = reqText(b.reason, "reason", 500, 5);
  const payload = parsePayload(kind, b, today);
  try {
    return await prisma.$transaction(async (tx) => {
      const a = await loadAdvance(tx, actor, advanceId);
      assertNotSelf(actor, a.employee, "request a recovery procedure");
      await lock(tx, `advance:${a.employeeId}`);
      if (a.status !== "DISBURSED") throw new HrError("Only a disbursed advance with an outstanding balance can be rescheduled or collected.", 409);
      const r = await recoveryBefore(tx, advanceId);
      if (!r.remaining.length) throw new HrError("This advance has no scheduled installments left to reschedule or collect.", 409, "NOTHING_REMAINING");
      if (kind === "RESCHEDULE") {
        // A new schedule is held to the same cap as a new advance: refused now if it can never fit.
        const c = await installmentCapCheck(tx, a.employeeId, r.remainingTotal, payload.installmentCount!, payload.firstInstallmentMonth!);
        if (!c.ok && c.code === "INSTALLMENT_OVER_CAP") throw capRefusal(c);
      }
      const fingerprint = fingerprintOf({ kind, advanceId, payload, before: r.before });
      const row = await tx.hrAdvanceRecoveryRequest.create({ data: { advanceId, kind, payload: payload as Prisma.InputJsonValue, before: r.before as Prisma.InputJsonValue, fingerprint, reason, requestedBy: actor.id } });
      await audit(tx, { action: "ADVANCE_RECOVERY_REQUEST", entityType: "HrAdvanceRecoveryRequest", entityId: row.id, employeeId: a.employeeId, after: { advanceNo: a.advanceNo, kind, payload, before: r.before, fingerprint }, reason, actorId: actor.id });
      return requestDto(row);
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    if ((e as { code?: string }).code === "P2002") throw new HrError("A recovery request for this advance is already waiting for a decision. Decide or withdraw it first.", 409, "RECOVERY_PENDING");
    mapDbError(e);
  }
}

/**
 * Approve or reject. Approval names the fingerprint reviewed and is refused when the advance
 * changed since (a run reserved or settled an installment, a repayment was recorded): stale.
 * Applied in the same transaction, with audit rows for the decision and the application.
 */
export async function decideRecovery(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "advances_approve");
  await assertVerifiedActor(actor, "ADVANCE_RECOVERY_DECIDE");
  const decision = oneOf(b.decision, "decision", ["APPROVE", "REJECT"] as const);
  const note = text(b.note, "note", { max: 500 });
  if (decision === "REJECT" && (!note || note.length < 3)) throw new HrError("A reason is required to reject.", 400);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "HrAdvanceRecoveryRequest" WHERE "id" = ${id} FOR UPDATE`;
      const c = await tx.hrAdvanceRecoveryRequest.findUnique({ where: { id } });
      if (!c) throw new HrError("Recovery request not found", 404);
      const a = await loadAdvance(tx, actor, c.advanceId);
      if (c.status !== "PENDING") throw new HrError(`Only a pending request can be decided (this one is ${c.status}).`, 409);
      // SIMPLE MODE: a single owner may decide their own request / act on their own record.
      if (!isSimpleMode() && (c.requestedBy === actor.id)) throw new HrError("You requested this change; another approver must decide it.", 403, "SELF_ACTION");
      if (await samePersonAsAny(tx, [c.requestedBy], actor.id)) throw new HrError("You are the same person as the requester; another person must decide it.", 403, "SAME_PERSON");
      assertNotSelf(actor, a.employee, "decide a recovery procedure");
      await lock(tx, `advance:${a.employeeId}`);
      const now = new Date();
      if (decision === "REJECT") {
        const row = await tx.hrAdvanceRecoveryRequest.update({ where: { id }, data: { status: "REJECTED", decidedBy: actor.id, decidedAt: now, decisionNote: note } });
        await audit(tx, { action: "ADVANCE_RECOVERY_REJECT", entityType: "HrAdvanceRecoveryRequest", entityId: id, employeeId: a.employeeId, reason: note, actorId: actor.id });
        return { ...requestDto(row), applied: false };
      }
      const expected = typeof b.expected === "string" ? b.expected : "";
      if (!expected) throw new HrError("expected must name the request you reviewed (its fingerprint).", 400);
      if (expected !== c.fingerprint) throw new HrError("This is not the request you reviewed. Reload it and review it again.", 409, "RECOVERY_CHANGED");
      const r = await recoveryBefore(tx, c.advanceId);
      if (JSON.stringify(canonical(r.before)) !== JSON.stringify(canonical(c.before))) throw new HrError("The advance changed after this request was made, so it is stale. Withdraw it and request again.", 409, "RECOVERY_STALE");
      const p = c.payload as Payload;
      let applied: unknown;
      if (c.kind === "RESCHEDULE") {
        // Re-validated at approval against the caps and pay in force now (they may have changed).
        const cap = await installmentCapCheck(tx, a.employeeId, r.remainingTotal, p.installmentCount!, p.firstInstallmentMonth!);
        if (!cap.ok) throw capRefusal(cap);
        const ids = r.remaining.map((i) => i.id);
        const n = await tx.hrAdvanceInstallment.updateMany({ where: { id: { in: ids }, status: "SCHEDULED" }, data: { status: "RESCHEDULED", recoveryRequestId: id } });
        if (n.count !== ids.length) throw new HrError("The advance changed after this request was made, so it is stale. Withdraw it and request again.", 409, "RECOVERY_STALE");
        const maxSeq = (await tx.hrAdvanceInstallment.aggregate({ where: { advanceId: c.advanceId }, _max: { seq: true } }))._max.seq ?? 0;
        const created = [];
        for (const s of schedule(r.remainingTotal, p.installmentCount!, p.firstInstallmentMonth!)) {
          created.push(await tx.hrAdvanceInstallment.create({ data: { advanceId: c.advanceId, seq: maxSeq + s.seq, dueMonth: s.dueMonth, amount: s.amount, recoveryRequestId: id } }));
        }
        applied = { replaced: ids.length, schedule: created.map((i) => ({ seq: i.seq, dueMonth: i.dueMonth, amount: i.amount.toFixed(2) })), lastMonth: addMonths(p.firstInstallmentMonth!, p.installmentCount! - 1) };
      } else {
        const ids = r.remaining.map((i) => i.id);
        const n = await tx.hrAdvanceInstallment.updateMany({ where: { id: { in: ids }, status: "SCHEDULED" }, data: { status: "HELD", recoveryRequestId: id } });
        if (n.count !== ids.length) throw new HrError("The advance changed after this request was made, so it is stale. Withdraw it and request again.", 409, "RECOVERY_STALE");
        applied = { held: ids.length, heldAmount: r.remainingTotal.toFixed(2), method: p.method, expectedBy: p.expectedBy ?? null };
      }
      const row = await tx.hrAdvanceRecoveryRequest.update({ where: { id }, data: { status: "APPLIED", decidedBy: actor.id, decidedAt: now, decisionNote: note } });
      await audit(tx, { action: "ADVANCE_RECOVERY_APPROVE", entityType: "HrAdvanceRecoveryRequest", entityId: id, employeeId: a.employeeId, after: { kind: c.kind, fingerprint: c.fingerprint }, reason: note, actorId: actor.id });
      const o = await outstanding(tx, c.advanceId);
      await audit(tx, { action: c.kind === "RESCHEDULE" ? "ADVANCE_RESCHEDULE" : "ADVANCE_COLLECTION", entityType: "HrAdvance", entityId: c.advanceId, employeeId: a.employeeId, before: c.before, after: { ...(applied as object), outstanding: o.outstanding.toFixed(2), recoveryRequestId: id, requestedBy: c.requestedBy, approvedBy: actor.id }, reason: c.reason, actorId: actor.id });
      // The escalation this answers is resolved by the applied request (never by a write-off).
      const item = await tx.hrAdvanceReviewItem.findFirst({ where: { advanceId: c.advanceId, status: "OPEN" } });
      if (item) {
        await tx.hrAdvanceReviewItem.update({ where: { id: item.id }, data: { status: "RESOLVED", resolvedBy: actor.id, resolvedAt: now, resolutionNote: `Recovery request ${c.kind} applied.`, recoveryRequestId: id } });
        await audit(tx, { action: "ADVANCE_REVIEW_RESOLVE", entityType: "HrAdvanceReviewItem", entityId: item.id, employeeId: a.employeeId, after: { recoveryRequestId: id }, actorId: actor.id });
      }
      return { ...requestDto(row), applied: true, outstanding: o.outstanding.toFixed(2) };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

export async function withdrawRecovery(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "advances_manage");
  const note = text(b.note, "note", { max: 500 });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "HrAdvanceRecoveryRequest" WHERE "id" = ${id} FOR UPDATE`;
      const c = await tx.hrAdvanceRecoveryRequest.findUnique({ where: { id } });
      if (!c) throw new HrError("Recovery request not found", 404);
      if (c.requestedBy !== actor.id) throw new HrError("Only the person who requested this change can withdraw it.", 403, "NOT_REQUESTER");
      if (c.status !== "PENDING") throw new HrError(`Only a pending request can be withdrawn (this one is ${c.status}).`, 409);
      const row = await tx.hrAdvanceRecoveryRequest.update({ where: { id }, data: { status: "WITHDRAWN", decidedAt: new Date(), decisionNote: note } });
      await audit(tx, { action: "ADVANCE_RECOVERY_WITHDRAW", entityType: "HrAdvanceRecoveryRequest", entityId: id, reason: note, actorId: actor.id });
      return requestDto(row);
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

/**
 * Close an escalation without a procedure (e.g. pay rose and the installment now fits). The
 * balance stays owed and payroll keeps deducting it: this records a reviewed decision, it
 * writes nothing off. Another person than whoever the item concerns; reason required.
 */
export async function resolveReviewItem(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "advances_approve");
  await assertVerifiedActor(actor, "ADVANCE_REVIEW_RESOLVE");
  const note = reqText(b.note, "note", 500, 5);
  return prisma.$transaction(async (tx) => {
    const item = await tx.hrAdvanceReviewItem.findUnique({ where: { id } });
    if (!item) throw new HrError("Review item not found", 404);
    const a = await loadAdvance(tx, actor, item.advanceId);
    assertNotSelf(actor, a.employee, "resolve a review of your own advance");
    const n = await tx.hrAdvanceReviewItem.updateMany({ where: { id, status: "OPEN" }, data: { status: "RESOLVED", resolvedBy: actor.id, resolvedAt: new Date(), resolutionNote: note } });
    if (n.count !== 1) throw new HrError("Only an open review item can be resolved.", 409);
    await audit(tx, { action: "ADVANCE_REVIEW_RESOLVE", entityType: "HrAdvanceReviewItem", entityId: id, employeeId: a.employeeId, reason: note, after: { outstanding: (await outstanding(tx, a.id)).outstanding.toFixed(2) }, actorId: actor.id });
    return { resolved: true };
  }, TX);
}

export async function listRecoveryRequests(actor: HrActor, q: { status?: string | null }) {
  assertAny(actor, ["advances_manage", "advances_approve"]);
  const scope = await resolveScope(actor);
  const rows = await prisma.hrAdvanceRecoveryRequest.findMany({
    where: { ...(q.status === "pending" ? { status: "PENDING" } : {}), ...(scope.all ? {} : { advance: { employee: { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.reportIds } }] } } }) },
    include: { advance: { select: { advanceNo: true, employee: { select: { employeeNo: true, fullNameAr: true } } } } },
    orderBy: { requestedAt: "desc" }, take: 200,
  });
  const names = await accountNames(prisma, rows.flatMap((r) => [r.requestedBy, r.decidedBy]));
  return rows.map((r) => ({ ...requestDto(r, names), advanceNo: r.advance.advanceNo, employee: r.advance.employee, mine: r.requestedBy === actor.id }));
}
