// Native HR — end-of-service and leave-encashment FINANCIAL settlement (P-2 finding 8, E-7).
//
// An INTERIM MANUAL PROCEDURE, not a calculator: the amounts are worked out by hand outside the
// system (no formula ships — Arts. 84/85/111 and the "wage" definition are accountant decisions)
// and every step is EVIDENCED here and checked by the server:
//
//   DRAFT ─calculate─▶ CALCULATED ─review─▶ REVIEWED ─approve─▶ APPROVED ─post─▶ POSTED ─pay─▶ PAID ─close─▶ CLOSED
//     (inputs, method,      (independent person,  (another person)  (journal entry,   (proof document,
//      worksheet document)   attested)                               verified)          verified journal)
//   CALCULATED/REVIEWED ─return─▶ DRAFT · DRAFT…APPROVED ─cancel─▶ CANCELLED
//
// • Separate from ending the employment: an HrSeparation completes (or not) on its own; this
//   record is the money. Neither completes the other, and a settlement is never shown as paid
//   or complete without its verified evidence.
// • Accounting: booked against a recognised liability (provision) when one exists — the provision
//   amount is debited, only the excess is expensed — through the account-mapping hook (keys
//   EOS_PROVISION, EOS_EXPENSE, LEAVE_PROVISION, LEAVE_ENCASHMENT_EXPENSE, FINAL_SETTLEMENT_PAYABLE,
//   mapped by a second person). Never through payroll and never to a salary account.
// • Review P1-B1: the accrual and the payment are ALWAYS HR journals (SYSTEM): sourceDocumentId =
//   this settlement, Dr EOS / leave keys / Cr FINAL_SETTLEMENT_PAYABLE, then Dr
//   FINAL_SETTLEMENT_PAYABLE / Cr PAYROLL_CASH, each linked through HrJournalLink so the P-2 journal
//   guards protect them (no edit, no reversal outside HR). A MANUAL journal would be an
//   external-accounting route, and none is approved (D-6a): it is refused, 409
//   ACCOUNTING_REQUIRED, whatever the HR accounting setting. The journals are re-verified before
//   payment, at closing, on the clearance checklist and in the integrity report.
// • Review P2-B5: a provision is only used up to what the EOS_PROVISION / LEAVE_PROVISION ledger
//   accounts actually hold; a settlement without one is flagged for the accountant (S-7.6.5).
// • P-2 rev3 item 4 (D-7g, ./provisions): and never above THIS employee's attributed provision
//   (per-employee subledger), whatever the aggregate; posting records the usage once; a shortfall
//   (due above the provision used) blocks posting until the accountant's decision is recorded by a
//   second person — it is never expensed automatically.
// Database (migration 20261017100000_hr_p2_settlements): evidence CHECKs per status, forward-only
// transitions, evidence frozen once relied on, no delete.
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, accountNames, assertAny, assertCan, assertFresh, assertNotSelf, audit, lock, mapDbError, oneOf, personInScope, reqText, resolveScope, text } from "../core";
import { assertPayrollLive } from "../payroll-lock";
import { dayString, isDay, parseDay } from "../dates";
import { parseAmount } from "../money";
import { assertVerifiedActor, personsOf, samePersonAsAny } from "../identity";
import { assertPostingReady, postHrJournal, type HrJournalLine } from "./accounting-bridge";
import { ACCOUNTING_REQUIRED, assertJournalIntact, controlRefusal, journalProblems } from "./journal-integrity";
import { assertShortfallsDecided, assertWithinEmployeeProvision, employeeProvisionBalance, provisionUse, recordUsage } from "./provisions";

type Tx = Prisma.TransactionClient;
type Row = Prisma.HrFinalSettlementGetPayload<object>;
const ZERO = new Prisma.Decimal(0);

// ── Earnings for a separating person (review P1-B2) ─────────────────────────────────

/**
 * Every employee record of the same human as `employeeId` (round-3 R5): the record itself, and the
 * records reached through any login ever linked to it (`personsOf`: link history and the identity
 * number shared with an external person). Two employee records never share an identity number (DB
 * unique), so a second record WITHOUT one cannot be matched: `idMissing` says the same-person
 * check is incomplete for this record (a WARNING on the run line; RUNBOOK §5: identity numbers
 * complete before payroll is activated).
 */
export async function samePersonRecords(db: Db, employeeId: string): Promise<{ ids: string[]; idMissing: boolean }> {
  const e = await db.hrEmployee.findUnique({ where: { id: employeeId }, select: { accountId: true, private: { select: { idNumberNorm: true } } } });
  const hist = await db.hrAuditLog.findMany({ where: { entityType: "HrEmployee", entityId: employeeId, action: { in: ["ACCOUNT_LINK", "ACCOUNT_UNLINK"] } }, select: { before: true, after: true } });
  const accounts = new Set<string>();
  if (e?.accountId) accounts.add(e.accountId);
  for (const h of hist) for (const v of [h.before, h.after]) {
    const a = (v as { accountId?: unknown } | null)?.accountId;
    if (typeof a === "string" && a) accounts.add(a);
  }
  const persons = accounts.size ? await personsOf(db, [...accounts]) : new Set<string>();
  const ids = [...new Set([employeeId, ...[...persons].filter((k) => !k.startsWith("X:"))])].sort();
  return { ids, idMissing: !e?.private?.idNumberNorm };
}

/**
 * The separation context of a person, decided when it is checked (submission, every approval, and
 * entry) — never by when an adjustment was entered. P-2 rev3 item 5 (D-7i): the control is tied to
 * the EMPLOYMENT RELATIONSHIP (an employee record: hire date → last working day) and its settlement,
 * no longer "any separation ever":
 *   · a separation's scope STARTS when it is initiated and is ACTIVE while it is INITIATED, or
 *     COMPLETED with its final settlement not CLOSED (a CLOSED settlement already carries verified
 *     payment). It ENDS when the separation is CANCELLED (the cancellation needs the independent
 *     attestation when a settlement exists — workforce.cancelSeparation; history stays on record) or
 *     when the settlement is CLOSED after the relationship ended (COMPLETED);
 *   · it covers adjustments of THAT relationship: its own record, and any other record of the same
 *     human (`samePersonRecords`) whose service OVERLAPS it (hired on or before its last working day —
 *     a duplicate record, not a rehire). Then every earning adjustment on a line not yet approved is
 *     under review (SEPARATION_EARNING_REVIEW), and the cumulative earnings in scope reaching an
 *     amount on record of THAT separation (each of its settlements, any status — a split or renamed
 *     EOS — and its EOS amount) are end-of-service money (EOS_MISCLASSIFIED);
 *   · a REHIRE (another record of the same human hired after that last working day) is a new
 *     relationship. While the old relationship is not settled — no CLOSED settlement of it (the same
 *     test as the active scope: INITIATED, or COMPLETED with no settlement, only CANCELLED ones or an
 *     open one; review rev9 D5) — the strict default for the undecided
 *     parameter `rehireWhileSettlementOpen` (D-7i-3, review rev8 P2-b) applies: every earning of the
 *     rehire record is under review too (SEPARATION_EARNING_REVIEW, BLOCKING until attested) and
 *     counts towards that settlement's amounts. Once the old settlement is closed, nothing links them;
 *   · cumulative: earning adjustments of the relationship's records (and the rehire record) in runs
 *     not cancelled that are pending (DRAFT / REVIEW), approved since the separation was initiated,
 *     for its notice month or later, or entered since — plus `extra` (an adjustment being entered).
 *     PRIOR_PERIOD_ARREARS / COMMISSION_TRUE_UP COUNT as well (review rev8 P2-a): the route for
 *     legitimate dues (`legitimateDuesRoute`, D-7i-5) is undecided, so the strict default keeps them
 *     inside the end-of-service match. Their attestation clears the review only, never the match;
 *   · a matching amount alone never refuses for ever: once the scope ends, it no longer applies.
 * Null when no separation scope is active for the person.
 */
