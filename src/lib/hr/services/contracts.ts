// Native HR — versioned contracts and effective-dated compensation.
//
// ── Contracts ──
// DRAFT → ACTIVE → (SUPERSEDED | ENDED). At most one ACTIVE per person (partial unique index).
// Renewal writes the next version and supersedes the active one in a single transaction,
// for fixed-term AND open-ended contracts alike: an open-ended contract is closed the day
// before its successor starts.
//
// ── Compensation ──
// A new version closes the open one the day before it takes effect. Versions never overlap
// (trigger), are never edited or deleted, and a version may not start inside a month that
// already has an APPROVED or PAID payroll run (history stays as paid).
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, TX, assertCan, resolveScope, personInScope, audit, lock, int, oneOf, reqText, text, mapDbError } from "../core";
import { addDays, dayString, isDay, monthOf, parseDay } from "../dates";
import { parseAmount } from "../money";
import { compensationDto, contractDto } from "./people";

const TYPES = ["FIXED_TERM", "OPEN_ENDED"] as const;

function dayArg(v: unknown, field: string, required = true): Date | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HrError(`${field} is required.`, 400);
    return null;
  }
  if (!isDay(v)) throw new HrError(`${field} must be a date (YYYY-MM-DD).`, 400);
  return parseDay(v);
}

type ContractInput = { type: (typeof TYPES)[number]; startDate: Date; endDate: Date | null; probationDays: number | null; noticeDays: number; notes: string | null };

function parseContract(b: Record<string, unknown>): ContractInput {
  const type = oneOf(b.type, "type", TYPES);
  const startDate = dayArg(b.startDate, "startDate") as Date;
  const endDate = dayArg(b.endDate, "endDate", type === "FIXED_TERM");
  if (type === "OPEN_ENDED" && endDate) throw new HrError("An open-ended contract has no end date.", 400);
  if (endDate && endDate < startDate) throw new HrError("The contract cannot end before it starts.", 400);
  return {
    type, startDate, endDate,
    probationDays: int(b.probationDays, "probationDays", { min: 0, max: 365 }),
    noticeDays: int(b.noticeDays, "noticeDays", { min: 0, max: 365, required: true }) as number,
    notes: text(b.notes, "notes", { max: 1000 }),
  };
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

export async function createContract(actor: HrActor, employeeId: string, b: Record<string, unknown>) {
  assertCan(actor, "contracts_manage");
  const c = parseContract(b);
  return guarded(() => prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    const person = await personInScope(tx, scope, employeeId);
    await lock(tx, `contract:${employeeId}`);
    if (c.startDate < person.hireDate) throw new HrError("A contract cannot start before the hire date.", 400);
    const last = await tx.hrContract.findFirst({ where: { employeeId }, orderBy: { version: "desc" } });
    const version = (last?.version ?? 0) + 1;
    const row = await tx.hrContract.create({ data: { employeeId, contractNo: `C-${person.employeeNo}-${version}`, version, ...c, status: "DRAFT", createdBy: actor.id } });
    await audit(tx, { action: "CONTRACT_CREATE", entityType: "HrContract", entityId: row.id, employeeId, after: row, actorId: actor.id });
    return contractDto(row);
  }, TX));
}

/**
 * Activate a DRAFT. When another contract is ACTIVE it is superseded in the same
 * transaction: closed the day before the new one starts (open-ended included).
 */
export async function activateContract(actor: HrActor, employeeId: string, contractId: string) {
  assertCan(actor, "contracts_manage");
  return guarded(() => prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    await personInScope(tx, scope, employeeId);
    await lock(tx, `contract:${employeeId}`);
    const draft = await tx.hrContract.findFirst({ where: { id: contractId, employeeId } });
    if (!draft) throw new HrError("Contract not found", 404);
    if (draft.status !== "DRAFT") throw new HrError(`Only a DRAFT contract can be activated (this one is ${draft.status}).`, 409);
    const current = await tx.hrContract.findFirst({ where: { employeeId, status: "ACTIVE" } });
    if (current) {
      if (draft.startDate <= current.startDate) throw new HrError("A successor contract must start after the current one starts.", 400);
      const closeOn = addDays(draft.startDate, -1);
      await tx.hrContract.update({ where: { id: current.id }, data: { status: "SUPERSEDED", endDate: current.endDate && current.endDate < closeOn ? current.endDate : closeOn, endedAt: new Date(), endReason: `Superseded by ${draft.contractNo}` } });
    }
    const row = await tx.hrContract.update({ where: { id: draft.id }, data: { status: "ACTIVE", activatedBy: actor.id, activatedAt: new Date(), supersedesId: current?.id ?? null } });
    await audit(tx, { action: "CONTRACT_ACTIVATE", entityType: "HrContract", entityId: row.id, employeeId, before: current ? { superseded: current.contractNo } : null, after: row, actorId: actor.id });
    return contractDto(row);
  }, TX));
}

