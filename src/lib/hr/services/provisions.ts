// Native HR — per-employee EOS / leave provision subledger (P-2 rev3 item 4, D-7g).
//
// Before rev3 a final settlement could use the provision up to the AGGREGATE balance of the mapped
// EOS_PROVISION / LEAVE_PROVISION ledger account (final-settlement.ts provisionLedgerBalance): one
// employee's settlement could consume provision recognised for others. Now:
//   · the provision is ATTRIBUTED per employee (HrProvisionLedger): a RECOGNITION names a POSTED
//     journal that credited the mapped provision account and attributes part of that credit to one
//     employee (never more, in total, than the journal credited); an ADJUSTMENT corrects it with a
//     reason. Both are requested by one person and approved by ANOTHER (DB four-eyes CHECK);
//   · a settlement uses at most THAT employee's approved balance (calculation and posting; the DB
//     refuses a negative balance under a per-employee lock), even when the aggregate would cover it;
//   · posting writes the USAGE (one per settlement and provision — never twice);
//   · a shortfall (due above the provision used) is never expensed automatically: it blocks posting
//     until a second person records the accountant's decision for exactly that amount (D-7g open;
//     strict default);
//   · the subledger is reconciled to the GL per provision key; differences are reported, never
//     corrected here.
// How the provision is MEASURED (statutory or actuarial, IAS 19 or IFRS for SMEs) is the
// accountant's decision; nothing here computes it. Migration 20261017180000.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, accountNames, assertAny, assertNotSelf, audit, lock, mapDbError, oneOf, personInScope, reqText, resolveScope, text } from "../core";
import { assertPayrollLive } from "../payroll-lock";
import { parseAmount } from "../money";
import { assertVerifiedActor, samePersonAsAny } from "../identity";

type Tx = Prisma.TransactionClient;
const ZERO = new Prisma.Decimal(0);
export const PROVISION_KEYS = ["EOS_PROVISION", "LEAVE_PROVISION"] as const;
export type ProvisionKey = (typeof PROVISION_KEYS)[number];

/** An employee's APPROVED provision balance for one key. */
export async function employeeProvisionBalance(db: Db, employeeId: string, key: ProvisionKey): Promise<Prisma.Decimal> {
  const a = await db.hrProvisionLedger.aggregate({ where: { employeeId, provisionKey: key, status: "APPROVED" }, _sum: { amount: true } });
  return a._sum.amount ?? ZERO;
}

/** The credit balance of POSTED / REVERSED journal lines on the account a key is mapped to (null: unmapped). */
export async function provisionGlBalance(db: Db, key: ProvisionKey): Promise<Prisma.Decimal | null> {
  const m = await db.hrAccountMap.findUnique({ where: { key } });
  if (!m) return null;
  const agg = await db.journalEntryLine.aggregate({ where: { accountId: m.accountId, journalEntry: { status: { in: ["POSTED", "REVERSED"] } } }, _sum: { debit: true, credit: true } });
  return (agg._sum.credit ?? ZERO).minus(agg._sum.debit ?? ZERO);
}

async function assertAccountingRole(actor: HrActor) {
  assertAny(actor, ["payroll_approve", "policy_manage"]);
  if (!(await resolveScope(actor)).all) throw new HrError("The provision subledger is company-wide: it needs the all-branches duty.", 403);
}

function amountOf(v: unknown, field: string, allowNegative: boolean): Prisma.Decimal {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  const neg = allowNegative && s.startsWith("-");
  try {
    const a = new Prisma.Decimal(parseAmount(neg ? s.slice(1) : s).toString());
    return neg ? a.negated() : a;
  } catch (e) {
    throw new HrError(`${field}: ${(e as Error).message}`, 400);
  }
}

/**
 * Request an attribution (RECOGNITION: part of a POSTED journal's credit to the mapped provision
 * account, for one employee) or an ADJUSTMENT (±, with a reason). Nothing counts until a second
 * person approves it.
 */