export async function separationEarningContext(db: Db, employeeId: string, extra: Prisma.Decimal = ZERO) {
  const group = await samePersonRecords(db, employeeId);
  const records = await db.hrEmployee.findMany({ where: { id: { in: group.ids } }, select: { id: true, hireDate: true } });
  const me = records.find((r) => r.id === employeeId);
  if (!me) return null;
  const seps = await db.hrSeparation.findMany({ where: { employeeId: { in: group.ids } }, orderBy: { createdAt: "asc" }, include: { finalSettlements: { select: { settlementNo: true, status: true, eosAmount: true, leaveEncashmentAmount: true, totalAmount: true } } } });
  type Sep = (typeof seps)[number];
  const active = (s: Sep) => s.status === "INITIATED" || (s.status === "COMPLETED" && !s.finalSettlements.some((f) => f.status === "CLOSED"));
  const overlaps = (r: { id: string; hireDate: Date }, s: Sep) => r.id === s.employeeId || r.hireDate <= s.lastWorkingDay;
  const scopes = seps.filter(active).map((s) => ({ s, kind: overlaps(me, s) ? ("RELATIONSHIP" as const) : ("REHIRE" as const) }));
  if (!scopes.length) return null;
  const evaluated = [];
  for (const { s, kind } of scopes) {
    const ids = [...new Set([me.id, ...records.filter((r) => overlaps(r, s)).map((r) => r.id)])];
    const since = s.createdAt;
    const notice = dayString(s.noticeDate).slice(0, 7);
    const adj = await db.hrPayrollAdjustment.findMany({
      where: {
        employeeId: { in: ids }, kind: "EARNING", run: { status: { not: "CANCELLED" } },
        OR: [{ run: { status: { in: ["DRAFT", "REVIEW"] } } }, { run: { approvedAt: { gte: since } } }, { run: { periodMonth: { gte: notice } } }, { createdAt: { gte: since } }],
      },
      select: { amount: true },
    });
    const cumulative = adj.reduce((t, a) => t.plus(a.amount), ZERO).plus(extra);
    const amounts: { label: string; amount: Prisma.Decimal }[] = [];
    for (const f of s.finalSettlements) for (const [label, v] of [["EOS", f.eosAmount], ["LEAVE_ENCASHMENT", f.leaveEncashmentAmount], ["TOTAL", f.totalAmount]] as const) if (v && v.greaterThan(0)) amounts.push({ label: `${f.settlementNo} ${label}`, amount: v });
    if (s.eosAmount && s.eosAmount.greaterThan(0)) amounts.push({ label: "separation EOS", amount: s.eosAmount });
    evaluated.push({ s, kind, since, notice, cumulative, amounts, reached: amounts.filter((a) => cumulative.greaterThanOrEqualTo(a.amount)) });
  }
  const relationship = evaluated.filter((e) => e.kind === "RELATIONSHIP");
  // D-7i-3 strict default: a rehire is reviewed while the old relationship is not settled — settled
  // means a CLOSED settlement (verified payment), exactly as `active` (review rev9 D5: a COMPLETED
  // separation with no settlement, or only CANCELLED ones, paid no EOS and is not settled).
  const unsettled = (s: Sep) => !s.finalSettlements.some((f) => f.status === "CLOSED");
  const rehireOpen = evaluated.filter((e) => e.kind === "REHIRE" && unsettled(e.s));
  const lead = evaluated.find((e) => e.reached.length) ?? relationship[0] ?? evaluated[0];
  const amounts = evaluated.flatMap((e) => e.amounts);
  return {
    separation: lead.s, since: lead.since, sinceMonth: lead.notice, cumulative: lead.cumulative,
    amounts, reached: evaluated.flatMap((e) => e.reached),
    max: amounts.reduce((m, a) => (a.amount.greaterThan(m) ? a.amount : m), ZERO),
    /** The separation of this record's own relationship in scope (null for a rehire record). */
    relationshipSeparation: relationship[0]?.s ?? null,
    /**
     * An earning of this record is under review: it belongs to a separating relationship, or it is a
     * rehire while the old relationship is not settled (D-7i-3, strict default).
     */
    reviewRequired: relationship.length > 0 || rehireOpen.length > 0,
    scopes: evaluated.map((e) => ({ separationId: e.s.id, kind: e.kind, status: e.s.status, since: e.since, sinceMonth: e.notice, cumulative: e.cumulative.toFixed(2) })),
    group,
  };
}

/**
 * rev3 item 5: a prior-period due (PRIOR_PERIOD_ARREARS / COMMISSION_TRUE_UP) for a person whose
 * relationship is in a separation scope is owed for a period BEFORE that separation (its last
 * working month or earlier). Anything later is not a prior-period due.
 */
export async function assertDuesPeriod(db: Db, employeeId: string, relatedPeriod: string) {
  const c = await separationEarningContext(db, employeeId);
  if (!c?.relationshipSeparation) return;
  const last = dayString(c.relationshipSeparation.lastWorkingDay).slice(0, 7);
  if (relatedPeriod > last) throw new HrError(`A prior-period due is owed for a period of the relationship before the separation (up to ${last}); ${relatedPeriod} is not.`, 400, "DUES_PERIOD");
}