/** Renew = create the next version from the current one's terms (overridable) and activate it. */
export async function renewContract(actor: HrActor, employeeId: string, b: Record<string, unknown>) {
  assertCan(actor, "contracts_manage");
  // One transaction: the next version is written and the current one superseded together,
  // so a refused renewal leaves no orphan draft behind.
  return guarded(() => prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    const person = await personInScope(tx, scope, employeeId);
    await lock(tx, `contract:${employeeId}`);
    const current = await tx.hrContract.findFirst({ where: { employeeId, status: "ACTIVE" } });
    if (!current) throw new HrError("There is no active contract to renew.", 409);
    const startDefault = current.endDate ? dayString(addDays(current.endDate, 1)) : undefined;
    const c = parseContract({ type: current.type, noticeDays: current.noticeDays, startDate: startDefault, ...b });
    if (c.startDate <= current.startDate) throw new HrError("A successor contract must start after the current one starts.", 400);
    const last = await tx.hrContract.findFirst({ where: { employeeId }, orderBy: { version: "desc" } });
    const version = (last?.version ?? 0) + 1;
    const closeOn = addDays(c.startDate, -1);
    await tx.hrContract.update({ where: { id: current.id }, data: { status: "SUPERSEDED", endDate: current.endDate && current.endDate < closeOn ? current.endDate : closeOn, endedAt: new Date(), endReason: `Renewed as version ${version}` } });
    const row = await tx.hrContract.create({ data: { employeeId, contractNo: `C-${person.employeeNo}-${version}`, version, ...c, status: "ACTIVE", createdBy: actor.id, activatedBy: actor.id, activatedAt: new Date(), supersedesId: current.id } });
    await audit(tx, { action: "CONTRACT_RENEW", entityType: "HrContract", entityId: row.id, employeeId, before: { superseded: current.contractNo }, after: row, actorId: actor.id });
    return contractDto(row);
  }, TX));
}

export async function endContract(actor: HrActor, employeeId: string, contractId: string, b: Record<string, unknown>) {
  assertCan(actor, "contracts_manage");
  const endOn = dayArg(b.endDate, "endDate") as Date;
  const reason = reqText(b.reason, "reason", 500, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    await personInScope(tx, scope, employeeId);
    const c = await tx.hrContract.findFirst({ where: { id: contractId, employeeId } });
    if (!c) throw new HrError("Contract not found", 404);
    if (c.status !== "ACTIVE") throw new HrError("Only an active contract can be ended.", 409);
    if (endOn < c.startDate) throw new HrError("A contract cannot end before it starts.", 400);
    const row = await tx.hrContract.update({ where: { id: c.id }, data: { status: "ENDED", endDate: endOn, endedAt: new Date(), endReason: reason } });
    await audit(tx, { action: "CONTRACT_END", entityType: "HrContract", entityId: c.id, employeeId, before: c, after: row, reason, actorId: actor.id });
    return contractDto(row);
  }, TX));
}

// ── Compensation ───────────────────────────────────────────────────────────────────

function amount(v: unknown, field: string, allowZero: boolean) {
  if (v === undefined || v === null || v === "") {
    if (allowZero) return new Prisma.Decimal(0);
    throw new HrError(`${field} is required.`, 400);
  }
  try {
    return new Prisma.Decimal(parseAmount(v, { allowZero }).toString());
  } catch (e) {
    throw new HrError(`${field}: ${(e as Error).message}`, 400);
  }
}

export async function addCompensation(actor: HrActor, employeeId: string, b: Record<string, unknown>) {
  assertCan(actor, "contracts_manage");
  const effectiveFrom = dayArg(b.effectiveFrom, "effectiveFrom") as Date;
  const data = {
    basic: amount(b.basic, "basic", false),
    housing: amount(b.housing, "housing", true),
    transport: amount(b.transport, "transport", true),
    otherAllowance: amount(b.otherAllowance, "otherAllowance", true),
    reason: reqText(b.reason, "reason", 300, 3),
  };
  return guarded(() => prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    const person = await personInScope(tx, scope, employeeId);
    await lock(tx, `comp:${employeeId}`);
    if (effectiveFrom < person.hireDate) throw new HrError("Pay cannot take effect before the hire date.", 400);
    // History stays as paid: no new version may start in (or before) a month that already
    // has an approved or paid run covering this person.
    const settled = await tx.hrPayrollLine.findFirst({
      where: { employeeId, run: { status: { in: ["APPROVED", "PAID"] }, periodEnd: { gte: effectiveFrom } } },
      select: { run: { select: { periodMonth: true, status: true } } },
    });
    if (settled) {
      throw new HrError(`Payroll for ${settled.run.periodMonth} is already ${settled.run.status}. Pay changes take effect after it; correct an earlier month with a correction run.`, 409, "PERIOD_SETTLED");
    }
    const later = await tx.hrCompensation.findFirst({ where: { employeeId, effectiveFrom: { gte: effectiveFrom } } });
    if (later) throw new HrError(`A version already starts on ${dayString(later.effectiveFrom)}. Versions are added in date order and never rewritten.`, 409);
    const open = await tx.hrCompensation.findFirst({ where: { employeeId, effectiveTo: null } });
    if (open) await tx.hrCompensation.update({ where: { id: open.id }, data: { effectiveTo: addDays(effectiveFrom, -1) } });
    const contract = await tx.hrContract.findFirst({ where: { employeeId, status: "ACTIVE" }, select: { id: true } });
    const row = await tx.hrCompensation.create({ data: { employeeId, effectiveFrom, ...data, contractId: contract?.id ?? null, createdBy: actor.id } });
    await audit(tx, { action: "COMPENSATION_ADD", entityType: "HrCompensation", entityId: row.id, employeeId, before: open ? compensationDto(open) : null, after: compensationDto(row), reason: data.reason, actorId: actor.id });
    return compensationDto(row);
  }, TX));
}

export function monthOfDay(d: Date) {
  return monthOf(d);
}