export async function requestProvisionEntry(actor: HrActor, b: Record<string, unknown>) {
  await assertAccountingRole(actor);
  await assertVerifiedActor(actor, "PROVISION_ENTRY_REQUEST");
  await assertPayrollLive("PROVISION_ENTRY");
  const kind = oneOf(b.kind, "kind", ["RECOGNITION", "ADJUSTMENT"] as const);
  const provisionKey = oneOf(b.provisionKey, "provisionKey", PROVISION_KEYS);
  const employeeId = reqText(b.employeeId, "employeeId", 40);
  const amount = amountOf(b.amount, "amount", kind === "ADJUSTMENT");
  const reference = reqText(b.reference, "reference", 200, 3);
  const reason = kind === "ADJUSTMENT" ? reqText(b.reason, "reason", 500, 5) : text(b.reason, "reason", { max: 500 });
  const journalEntryId = kind === "RECOGNITION" ? reqText(b.journalEntryId, "journalEntryId", 40) : null;
  try {
    return await prisma.$transaction(async (tx) => {
      await assertPayrollLive("PROVISION_ENTRY", tx); // F8: again inside the transaction
      const person = await personInScope(tx, await resolveScope(actor, tx), employeeId);
      assertNotSelf(actor, person, "attribute a provision");
      if (journalEntryId) {
        await lock(tx, `provision-journal:${journalEntryId}:${provisionKey}`);
        const m = await tx.hrAccountMap.findUnique({ where: { key: provisionKey } });
        const je = await tx.journalEntry.findUnique({ where: { id: journalEntryId }, select: { status: true, lines: { where: { accountId: m?.accountId ?? "-" }, select: { debit: true, credit: true } } } });
        if (!m) throw new HrError(`${provisionKey} is not mapped to a ledger account, so no provision can be attributed.`, 409, "PROVISION_NOT_IN_LEDGER");
        if (!je || je.status !== "POSTED") throw new HrError("journalEntryId must name a POSTED journal.", 400);
        const credited = je.lines.reduce((s, l) => s.plus(l.credit).minus(l.debit), ZERO);
        const taken = (await tx.hrProvisionLedger.aggregate({ where: { kind: "RECOGNITION", journalEntryId, provisionKey, status: { in: ["PENDING", "APPROVED"] } }, _sum: { amount: true } }))._sum.amount ?? ZERO;
        if (taken.plus(amount).greaterThan(credited)) throw new HrError(`This journal credited ${provisionKey} with ${credited.toFixed(2)}; ${taken.toFixed(2)} of it is already attributed, so ${amount.toFixed(2)} more cannot be.`, 409, "PROVISION_OVER_ATTRIBUTED");
      }
      const row = await tx.hrProvisionLedger.create({ data: { employeeId, provisionKey, kind, amount, status: "PENDING", sourceType: kind === "RECOGNITION" ? "JOURNAL" : "MANUAL", journalEntryId, reference, reason, requestedBy: actor.id } });
      await audit(tx, { action: "PROVISION_ENTRY_REQUEST", entityType: "HrProvisionLedger", entityId: row.id, employeeId, after: { kind, provisionKey, amount: amount.toFixed(2), journalEntryId, reference }, reason, actorId: actor.id });
      return entryDto(row);
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

/** Approve or reject a requested attribution / adjustment: another person (not the requester). */
export async function decideProvisionEntry(actor: HrActor, id: string, b: Record<string, unknown>) {
  await assertAccountingRole(actor);
  await assertVerifiedActor(actor, "PROVISION_ENTRY_DECIDE");
  await assertPayrollLive("PROVISION_ENTRY");
  const decision = oneOf(b.decision, "decision", ["APPROVE", "REJECT"] as const);
  const note = text(b.note, "note", { max: 500 });
  try {
    return await prisma.$transaction(async (tx) => {
      await assertPayrollLive("PROVISION_ENTRY", tx); // F8: again inside the transaction
      await tx.$queryRaw`SELECT 1 FROM "HrProvisionLedger" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.hrProvisionLedger.findUnique({ where: { id }, include: { employee: true } });
      if (!row) throw new HrError("Provision entry not found", 404);
      if (row.status !== "PENDING") throw new HrError(`Only a pending entry is decided (this one is ${row.status}).`, 409);
      if (await samePersonAsAny(tx, [row.requestedBy], actor.id)) throw new HrError("You requested this entry; another person must decide it.", 403, "SELF_ACTION");
      assertNotSelf(actor, row.employee, "decide a provision entry");
      const out = await tx.hrProvisionLedger.update({ where: { id }, data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED", approvedBy: actor.id, approvedAt: new Date() } });
      await audit(tx, { action: decision === "APPROVE" ? "PROVISION_ENTRY_APPROVE" : "PROVISION_ENTRY_REJECT", entityType: "HrProvisionLedger", entityId: id, employeeId: row.employeeId, after: { kind: row.kind, provisionKey: row.provisionKey, amount: row.amount.toFixed(2), requestedBy: row.requestedBy }, reason: note, actorId: actor.id });
      return entryDto(out);
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

function entryDto(r: Prisma.HrProvisionLedgerGetPayload<object>) {
  return { id: r.id, employeeId: r.employeeId, provisionKey: r.provisionKey, kind: r.kind, amount: r.amount.toFixed(2), status: r.status, sourceType: r.sourceType, sourceId: r.sourceId, journalEntryId: r.journalEntryId, reference: r.reference, reason: r.reason, requestedBy: r.requestedBy, approvedBy: r.approvedBy, approvedAt: r.approvedAt, createdAt: r.createdAt };
}

/**
 * Reconciliation (read only): per provision key, the subledger total (approved) against the GL
 * balance of the mapped account, with the difference flagged; per employee, the balance and its
 * movements. Never corrects anything.
 */
export async function provisionReconciliationReport(db: Db = prisma) {
  const keys = [];
  for (const key of PROVISION_KEYS) {
    const sub = (await db.hrProvisionLedger.aggregate({ where: { provisionKey: key, status: "APPROVED" }, _sum: { amount: true } }))._sum.amount ?? ZERO;
    const gl = await provisionGlBalance(db, key);
    const pending = await db.hrProvisionLedger.count({ where: { provisionKey: key, status: "PENDING" } });
    keys.push({ provisionKey: key, subledger: sub.toFixed(2), gl: gl?.toFixed(2) ?? null, difference: gl === null ? null : gl.minus(sub).toFixed(2), flagged: gl === null || !gl.equals(sub), pending, mapped: gl !== null });
  }
  const rows = await db.hrProvisionLedger.groupBy({ by: ["employeeId", "provisionKey"], where: { status: "APPROVED" }, _sum: { amount: true } });
  const people = await db.hrEmployee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, employeeNo: true, fullNameAr: true } });
  const by = new Map(people.map((p) => [p.id, p]));
  return {
    ok: keys.every((k) => !k.flagged),
    keys,
    employees: rows.map((r) => ({ employeeId: r.employeeId, employeeNo: by.get(r.employeeId)?.employeeNo ?? "?", fullNameAr: by.get(r.employeeId)?.fullNameAr ?? "?", provisionKey: r.provisionKey, balance: (r._sum.amount ?? ZERO).toFixed(2) })).sort((a, b) => a.employeeNo.localeCompare(b.employeeNo) || a.provisionKey.localeCompare(b.provisionKey)),
  };
}

export async function provisionReconciliation(actor: HrActor) {
  await assertAccountingRole(actor);
  return provisionReconciliationReport(prisma);
}

export async function employeeProvisions(actor: HrActor, employeeId: string) {
  assertAny(actor, ["payroll_approve", "policy_manage", "offboard"]);
  await personInScope(prisma, await resolveScope(actor), employeeId);
  const rows = await prisma.hrProvisionLedger.findMany({ where: { employeeId }, orderBy: { createdAt: "asc" } });
  const names = await accountNames(prisma, rows.flatMap((r) => [r.requestedBy, r.approvedBy]));
  return {
    balances: Object.fromEntries(await Promise.all(PROVISION_KEYS.map(async (k) => [k, (await employeeProvisionBalance(prisma, employeeId, k)).toFixed(2)]))),
    movements: rows.map((r) => ({ ...entryDto(r), requestedByName: names.get(r.requestedBy) ?? null, approvedByName: r.approvedBy ? names.get(r.approvedBy) ?? null : null })),
  };
}

// ── Use by a final settlement ──────────────────────────────────────────────────────

type SettlementProvision = { id: string; employeeId: string; eosAmount: Prisma.Decimal | null; leaveEncashmentAmount: Prisma.Decimal | null; eosProvisionAmount: Prisma.Decimal | null; leaveProvisionAmount: Prisma.Decimal | null };

/** Per provision: the amount due, the provision the settlement uses, and the shortfall between them. */
export function provisionUse(s: SettlementProvision): { key: ProvisionKey; due: Prisma.Decimal; used: Prisma.Decimal; shortfall: Prisma.Decimal }[] {
  const min = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.lessThan(b) ? a : b);
  return ([["EOS_PROVISION", s.eosAmount, s.eosProvisionAmount], ["LEAVE_PROVISION", s.leaveEncashmentAmount, s.leaveProvisionAmount]] as const).map(([key, due, prov]) => {
    const d = due ?? ZERO;
    const used = min(d, prov ?? ZERO);
    return { key, due: d, used, shortfall: d.minus(used) };
  });
}

/**
 * The provision a settlement uses never exceeds THAT employee's approved balance (409
 * PROVISION_EXCEEDS_EMPLOYEE), whatever the aggregate. Locks per employee and key (the same lock the
 * DB guard takes), always EOS before LEAVE.
 */
export async function assertWithinEmployeeProvision(tx: Tx, s: SettlementProvision) {
  for (const u of provisionUse(s)) {
    if (!u.used.greaterThan(0)) continue;
    await lock(tx, `provision-emp:${s.employeeId}:${u.key}`);
    const bal = await employeeProvisionBalance(tx, s.employeeId, u.key);
    if (u.used.greaterThan(bal)) throw new HrError(`The settlement uses ${u.used.toFixed(2)} of the ${u.key === "EOS_PROVISION" ? "end-of-service" : "leave"} provision, but this employee's attributed provision is ${bal.toFixed(2)}. A settlement uses at most the employee's own provision, even when the account's total would cover it (D-7g).`, 409, "PROVISION_EXCEEDS_EMPLOYEE");
  }
}

/**
 * D-7g strict default: a shortfall (due above the provision used) blocks posting unless a second
 * person recorded the accountant's decision for EXACTLY that amount. Never expensed automatically.
 */
export async function assertShortfallsDecided(tx: Tx, s: SettlementProvision) {
  for (const u of provisionUse(s)) {
    if (!u.shortfall.greaterThan(0)) continue;
    const d = await tx.hrProvisionShortfall.findFirst({ where: { settlementId: s.id, provisionKey: u.key, status: "APPROVED" } });
    if (!d || !d.amount.equals(u.shortfall)) throw new HrError(`The ${u.key === "EOS_PROVISION" ? "end-of-service" : "leave-encashment"} amount due (${u.due.toFixed(2)}) is above the provision it uses (${u.used.toFixed(2)}): a shortfall of ${u.shortfall.toFixed(2)} is never expensed automatically. It needs the accountant's decision, recorded by a second person, before posting (D-7g).`, 409, "PROVISION_SHORTFALL");
  }
}

/** Posting writes what the settlement took from the employee's provision (one USAGE per settlement and key). */
export async function recordUsage(tx: Tx, s: SettlementProvision & { settlementNo: string }, journalEntryId: string, actorId: string) {
  for (const u of provisionUse(s)) {
    if (!u.used.greaterThan(0)) continue;
    await tx.hrProvisionLedger.create({ data: { employeeId: s.employeeId, provisionKey: u.key, kind: "USAGE", amount: u.used.negated(), status: "APPROVED", sourceType: "FINAL_SETTLEMENT", sourceId: s.id, journalEntryId, reference: `Final settlement ${s.settlementNo}`, requestedBy: actorId, approvedBy: actorId, approvedAt: new Date() } });
  }
}

/** Request the shortfall decision of a settlement (amount = due − provision used, computed here). */
export async function requestProvisionShortfall(actor: HrActor, settlementId: string, b: Record<string, unknown>) {
  await assertAccountingRole(actor);
  await assertVerifiedActor(actor, "PROVISION_SHORTFALL_REQUEST");
  await assertPayrollLive("PROVISION_SHORTFALL");
  const provisionKey = oneOf(b.provisionKey, "provisionKey", PROVISION_KEYS);
  const decisionReference = reqText(b.decisionReference, "decisionReference", 200, 3);
  const reason = reqText(b.reason, "reason", 1000, 10);
  try {
    return await prisma.$transaction(async (tx) => {
      await assertPayrollLive("PROVISION_SHORTFALL", tx); // F8: again inside the transaction
      const s = await tx.hrFinalSettlement.findUnique({ where: { id: settlementId } });
      if (!s) throw new HrError("Final settlement not found", 404);
      await personInScope(tx, await resolveScope(actor, tx), s.employeeId);
      if (!["CALCULATED", "REVIEWED", "APPROVED"].includes(s.status)) throw new HrError("A shortfall is decided on a calculated settlement not yet posted.", 409, "SETTLEMENT_STATE");
      const u = provisionUse(s).find((x) => x.key === provisionKey)!;
      if (!u.shortfall.greaterThan(0)) throw new HrError("This settlement has no shortfall on that provision.", 409);
      // Review rev8 P3: a settlement recalculated after its shortfall was approved is not stuck. The
      // approved decision stays valid for exactly its amount (posting reuses it); for another amount it
      // LAPSES (DB: status only, never once the settlement used the provision) and a new one is asked.
      const prior = await tx.hrProvisionShortfall.findFirst({ where: { settlementId, provisionKey, status: "APPROVED" } });
      if (prior?.amount.equals(u.shortfall)) throw new HrError(`The shortfall of ${u.shortfall.toFixed(2)} is already decided for this settlement; posting uses that decision.`, 409, "SHORTFALL_EXISTS");
      if (prior) {
        await tx.hrProvisionShortfall.update({ where: { id: prior.id }, data: { status: "LAPSED" } });
        await audit(tx, { action: "PROVISION_SHORTFALL_LAPSE", entityType: "HrProvisionShortfall", entityId: prior.id, employeeId: s.employeeId, before: { amount: prior.amount.toFixed(2) }, after: { settlementNo: s.settlementNo, provisionKey, shortfallNow: u.shortfall.toFixed(2) }, reason, actorId: actor.id });
      }
      const row = await tx.hrProvisionShortfall.create({ data: { settlementId, employeeId: s.employeeId, provisionKey, amount: u.shortfall, employeeBalance: await employeeProvisionBalance(tx, s.employeeId, provisionKey), decisionReference, reason, requestedBy: actor.id } });
      await audit(tx, { action: "PROVISION_SHORTFALL_REQUEST", entityType: "HrProvisionShortfall", entityId: row.id, employeeId: s.employeeId, after: { settlementNo: s.settlementNo, provisionKey, amount: u.shortfall.toFixed(2), due: u.due.toFixed(2), used: u.used.toFixed(2), decisionReference }, reason, actorId: actor.id });
      return shortfallDto(row);
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    if ((e as { code?: string }).code === "P2002") throw new HrError("A shortfall decision for this settlement and provision already exists.", 409, "SHORTFALL_EXISTS");
    mapDbError(e);
  }
}

/** Decide a shortfall request: a person other than the requester and anyone who calculated the settlement. */
export async function decideProvisionShortfall(actor: HrActor, id: string, b: Record<string, unknown>) {
  await assertAccountingRole(actor);
  await assertVerifiedActor(actor, "PROVISION_SHORTFALL_DECIDE");
  await assertPayrollLive("PROVISION_SHORTFALL");
  const decision = oneOf(b.decision, "decision", ["APPROVE", "REJECT"] as const);
  const note = text(b.note, "note", { max: 500 });
  return prisma.$transaction(async (tx) => {
    await assertPayrollLive("PROVISION_SHORTFALL", tx); // F8: again inside the transaction
    await tx.$queryRaw`SELECT 1 FROM "HrProvisionShortfall" WHERE "id" = ${id} FOR UPDATE`;
    const row = await tx.hrProvisionShortfall.findUnique({ where: { id }, include: { settlement: true } });
    if (!row) throw new HrError("Shortfall decision not found", 404);
    if (row.status !== "PENDING") throw new HrError("This shortfall is already decided.", 409);
    if (await samePersonAsAny(tx, [row.requestedBy, row.settlement.preparedBy, row.settlement.calculatedBy].filter((x): x is string => !!x), actor.id)) throw new HrError("A shortfall is decided by a person other than the requester and whoever prepared or calculated the settlement.", 403, "SELF_ACTION");
    const u = provisionUse(row.settlement).find((x) => x.key === row.provisionKey)!;
    if (decision === "APPROVE" && !u.shortfall.equals(row.amount)) throw new HrError("The settlement changed after this shortfall was requested; request it again.", 409, "SHORTFALL_STALE");
    const out = await tx.hrProvisionShortfall.update({ where: { id }, data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note } });
    await audit(tx, { action: decision === "APPROVE" ? "PROVISION_SHORTFALL_APPROVE" : "PROVISION_SHORTFALL_REJECT", entityType: "HrProvisionShortfall", entityId: id, employeeId: row.employeeId, after: { amount: row.amount.toFixed(2), provisionKey: row.provisionKey, decisionReference: row.decisionReference, requestedBy: row.requestedBy }, reason: note, actorId: actor.id });
    return shortfallDto(out);
  }, TX);
}

function shortfallDto(r: Prisma.HrProvisionShortfallGetPayload<object>) {
  return { id: r.id, settlementId: r.settlementId, provisionKey: r.provisionKey, amount: r.amount.toFixed(2), employeeBalance: r.employeeBalance.toFixed(2), decisionReference: r.decisionReference, reason: r.reason, status: r.status, requestedBy: r.requestedBy, decidedBy: r.decidedBy, decidedAt: r.decidedAt };
}