/**
 * Serialise the separation checks of the people an operation touches (round-3 item 5; round-4
 * W6). Every employee id is expanded to all records of the same human; the union is
 * de-duplicated and sorted GLOBALLY, and each `separation-earnings:<id>` advisory lock is taken
 * once, up front, in that order, and held to commit. Every entry point takes its whole set in one
 * call (never a second, nested call), so two operations always lock in the same order and cannot
 * deadlock. Entry points: adjustment entry, submission and approval (after the payroll month lock,
 * before the run row — payroll.ts lockRunForChange), separation initiate / cancel, and settlement
 * create / calculate / return / post / cancel (before the settlement row). Settlement review,
 * approve, pay and close take no person lock: they change neither the amounts on record nor
 * whether the person is in scope.
 */
export async function lockPeople(tx: Tx, employeeIds: Iterable<string>) {
  const all = new Set<string>();
  for (const e of new Set(employeeIds)) for (const id of (await samePersonRecords(tx, e)).ids) all.add(id);
  for (const id of [...all].sort()) await lock(tx, `separation-earnings:${id}`);
}

/** The employee a final settlement belongs to (read before its row lock, to lock the person first). */
async function settlementEmployee(tx: Tx, id: string): Promise<string[]> {
  const s = await tx.hrFinalSettlement.findUnique({ where: { id }, select: { employeeId: true } });
  return s ? [s.employeeId] : [];
}

/**
 * Refused at entry (409 EOS_MISCLASSIFIED): an EARNING adjustment that would bring the person's
 * earning adjustments in scope to an end-of-service / leave-encashment amount on record — that
 * amount re-labelled or split. Below it, the line still needs an independent attestation
 * (SEPARATION_EARNING_REVIEW, ./payroll-controls). The caller has taken `lockPeople` for this
 * employee first (adjustment entry).
 */
export async function assertNotSettlementThroughPayroll(tx: Tx, employeeId: string, kind: string, amt: Prisma.Decimal) {
  if (kind !== "EARNING") return;
  const c = await separationEarningContext(tx, employeeId, amt);
  if (c?.reached.length) {
    throw new HrError(`Earning adjustments since this person's separation would total ${c.cumulative.toFixed(2)}, reaching the end-of-service / leave-encashment amount on record (${c.reached.map((r) => `${r.label} ${r.amount.toFixed(2)}`).join(", ")}). It is never paid through payroll, in one adjustment or several; use the final settlement.`, 409, "EOS_MISCLASSIFIED");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────────

type Stage = "DRAFT" | "CALCULATED" | "REVIEWED" | "APPROVED" | "POSTED" | "PAID" | "CLOSED";

function amount(v: unknown, field: string, opts: { allowZero?: boolean; required?: boolean } = {}): Prisma.Decimal | null {
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new HrError(`${field} is required.`, 400);
    return null;
  }
  try {
    return new Prisma.Decimal(parseAmount(v, { allowZero: opts.allowZero ?? true }).toString());
  } catch (e) {
    throw new HrError(`${field}: ${(e as Error).message}`, 400);
  }
}

function days(v: unknown): Prisma.Decimal {
  if (v === undefined || v === null || v === "") throw new HrError("leaveEncashmentDays is required.", 400);
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(String(v).trim())) throw new HrError("leaveEncashmentDays must be a number with at most two decimals.", 400);
  return new Prisma.Decimal(String(v).trim());
}

/** What the reviewer and the approver sign: the exact calculation and its evidence. */
export function calcFingerprint(s: Row): string {
  const c = {
    eos: s.eosAmount?.toFixed(2) ?? null, leaveDays: s.leaveEncashmentDays?.toString() ?? null, leave: s.leaveEncashmentAmount?.toFixed(2) ?? null, total: s.totalAmount?.toFixed(2) ?? null,
    inputs: s.calcInputs ?? null, method: s.calcMethodNote, reference: s.calcReference, document: s.calcDocumentId,
    eosProvision: s.eosProvisionAmount?.toFixed(2) ?? null, leaveProvision: s.leaveProvisionAmount?.toFixed(2) ?? null, provisionReference: s.provisionReference,
    reviewedBy: s.reviewedBy, reviewAttestation: s.reviewAttestation,
  };
  return createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0, 24);
}

/** A document of THIS employee, not deleted (attached evidence). */
async function evidenceDocument(db: Db, employeeId: string, id: unknown, field: string) {
  const docId = reqText(id, field, 40);
  const d = await db.hrDocument.findUnique({ where: { id: docId }, select: { id: true, employeeId: true, deletedAt: true, title: true } });
  if (!d || d.employeeId !== employeeId || d.deletedAt) throw new HrError(`${field} must name a document on this employee's file.`, 400, "EVIDENCE_MISSING");
  return d;
}

async function load(tx: Tx, actor: HrActor, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "HrFinalSettlement" WHERE "id" = ${id} FOR UPDATE`;
  const s = await tx.hrFinalSettlement.findUnique({ where: { id } });
  if (!s) throw new HrError("Final settlement not found", 404);
  const person = await personInScope(tx, await resolveScope(actor, tx), s.employeeId);
  return { s, person };
}

function expectStatus(s: Row, status: Stage | Stage[], what: string) {
  const ok = Array.isArray(status) ? status.includes(s.status as never) : s.status === status;
  if (!ok) throw new HrError(`Only a settlement in ${Array.isArray(status) ? status.join(" or ") : status} can be ${what} (this one is ${s.status}).`, 409, "SETTLEMENT_STATE");
}

/** Independence (owner decision 1: by PERSON): none of `accounts` may be the actor or the same person. */
async function assertIndependent(tx: Tx, actor: HrActor, accounts: (string | null)[], role: string) {
  const set = accounts.filter((x): x is string => !!x);
  if (await samePersonAsAny(tx, set, actor.id)) throw new HrError(`The ${role} must be a different person from whoever prepared, calculated, reviewed or approved this settlement.`, 403, "SOD_SETTLEMENT");
}

/** S-7.6.5: an amount due with no provision behind it is flagged to the accountant. */
export function provisionFlags(s: { eosAmount: Prisma.Decimal | null; leaveEncashmentAmount: Prisma.Decimal | null; eosProvisionAmount: Prisma.Decimal | null; leaveProvisionAmount: Prisma.Decimal | null }): string[] {
  const out: string[] = [];
  if (s.eosAmount?.greaterThan(0) && !s.eosProvisionAmount?.greaterThan(0)) out.push("NO_EOS_PROVISION");
  if (s.leaveEncashmentAmount?.greaterThan(0) && !s.leaveProvisionAmount?.greaterThan(0)) out.push("NO_LEAVE_PROVISION");
  return out;
}

/**
 * Review P2-B5: what the ledger actually holds on the account a provision key is mapped to — the
 * credit balance of POSTED journal lines (a provision is a liability). Null when the key is not
 * mapped (then no provision can be relied on).
 */
export async function provisionLedgerBalance(db: Db, key: "EOS_PROVISION" | "LEAVE_PROVISION"): Promise<Prisma.Decimal | null> {
  const m = await db.hrAccountMap.findUnique({ where: { key } });
  if (!m) return null;
  const agg = await db.journalEntryLine.aggregate({ where: { accountId: m.accountId, journalEntry: { status: { in: ["POSTED", "REVERSED"] } } }, _sum: { debit: true, credit: true } });
  return (agg._sum.credit ?? ZERO).minus(agg._sum.debit ?? ZERO);
}

/**
 * Refuse a provision the ledger does not hold (409 PROVISION_NOT_IN_LEDGER). Re-review N2: inside
 * the posting transaction an advisory lock per provision key is taken BEFORE the balance is read
 * (always EOS before LEAVE, so two postings never deadlock), and held until commit — two
 * settlements posted at the same time can no longer each use the whole balance.
 */
async function assertProvisionInLedger(db: Tx, s: { eosProvisionAmount: Prisma.Decimal | null; leaveProvisionAmount: Prisma.Decimal | null }) {
  for (const [key, amt] of [["EOS_PROVISION", s.eosProvisionAmount], ["LEAVE_PROVISION", s.leaveProvisionAmount]] as const) {
    if (!amt || !amt.greaterThan(0)) continue;
    await lock(db, `provision:${key}`);
    const bal = await provisionLedgerBalance(db, key);
    if (bal === null) throw new HrError(`A ${key === "EOS_PROVISION" ? "end-of-service" : "leave"} provision of ${amt.toFixed(2)} is claimed, but ${key} is not mapped to a ledger account, so it cannot be verified.`, 409, "PROVISION_NOT_IN_LEDGER");
    if (amt.greaterThan(bal)) throw new HrError(`A ${key === "EOS_PROVISION" ? "end-of-service" : "leave"} provision of ${amt.toFixed(2)} is claimed, but the ${key} ledger account holds ${bal.toFixed(2)}. Only a provision the ledger recognises can be used; the rest is expense, flagged for the accountant.`, 409, "PROVISION_NOT_IN_LEDGER");
  }
}

export function settlementDto(s: Row, names?: Map<string, string>) {
  const n = (x: string | null) => (x ? names?.get(x) ?? null : null);
  const evidence = {
    calculated: !!(s.calculatedAt && s.calcDocumentId),
    reviewed: !!(s.reviewedBy && s.reviewAttestation),
    approved: !!s.approvedBy,
    posted: !!s.journalEntryId,
    paid: !!(s.paidAt && s.paymentProofDocumentId && s.paymentJournalEntryId),
    closed: !!s.closedAt,
  };
  return {
    id: s.id, settlementNo: s.settlementNo, separationId: s.separationId, employeeId: s.employeeId, status: s.status,
    // Never "paid" or "complete" unless the evidence is on the record (and the DB requires it).
    isPaid: (s.status === "PAID" || s.status === "CLOSED") && evidence.paid,
    isClosed: s.status === "CLOSED" && evidence.paid && evidence.closed,
    evidence,
    eosAmount: s.eosAmount?.toFixed(2) ?? null, leaveEncashmentDays: s.leaveEncashmentDays?.toString() ?? null, leaveEncashmentAmount: s.leaveEncashmentAmount?.toFixed(2) ?? null, totalAmount: s.totalAmount?.toFixed(2) ?? null,
    calcInputs: s.calcInputs, calcMethodNote: s.calcMethodNote, calcReference: s.calcReference, calcDocumentId: s.calcDocumentId,
    eosProvisionAmount: s.eosProvisionAmount?.toFixed(2) ?? null, leaveProvisionAmount: s.leaveProvisionAmount?.toFixed(2) ?? null, provisionReference: s.provisionReference,
    // Review P2-B5 / S-7.6.5: booked with no recognised provision → for the accountant's attention.
    flags: provisionFlags(s),
    fingerprint: s.calculatedAt ? calcFingerprint(s) : null,
    preparedBy: s.preparedBy, preparedByName: n(s.preparedBy), createdAt: s.createdAt,
    calculatedBy: s.calculatedBy, calculatedByName: n(s.calculatedBy), calculatedAt: s.calculatedAt,
    reviewedBy: s.reviewedBy, reviewedByName: n(s.reviewedBy), reviewedAt: s.reviewedAt, reviewAttestation: s.reviewAttestation,
    approvedBy: s.approvedBy, approvedByName: n(s.approvedBy), approvedAt: s.approvedAt, approvalNote: s.approvalNote,
    postingMode: s.postingMode, journalEntryId: s.journalEntryId, postedBy: s.postedBy, postedByName: n(s.postedBy), postedAt: s.postedAt,
    paidAmount: s.paidAmount?.toFixed(2) ?? null, paidOn: s.paidOn ? dayString(s.paidOn) : null, paymentReference: s.paymentReference, paymentProofDocumentId: s.paymentProofDocumentId, paymentJournalEntryId: s.paymentJournalEntryId,
    paidBy: s.paidBy, paidByName: n(s.paidBy), paidAt: s.paidAt,
    closedBy: s.closedBy, closedByName: n(s.closedBy), closedAt: s.closedAt, closingNote: s.closingNote,
    cancelledBy: s.cancelledBy, cancelledAt: s.cancelledAt, cancelReason: s.cancelReason,
  };
}

async function dtoOf(db: Db, id: string) {
  const s = await db.hrFinalSettlement.findUniqueOrThrow({ where: { id }, include: { provisionShortfalls: true } });
  const dto = settlementDto(s, await accountNames(db, [s.preparedBy, s.calculatedBy, s.reviewedBy, s.approvedBy, s.postedBy, s.paidBy, s.closedBy]));
  // P-2 rev3 item 4: the employee's own provision, what this settlement uses of it, and any shortfall.
  const provision = s.calculatedAt ? await Promise.all(provisionUse(s).map(async (u) => {
    const d = s.provisionShortfalls.find((x) => x.provisionKey === u.key && (x.status === "PENDING" || x.status === "APPROVED"));
    return { key: u.key, due: u.due.toFixed(2), used: u.used.toFixed(2), shortfall: u.shortfall.toFixed(2), employeeBalance: (await employeeProvisionBalance(db, s.employeeId, u.key)).toFixed(2), shortfallDecision: d ? { id: d.id, status: d.status, decisionReference: d.decisionReference, amount: d.amount.toFixed(2) } : null };
  })) : null;
  return { ...dto, provision };
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HrError) throw e;
    if ((e as { code?: string }).code === "P2002") throw new HrError("This separation already has a live final settlement.", 409, "SETTLEMENT_EXISTS");
    mapDbError(e);
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────────

export async function settlementsForSeparation(actor: HrActor, separationId: string) {
  assertAny(actor, ["offboard", "payroll_approve", "payroll_pay"]);
  const sep = await prisma.hrSeparation.findUnique({ where: { id: separationId } });
  if (!sep) throw new HrError("Separation not found", 404);
  await personInScope(prisma, await resolveScope(actor), sep.employeeId);
  const rows = await prisma.hrFinalSettlement.findMany({ where: { separationId }, orderBy: { createdAt: "desc" } });
  const names = await accountNames(prisma, rows.flatMap((s) => [s.preparedBy, s.calculatedBy, s.reviewedBy, s.approvedBy, s.postedBy, s.paidBy, s.closedBy]));
  const live = rows.find((r) => r.status !== "CANCELLED") ?? null;
  const docs = await prisma.hrDocument.findMany({ where: { employeeId: sep.employeeId, deletedAt: null }, select: { id: true, title: true, category: true }, orderBy: { createdAt: "desc" } });
  // P-2 rev3 item 4: the live settlement carries the employee's own provision and any shortfall.
  return { separation: { id: sep.id, status: sep.status, lastWorkingDay: dayString(sep.lastWorkingDay) }, settlement: live ? await dtoOf(prisma, live.id) : null, history: rows.map((r) => settlementDto(r, names)), documents: docs };
}

// ── Transitions ───────────────────────────────────────────────────────────────────

export async function createSettlement(actor: HrActor, separationId: string) {
  assertCan(actor, "offboard");
  await assertVerifiedActor(actor, "SETTLEMENT_CREATE");
  return guarded(() => prisma.$transaction(async (tx) => {
    const owner = await tx.hrSeparation.findUnique({ where: { id: separationId }, select: { employeeId: true } });
    if (owner) await lockPeople(tx, [owner.employeeId]);
    const sep = await tx.hrSeparation.findUnique({ where: { id: separationId }, include: { employee: true } });
    if (!sep) throw new HrError("Separation not found", 404);
    await personInScope(tx, await resolveScope(actor, tx), sep.employeeId);
    assertNotSelf(actor, sep.employee, "prepare the final settlement");
    if (sep.status === "CANCELLED") throw new HrError("This separation was cancelled; there is nothing to settle.", 409, "SETTLEMENT_STATE");
    await lock(tx, "seq:finalSettlement");
    const rows: { n: number | null }[] = await tx.$queryRaw`SELECT MAX(CAST(SUBSTRING("settlementNo" FROM '[0-9]+$') AS INTEGER)) AS n FROM "HrFinalSettlement"`;
    const settlementNo = `FS-${String((rows[0]?.n ?? 0) + 1).padStart(4, "0")}`;
    const s = await tx.hrFinalSettlement.create({ data: { settlementNo, separationId, employeeId: sep.employeeId, preparedBy: actor.id } });
    await audit(tx, { action: "SETTLEMENT_CREATE", entityType: "HrFinalSettlement", entityId: s.id, employeeId: sep.employeeId, after: { settlementNo, separationId, separationStatus: sep.status }, actorId: actor.id });
    return dtoOf(tx, s.id);
  }, TX));
}

/** DRAFT → CALCULATED: the manual calculation, its inputs, its method and the attached worksheet. */
export async function calculateSettlement(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "offboard");
  await assertVerifiedActor(actor, "SETTLEMENT_CALCULATE");
  const eosAmount = amount(b.eosAmount, "eosAmount", { required: true }) as Prisma.Decimal;
  const leaveEncashmentAmount = amount(b.leaveEncashmentAmount, "leaveEncashmentAmount", { required: true }) as Prisma.Decimal;
  const leaveEncashmentDays = days(b.leaveEncashmentDays);
  const total = eosAmount.plus(leaveEncashmentAmount);
  if (!total.greaterThan(0)) throw new HrError("The settlement total must be above zero; cancel it if nothing is due.", 400);
  const calcMethodNote = reqText(b.calcMethodNote, "calcMethodNote", 2000, 10);
  const calcReference = reqText(b.calcReference, "calcReference", 200, 3);
  const inputs = b.calcInputs && typeof b.calcInputs === "object" && !Array.isArray(b.calcInputs) ? (b.calcInputs as Record<string, unknown>) : null;
  if (!inputs) throw new HrError("calcInputs is required.", 400);
  // The inputs the preparer used, exactly as used — validated for shape, never computed from.
  for (const k of ["serviceStart", "serviceEnd"]) if (!isDay(inputs[k])) throw new HrError(`calcInputs.${k} must be a date.`, 400);
  if ((inputs.serviceEnd as string) < (inputs.serviceStart as string)) throw new HrError("calcInputs.serviceEnd cannot precede serviceStart.", 400);
  const wage = amount(inputs.wageUsed, "calcInputs.wageUsed", { required: true, allowZero: false }) as Prisma.Decimal;
  // Review P2-A5: leave encashment is valued on a CONFIRMED leave type only (never a proposal).
  const encashLeaveType = leaveEncashmentAmount.greaterThan(0) ? reqText(inputs.leaveTypeCode, "calcInputs.leaveTypeCode", 20).toUpperCase() : null;
  const calcInputs = {
    serviceStart: inputs.serviceStart, serviceEnd: inputs.serviceEnd, wageUsed: wage.toFixed(2),
    wageDefinition: reqText(inputs.wageDefinition, "calcInputs.wageDefinition", 300, 3),
    separationType: text(inputs.separationType, "calcInputs.separationType", { max: 60 }),
    notes: text(inputs.notes, "calcInputs.notes", { max: 1000 }),
    ...(encashLeaveType ? { leaveTypeCode: encashLeaveType } : {}),
  };
  const eosProvisionAmount = amount(b.eosProvisionAmount, "eosProvisionAmount");
  const leaveProvisionAmount = amount(b.leaveProvisionAmount, "leaveProvisionAmount");
  const provisionReference = text(b.provisionReference, "provisionReference", { max: 200 });
  if (((eosProvisionAmount && eosProvisionAmount.greaterThan(0)) || (leaveProvisionAmount && leaveProvisionAmount.greaterThan(0))) && (!provisionReference || provisionReference.length < 3)) {
    throw new HrError("Name the recognised provision (provisionReference) the settlement is booked against.", 400);
  }
  return guarded(() => prisma.$transaction(async (tx) => {
    // The amounts on record change here: the person first, then the settlement row (round-5).
    await lockPeople(tx, await settlementEmployee(tx, id));
    const { s, person } = await load(tx, actor, id);
    assertNotSelf(actor, person, "calculate the final settlement");
    expectStatus(s, "DRAFT", "calculated");
    const doc = await evidenceDocument(tx, s.employeeId, b.calcDocumentId, "calcDocumentId");
    if (encashLeaveType) {
      const lt = await tx.hrLeaveType.findUnique({ where: { code: encashLeaveType } });
      if (!lt || !lt.paid || !lt.tracksBalance) throw new HrError(`calcInputs.leaveTypeCode must name a paid leave type that keeps a balance (${encashLeaveType} does not).`, 400);
      if (lt.isProposal) throw await controlRefusal(new HrError(`Leave type ${lt.code} is still a proposal, so no leave encashment is valued on it. A second policy manager confirms it first (LEAVE_TYPE_CONFIRM).`, 409, "LEAVE_TYPE_PROPOSAL"), { entityType: "HrFinalSettlement", entityId: id, step: "CALCULATE", actorId: actor.id, detail: { leaveType: lt.code } });
    }
    // Review P2-B5: a provision is never taken on trust.
    await assertProvisionInLedger(tx, { eosProvisionAmount, leaveProvisionAmount });
    // P-2 rev3 item 4: and never above this employee's own attributed provision.
    await assertWithinEmployeeProvision(tx, { id, employeeId: s.employeeId, eosAmount, leaveEncashmentAmount, eosProvisionAmount, leaveProvisionAmount });
    const row = await tx.hrFinalSettlement.update({
      where: { id },
      data: { status: "CALCULATED", eosAmount, leaveEncashmentDays, leaveEncashmentAmount, totalAmount: total, calcInputs: calcInputs as Prisma.InputJsonValue, calcMethodNote, calcReference, calcDocumentId: doc.id, eosProvisionAmount, leaveProvisionAmount, provisionReference, calculatedBy: actor.id, calculatedAt: new Date() },
    });
    await audit(tx, { action: "SETTLEMENT_CALCULATE", entityType: "HrFinalSettlement", entityId: id, employeeId: s.employeeId, after: { eosAmount: eosAmount.toFixed(2), leaveEncashmentDays: leaveEncashmentDays.toString(), leaveEncashmentAmount: leaveEncashmentAmount.toFixed(2), total: total.toFixed(2), calcInputs, calcReference, calcDocumentId: doc.id, fingerprint: calcFingerprint(row) }, actorId: actor.id });
    return dtoOf(tx, id);
  }, TX));
}

/** CALCULATED → REVIEWED by an independent person who attests to having checked the calculation. */
export async function reviewSettlement(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertAny(actor, ["payroll_approve", "policy_manage"]);
  await assertVerifiedActor(actor, "SETTLEMENT_REVIEW");
  const attestation = reqText(b.attestation, "attestation", 1000, 10);
  return guarded(() => prisma.$transaction(async (tx) => {
    const { s, person } = await load(tx, actor, id);
    assertNotSelf(actor, person, "review the final settlement");
    expectStatus(s, "CALCULATED", "reviewed");
    await assertIndependent(tx, actor, [s.preparedBy, s.calculatedBy], "reviewer");
    if (b.expected !== calcFingerprint(s)) throw new HrError("This is not the calculation you reviewed. Reload it and review it again.", 409, "SETTLEMENT_CHANGED");
    await tx.hrFinalSettlement.update({ where: { id }, data: { status: "REVIEWED", reviewedBy: actor.id, reviewedAt: new Date(), reviewAttestation: attestation } });
    await audit(tx, { action: "SETTLEMENT_REVIEW", entityType: "HrFinalSettlement", entityId: id, employeeId: s.employeeId, after: { fingerprint: b.expected, attestation }, actorId: actor.id });
    return dtoOf(tx, id);
  }, TX));
}

/** CALCULATED or REVIEWED → DRAFT, with a reason: the calculation is redone and reviewed again. */
export async function returnSettlement(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertAny(actor, ["payroll_approve", "policy_manage"]);
  const reason = reqText(b.reason, "reason", 500, 5);
  return guarded(() => prisma.$transaction(async (tx) => {
    await lockPeople(tx, await settlementEmployee(tx, id));
    const { s } = await load(tx, actor, id);
    expectStatus(s, ["CALCULATED", "REVIEWED"], "returned");
    await tx.hrFinalSettlement.update({ where: { id }, data: { status: "DRAFT", reviewedBy: null, reviewedAt: null, reviewAttestation: null } });
    await audit(tx, { action: "SETTLEMENT_RETURN", entityType: "HrFinalSettlement", entityId: id, employeeId: s.employeeId, before: { status: s.status, reviewedBy: s.reviewedBy }, reason, actorId: actor.id });
    return dtoOf(tx, id);
  }, TX));
}

/** REVIEWED → APPROVED by yet another person, naming the reviewed calculation. */
export async function approveSettlement(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "payroll_approve");
  assertFresh(actor);
  await assertVerifiedActor(actor, "SETTLEMENT_APPROVE");
  const note = text(b.note, "note", { max: 500 });
  return guarded(() => prisma.$transaction(async (tx) => {
    const { s, person } = await load(tx, actor, id);
    assertNotSelf(actor, person, "approve the final settlement");
    expectStatus(s, "REVIEWED", "approved");
    await assertIndependent(tx, actor, [s.preparedBy, s.calculatedBy, s.reviewedBy], "approver");
    if (b.expected !== calcFingerprint(s)) throw new HrError("This is not the calculation you reviewed. Reload it and review it again.", 409, "SETTLEMENT_CHANGED");
    await tx.hrFinalSettlement.update({ where: { id }, data: { status: "APPROVED", approvedBy: actor.id, approvedAt: new Date(), approvalNote: note } });
    await audit(tx, { action: "SETTLEMENT_APPROVE", entityType: "HrFinalSettlement", entityId: id, employeeId: s.employeeId, after: { fingerprint: b.expected, total: s.totalAmount?.toFixed(2) }, reason: note, actorId: actor.id });
    return dtoOf(tx, id);
  }, TX));
}

/**
 * The accrual lines: the recognised provision is DEBITED (settled), only the excess is expensed
 * — never expensed twice. Which accounts the keys are is the account map's (accountant) decision.
 */
export function settlementAccrualLines(s: { settlementNo: string; eosAmount: Prisma.Decimal; leaveEncashmentAmount: Prisma.Decimal; eosProvisionAmount: Prisma.Decimal | null; leaveProvisionAmount: Prisma.Decimal | null }): HrJournalLine[] {
  const min = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.lessThan(b) ? a : b);
  const eosProv = min(s.eosAmount, s.eosProvisionAmount ?? ZERO);
  const leaveProv = min(s.leaveEncashmentAmount, s.leaveProvisionAmount ?? ZERO);
  const d = `Final settlement ${s.settlementNo}`;
  return [
    { key: "EOS_PROVISION", debit: eosProv, description: `${d} · EOS against provision` },
    { key: "EOS_EXPENSE", debit: s.eosAmount.minus(eosProv), description: `${d} · EOS above provision` },
    { key: "LEAVE_PROVISION", debit: leaveProv, description: `${d} · leave encashment against provision` },
    { key: "LEAVE_ENCASHMENT_EXPENSE", debit: s.leaveEncashmentAmount.minus(leaveProv), description: `${d} · leave encashment above provision` },
    { key: "FINAL_SETTLEMENT_PAYABLE", credit: s.eosAmount.plus(s.leaveEncashmentAmount), description: `${d} · payable` },
  ].filter((l) => (l.debit ?? l.credit ?? ZERO).greaterThan(0)) as HrJournalLine[];
}

/**
 * APPROVED → POSTED, through HR accounting only (review P1-B1): the accrual journal names this
 * settlement as its source, debits the EOS / leave keys, credits FINAL_SETTLEMENT_PAYABLE and is
 * linked (HrJournalLink) so the P-2 guards protect it. MANUAL (an accountant's journal kept
 * outside HR) would be an external-accounting route; none is approved (D-6a), so it is refused —
 * 409 ACCOUNTING_REQUIRED, audited — like every other HR money event without its HR journal.
 */
export async function postSettlement(actor: HrActor, id: string, b: Record<string, unknown>, today: Date) {
  assertCan(actor, "payroll_approve");
  assertFresh(actor);
  await assertVerifiedActor(actor, "SETTLEMENT_POST");
  await assertPayrollLive("SETTLEMENT_POST");
  const mode = oneOf(b.mode, "mode", ["SYSTEM", "MANUAL"] as const, "SYSTEM");
  if (mode === "MANUAL") throw await manualRefusal(actor, id, "POST");
  return guarded(() => prisma.$transaction(async (tx) => {
    await assertPayrollLive("SETTLEMENT_POST", tx); // F8: again inside the transaction
    await lockPeople(tx, await settlementEmployee(tx, id));
    const { s } = await load(tx, actor, id);
    expectStatus(s, "APPROVED", "posted");
    const total = s.totalAmount as Prisma.Decimal;
    const lines = settlementAccrualLines({ settlementNo: s.settlementNo, eosAmount: s.eosAmount!, leaveEncashmentAmount: s.leaveEncashmentAmount!, eosProvisionAmount: s.eosProvisionAmount, leaveProvisionAmount: s.leaveProvisionAmount });
    await assertPostingReady(tx, { date: today, keys: lines.map((l) => l.key), source: { sourceType: "FINAL_SETTLEMENT", sourceId: id, purpose: "ACCRUAL" }, actorId: actor.id });
    // Review P2-B5: the provision is re-checked against the ledger at posting time.
    await assertProvisionInLedger(tx, s);
    // P-2 rev3 item 4 (D-7g): against the employee's own provision too (per-employee lock), and a
    // shortfall is never expensed without the accountant's recorded decision.
    await assertWithinEmployeeProvision(tx, s);
    await assertShortfallsDecided(tx, s);
    const j = await postHrJournal(tx, { sourceType: "FINAL_SETTLEMENT", sourceId: id, purpose: "ACCRUAL", date: today, actorId: actor.id, description: `Final settlement ${s.settlementNo} (end of service / leave encashment)`, lines, mode: "required" });
    if (!j.journalEntryId) throw new HrError("The settlement journal was not posted.", 409, ACCOUNTING_REQUIRED);
    const journalEntryId = j.journalEntryId;
    // The usage of the employee's provision, once per settlement and provision (DB unique).
    await recordUsage(tx, s, journalEntryId, actor.id);
    await tx.hrFinalSettlement.update({ where: { id }, data: { status: "POSTED", postingMode: "SYSTEM", journalEntryId, postedBy: actor.id, postedAt: new Date() } });
    const flags = provisionFlags(s);
    await audit(tx, { action: "SETTLEMENT_POST", entityType: "HrFinalSettlement", entityId: id, employeeId: s.employeeId, after: { mode: "SYSTEM", journalEntryId, total: total.toFixed(2), flags }, actorId: actor.id });
    return dtoOf(tx, id);
  }, TX));
}

/** No approved external-accounting route exists (D-6a): a MANUAL step is refused and audited. */
async function manualRefusal(actor: HrActor, id: string, step: string) {
  return controlRefusal(new HrError("A final settlement is posted and paid only through HR accounting, with HR-linked journals. A manual journal kept outside HR would be an external-accounting route, and none is approved; turn HR accounting on (an approved configuration change) and use the system posting.", 409, ACCOUNTING_REQUIRED), { entityType: "HrFinalSettlement", entityId: id, step: `MANUAL_${step}`, actorId: actor.id });
}

/** The settlement's HR-linked journals, verified against what it calls for (P1-B1 / P3-B8). */
async function assertSettlementJournals(db: Db, s: Row, purposes: ("ACCRUAL" | "PAYMENT")[], actorId: string, step: string) {
  for (const purpose of purposes) {
    const expected = purpose === "ACCRUAL"
      ? settlementAccrualLines({ settlementNo: s.settlementNo, eosAmount: s.eosAmount!, leaveEncashmentAmount: s.leaveEncashmentAmount!, eosProvisionAmount: s.eosProvisionAmount, leaveProvisionAmount: s.leaveProvisionAmount })
      : paymentLines(s);
    await assertJournalIntact(db, { sourceType: "FINAL_SETTLEMENT", sourceId: s.id, purpose }, { expected, actorId, step });
    const link = await db.hrJournalLink.findUniqueOrThrow({ where: { sourceType_sourceId_purpose: { sourceType: "FINAL_SETTLEMENT", sourceId: s.id, purpose } } });
    if (link.journalEntryId !== (purpose === "ACCRUAL" ? s.journalEntryId : s.paymentJournalEntryId)) throw await controlRefusal(new HrError(`The ${purpose} journal this settlement names is not its HR-linked journal.`, 409, "JOURNAL_INTEGRITY"), { entityType: "HrFinalSettlement", entityId: s.id, step, actorId });
  }
}

function paymentLines(s: { settlementNo: string; totalAmount: Prisma.Decimal | null }): HrJournalLine[] {
  const total = s.totalAmount as Prisma.Decimal;
  return [
    { key: "FINAL_SETTLEMENT_PAYABLE", debit: total, description: `Final settlement ${s.settlementNo}` },
    { key: "PAYROLL_CASH", credit: total, description: `Final settlement ${s.settlementNo}` },
  ];
}

/** Whether a settlement's journals still stand (for the clearance checklist and reports; read only). */
export async function settlementJournalsIntact(db: Db, s: { id: string; status: string; journalEntryId: string | null; paymentJournalEntryId: string | null }): Promise<boolean> {
  const purposes = s.status === "POSTED" ? ["ACCRUAL"] : ["PAID", "CLOSED"].includes(s.status) ? ["ACCRUAL", "PAYMENT"] : [];
  for (const purpose of purposes) {
    const link = await db.hrJournalLink.findUnique({ where: { sourceType_sourceId_purpose: { sourceType: "FINAL_SETTLEMENT", sourceId: s.id, purpose } } });
    if (!link || link.journalEntryId !== (purpose === "ACCRUAL" ? s.journalEntryId : s.paymentJournalEntryId)) return false;
    if ((await journalProblems(db, { sourceType: "FINAL_SETTLEMENT", sourceId: s.id, purpose })).length) return false;
  }
  return true;
}

/**
 * POSTED → PAID: never without proof. The proof document must be on the employee's file, the
 * amount equal the settlement, and the payment journal verified (posted by the system for a
 * SYSTEM accrual; the accountant's own, verified, for a MANUAL one). The payer is none of the
 * people who prepared, calculated, reviewed or approved it.
 */
export async function paySettlement(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "payroll_pay");
  assertFresh(actor);
  await assertVerifiedActor(actor, "SETTLEMENT_PAY");
  await assertPayrollLive("SETTLEMENT_PAY");
  if (!isDay(b.paidOn)) throw new HrError("paidOn must be a date.", 400);
  const paidOn = parseDay(b.paidOn);
  const paidAmount = amount(b.paidAmount, "paidAmount", { required: true, allowZero: false }) as Prisma.Decimal;
  const paymentReference = reqText(b.paymentReference, "paymentReference", 120, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    await assertPayrollLive("SETTLEMENT_PAY", tx); // F8: again inside the transaction
    const { s, person } = await load(tx, actor, id);
    assertNotSelf(actor, person, "record the settlement payment");
    expectStatus(s, "POSTED", "paid");
    await assertIndependent(tx, actor, [s.preparedBy, s.calculatedBy, s.reviewedBy, s.approvedBy], "payer");
    const total = s.totalAmount as Prisma.Decimal;
    if (!paidAmount.equals(total)) throw new HrError(`The payment must equal the approved settlement of ${total.toFixed(2)}.`, 409, "EVIDENCE_MISMATCH");
    const proof = await evidenceDocument(tx, s.employeeId, b.paymentProofDocumentId, "paymentProofDocumentId");
    // Review P1-B1: a settlement posted outside HR accounting (MANUAL, before this control) has no
    // HR-linked accrual to pay against, and no external route is approved.
    if (s.postingMode !== "SYSTEM") throw await manualRefusal(actor, id, "PAY");
    // Review P3-B8: the accrual it pays must still be intact and equal what was approved.
    await assertSettlementJournals(tx, s, ["ACCRUAL"], actor.id, "BEFORE_PAYMENT");
    const j = await postHrJournal(tx, {
      sourceType: "FINAL_SETTLEMENT", sourceId: id, purpose: "PAYMENT", date: paidOn, actorId: actor.id, mode: "required",
      description: `Final settlement ${s.settlementNo} paid (${paymentReference})`,
      lines: paymentLines(s),
    });
    if (!j.journalEntryId) throw new HrError("The payment journal was not posted.", 409, ACCOUNTING_REQUIRED);
    const paymentJournalEntryId = j.journalEntryId;
    await tx.hrFinalSettlement.update({ where: { id }, data: { status: "PAID", paidAmount, paidOn, paymentReference, paymentProofDocumentId: proof.id, paymentJournalEntryId, paidBy: actor.id, paidAt: new Date() } });
    await audit(tx, { action: "SETTLEMENT_PAY", entityType: "HrFinalSettlement", entityId: id, employeeId: s.employeeId, after: { paidAmount: paidAmount.toFixed(2), paidOn: dayString(paidOn), paymentReference, paymentProofDocumentId: proof.id, paymentJournalEntryId }, actorId: actor.id });
    return dtoOf(tx, id);
  }, TX));
}

/** PAID → CLOSED, after re-verifying that the evidence still stands (journals not reversed, proof on file). */
export async function closeSettlement(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertAny(actor, ["offboard", "payroll_approve"]);
  await assertVerifiedActor(actor, "SETTLEMENT_CLOSE");
  const note = text(b.note, "note", { max: 500 });
  return guarded(() => prisma.$transaction(async (tx) => {
    const { s } = await load(tx, actor, id);
    expectStatus(s, "PAID", "closed");
    // Both HR-linked journals must still be posted, unchanged and equal to what was approved.
    if (s.postingMode !== "SYSTEM") throw await manualRefusal(actor, id, "CLOSE");
    await assertSettlementJournals(tx, s, ["ACCRUAL", "PAYMENT"], actor.id, "BEFORE_CLOSE");
    const proof = await tx.hrDocument.findUnique({ where: { id: s.paymentProofDocumentId as string }, select: { deletedAt: true } });
    if (!proof || proof.deletedAt) throw new HrError("The payment proof is no longer on file, so the settlement cannot be closed.", 409, "EVIDENCE_MISSING");
    await tx.hrFinalSettlement.update({ where: { id }, data: { status: "CLOSED", closedBy: actor.id, closedAt: new Date(), closingNote: note } });
    await audit(tx, { action: "SETTLEMENT_CLOSE", entityType: "HrFinalSettlement", entityId: id, employeeId: s.employeeId, reason: note, actorId: actor.id });
    return dtoOf(tx, id);
  }, TX));
}

/** DRAFT…APPROVED → CANCELLED (nothing posted yet), with a reason. */
export async function cancelSettlement(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "offboard");
  const reason = reqText(b.reason, "reason", 500, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    await lockPeople(tx, await settlementEmployee(tx, id));
    const { s } = await load(tx, actor, id);
    expectStatus(s, ["DRAFT", "CALCULATED", "REVIEWED", "APPROVED"], "cancelled");
    await tx.hrFinalSettlement.update({ where: { id }, data: { status: "CANCELLED", cancelledBy: actor.id, cancelledAt: new Date(), cancelReason: reason } });
    await audit(tx, { action: "SETTLEMENT_CANCEL", entityType: "HrFinalSettlement", entityId: id, employeeId: s.employeeId, before: { status: s.status }, reason, actorId: actor.id });
    return dtoOf(tx, id);
  }, TX));
}
