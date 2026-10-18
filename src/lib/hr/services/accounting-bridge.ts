// Native HR → existing accounting. HR posts AUTO journals straight to POSTED, inside the
// caller's transaction, through the SAME validations manual journals use:
//   setup complete · every key explicitly mapped · postable leaf accounts · balanced ·
//   exclusive debit/credit lines · fiscal period OPEN.
// One journal per (sourceType, sourceId, purpose) — HrJournalLink is the idempotency key —
// and a correction is a mirrored REVERSAL entry, never an edit.
//
// P-2 / E-3 (finding 9): no HR money event is recorded without its journal. While HR accounting
// is off every posting, readiness check and reversal is REFUSED (409 ACCOUNTING_REQUIRED,
// audited) — there is no silent skip. A follow-up journal (payment, repayment, reversal) needs
// its source journal to be present and intact (./journal-integrity). A link found on retry is
// verified against what the caller is about to post before it is reused. What each journal posted
// is frozen on its link (`postedLines`). The DB (migration 20261017090000) refuses an unlinked
// reversal of an HR journal, any edit of an HR journal, and approval / PAID without the journals.
import { Prisma } from "@/generated/prisma/client";
import { AccountingError } from "@/lib/accounting/errors";
import { assertAccountPostable, assertDebitEqualsCredit, assertLineExclusive, assertPeriodOpen } from "@/lib/accounting/validation";
import { HrError } from "../core";
import { dayString } from "../dates";
import type { AccountKey } from "./policy";
import { settings } from "./policy";
import { accountingOffRefusal, assertJournalIntact, externalAccountingTreatment, mirrored, postedLinesOf, requiredParentOf, type PostedLine } from "./journal-integrity";

type Tx = Prisma.TransactionClient;
const ZERO = new Prisma.Decimal(0);

export type HrJournalLine = { key: AccountKey; debit?: Prisma.Decimal; credit?: Prisma.Decimal; description: string };

function wrap(e: unknown): never {
  if (e instanceof AccountingError) throw new HrError(`Accounting refused the posting: ${e.message}`, e.status === 409 ? 409 : 400, "ACCOUNTING");
  throw e;
}

/** Collapse to one line per (key, side, description) and drop zeros. */
export function consolidate(lines: HrJournalLine[]): HrJournalLine[] {
  const m = new Map<string, HrJournalLine>();
  for (const l of lines) {
    const debit = l.debit ?? ZERO;
    const credit = l.credit ?? ZERO;
    if (debit.isZero() && credit.isZero()) continue;
    if (debit.greaterThan(0) && credit.greaterThan(0)) throw new HrError("A journal line is either a debit or a credit.", 500);
    const side = debit.greaterThan(0) ? "D" : "C";
    const k = `${l.key}|${side}|${l.description}`;
    const cur = m.get(k);
    if (cur) {
      if (side === "D") cur.debit = (cur.debit ?? ZERO).plus(debit);
      else cur.credit = (cur.credit ?? ZERO).plus(credit);
    } else m.set(k, { key: l.key, debit: side === "D" ? debit : undefined, credit: side === "C" ? credit : undefined, description: l.description });
  }
  return [...m.values()];
}

/**
 * F2 / finding 9: whether a journal for these keys on this date WOULD post, checked before any
 * state changes (the same rules `postHrJournal` applies: setup complete, every key mapped,
 * postable accounts, a fiscal period that is OPEN). Throws the same refusal the posting would.
 * P-2 / E-3: HR accounting off is a refusal too (409 ACCOUNTING_REQUIRED, audited).
 */
export async function assertPostingReady(tx: Tx, input: { date: Date; keys: AccountKey[]; source?: { sourceType: string; sourceId: string; purpose: string }; actorId?: string }): Promise<{ enabled: true }> {
  const s = await settings(tx);
  if (!s.accountingEnabled) throw await accountingOffRefusal(input.source ?? { sourceType: "HR", sourceId: "-", purpose: "READINESS" }, input.actorId ?? "system");
  const acc = await tx.accountingSettings.findUnique({ where: { id: "singleton" } });
  if (!acc?.setupComplete) throw new HrError("Accounting setup is not complete, so HR cannot post. Complete accounting settings, or disable HR accounting explicitly.", 409, "ACCOUNTING");
  const keys = [...new Set(input.keys)];
  const map = await tx.hrAccountMap.findMany({ where: { key: { in: keys } } });
  const missing = keys.filter((k) => !map.some((m) => m.key === k));
  if (missing.length) throw new HrError(`These HR posting keys are not mapped to accounts: ${missing.join(", ")}.`, 409, "ACCOUNT_MAP");
  try {
    const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: input.date }, endDate: { gte: input.date } } });
    if (!period) throw new HrError(`No fiscal period covers ${dayString(input.date)}.`, 409, "ACCOUNTING");
    assertPeriodOpen(period);
    const accounts = await tx.account.findMany({ where: { id: { in: [...new Set(map.map((m) => m.accountId))] } }, include: { _count: { select: { children: true } } } });
    for (const a of accounts) assertAccountPostable(a, a._count.children);
  } catch (e) {
    if (e instanceof HrError) throw e;
    wrap(e);
  }
  return { enabled: true };
}

/**
 * Post an HR journal, or refuse. P-2 / E-3 (finding 9):
 * • HR accounting off → 409 ACCOUNTING_REQUIRED (audited), whatever the caller;
 * • `mode: "skip"` — the caller's source was booked WITHOUT a journal (a run approved, or an
 *   advance disbursed, while accounting was off before this control). Its follow-up cannot post
 *   against a journal that never existed, and recording it without one needs an approved
 *   external-accounting treatment: the hook refuses (409 EXTERNAL_ACCOUNTING_NOT_APPROVED);
 * • a follow-up journal needs its source journal present and intact (JOURNAL_MISSING /
 *   JOURNAL_INTEGRITY);
 * • a link already present (retry) is reused only if its journal is intact and posts exactly these
 *   lines on this date; otherwise 409 JOURNAL_INTEGRITY.
 * Never returns skipped: true any more; the field is kept for the callers' audit rows.
 */
export async function postHrJournal(
  tx: Tx,
  input: { sourceType: string; sourceId: string; purpose: string; date: Date; description: string; lines: HrJournalLine[]; actorId: string; mode?: "required" | "skip" },
): Promise<{ journalEntryId: string | null; skipped: boolean; replayed?: boolean }> {
  const ref = { sourceType: input.sourceType, sourceId: input.sourceId, purpose: input.purpose };
  const s = await settings(tx);
  if (!s.accountingEnabled) throw await accountingOffRefusal(ref, input.actorId);
  if (input.mode === "skip") return externalAccountingTreatment(ref, input.actorId);
  const prior = await tx.hrJournalLink.findUnique({ where: { sourceType_sourceId_purpose: ref } });
  if (prior) {
    await assertJournalIntact(tx, ref, { expected: input.lines, date: input.date, actorId: input.actorId, step: "REPLAY" });
    return { journalEntryId: prior.journalEntryId, skipped: false, replayed: true };
  }
  const parent = await requiredParentOf(tx, ref);
  if (parent) await assertJournalIntact(tx, parent, { actorId: input.actorId, step: `BEFORE_${input.purpose.split(":")[0]}` });

  const acc = await tx.accountingSettings.findUnique({ where: { id: "singleton" } });
  if (!acc?.setupComplete) throw new HrError("Accounting setup is not complete, so HR cannot post. Complete accounting settings, or disable HR accounting explicitly.", 409, "ACCOUNTING");

  const lines = consolidate(input.lines);
  if (lines.length < 2) throw new HrError("A journal needs at least two non-zero lines.", 409, "ACCOUNTING");
  const keys = [...new Set(lines.map((l) => l.key))];
  const map = await tx.hrAccountMap.findMany({ where: { key: { in: keys } } });
  const missing = keys.filter((k) => !map.some((m) => m.key === k));
  if (missing.length) throw new HrError(`These HR posting keys are not mapped to accounts: ${missing.join(", ")}.`, 409, "ACCOUNT_MAP");
  const accountOf = new Map(map.map((m) => [m.key, m.accountId]));

  const jl = lines.map((l) => ({ accountId: accountOf.get(l.key) as string, debit: l.debit ?? ZERO, credit: l.credit ?? ZERO, description: l.description }));
  try {
    for (const l of jl) assertLineExclusive(l);
    assertDebitEqualsCredit(jl);
    const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: input.date }, endDate: { gte: input.date } } });
    if (!period) throw new HrError(`No fiscal period covers ${dayString(input.date)}.`, 409, "ACCOUNTING");
    assertPeriodOpen(period);
    const ids = [...new Set(jl.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({ where: { id: { in: ids } }, include: { _count: { select: { children: true } } } });
    for (const a of accounts) assertAccountPostable(a, a._count.children);
    const total = jl.reduce((s2, l) => s2.plus(l.debit), ZERO);
    const now = new Date();
    const entry = await tx.journalEntry.create({
      data: {
        entryDate: input.date, fiscalPeriodId: period.id, type: "AUTO", status: "POSTED", sourceModule: "hr", sourceDocumentId: input.sourceId,
        description: input.description, totalDebit: total, totalCredit: total, createdBy: input.actorId,
        approvedAt: now, approvedBy: input.actorId, postedAt: now, postedBy: input.actorId,
        lines: { create: jl.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description })) },
      },
    });
    const postedLines = postedLinesOf(lines, accountOf);
    await tx.hrJournalLink.create({ data: { sourceType: input.sourceType, sourceId: input.sourceId, purpose: input.purpose, journalEntryId: entry.id, postedLines: postedLines as unknown as Prisma.InputJsonValue } });
    // Read back and verified like any journal relied on later (cheap; same transaction).
    await assertJournalIntact(tx, ref, { expected: input.lines, date: input.date, actorId: input.actorId, step: "POSTED" });
    return { journalEntryId: entry.id, skipped: false };
  } catch (e) {
    if (e instanceof HrError) throw e;
    wrap(e);
  }
}

/**
 * Mirror a posted HR journal (debit ↔ credit) dated `date`, linked as its reversal. P-2 / E-3:
 * refused while HR accounting is off; a source booked without a journal goes to the
 * external-accounting hook (refused); the original must be intact and still POSTED; a reversal
 * found on retry is reused only if it is intact and mirrors the original exactly.
 */
export async function reverseHrJournal(
  tx: Tx,
  input: { sourceType: string; sourceId: string; purpose: string; reversalPurpose: string; date: Date; reason: string; actorId: string },
): Promise<{ journalEntryId: string | null; skipped: boolean }> {
  const ref = { sourceType: input.sourceType, sourceId: input.sourceId, purpose: input.purpose };
  const rref = { sourceType: input.sourceType, sourceId: input.sourceId, purpose: input.reversalPurpose };
  if (!(await settings(tx)).accountingEnabled) throw await accountingOffRefusal(rref, input.actorId);
  const link = await tx.hrJournalLink.findUnique({ where: { sourceType_sourceId_purpose: ref } });
  if (!link) return externalAccountingTreatment(rref, input.actorId);
  // A legacy link (no posted lines) is mirrored from its migration-time baseline (review P2-A4);
  // without one there is nothing to verify the reversal against, and the integrity check below refuses.
  const frozen = Array.isArray(link.postedLines) ? (link.postedLines as unknown as PostedLine[]) : ((await tx.hrJournalLinkBaseline.findUnique({ where: { linkId: link.id } }))?.lines as unknown as PostedLine[] | undefined);
  const want = frozen ? mirrored(frozen) : undefined;
  const prior = await tx.hrJournalLink.findUnique({ where: { sourceType_sourceId_purpose: rref } });
  if (prior) {
    await assertJournalIntact(tx, rref, { expectedPosted: want, actorId: input.actorId, step: "REPLAY" });
    return { journalEntryId: prior.journalEntryId, skipped: false };
  }
  await assertJournalIntact(tx, ref, { actorId: input.actorId, step: "BEFORE_REVERSAL" });
  const original = await tx.journalEntry.findUniqueOrThrow({ where: { id: link.journalEntryId }, include: { lines: true, reversedByEntry: true } });
  if (original.reversedByEntry) throw new HrError("This journal has already been reversed.", 409, "ACCOUNTING");
  try {
    const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: input.date }, endDate: { gte: input.date } } });
    if (!period) throw new HrError(`No fiscal period covers ${dayString(input.date)}.`, 409, "ACCOUNTING");
    assertPeriodOpen(period);
    const now = new Date();
    const entry = await tx.journalEntry.create({
      data: {
        entryDate: input.date, fiscalPeriodId: period.id, type: "REVERSAL", status: "POSTED", sourceModule: "hr", sourceDocumentId: input.sourceId,
        description: `Reversal: ${original.description ?? ""}`.slice(0, 500), reversesEntryId: original.id, reversalReason: input.reason,
        totalDebit: original.totalCredit, totalCredit: original.totalDebit, createdBy: input.actorId, approvedAt: now, approvedBy: input.actorId, postedAt: now, postedBy: input.actorId,
        lines: { create: original.lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, description: l.description })) },
      },
    });
    // Linked first, then the original is marked: the DB accepts REVERSED only with a linked reversal.
    await tx.hrJournalLink.create({ data: { sourceType: input.sourceType, sourceId: input.sourceId, purpose: input.reversalPurpose, journalEntryId: entry.id, ...(want ? { postedLines: want as unknown as Prisma.InputJsonValue } : {}) } });
    await tx.journalEntry.update({ where: { id: original.id }, data: { status: "REVERSED" } });
    await assertJournalIntact(tx, rref, { expectedPosted: want, actorId: input.actorId, step: "REVERSED" });
    return { journalEntryId: entry.id, skipped: false };
  } catch (e) {
    if (e instanceof HrError) throw e;
    wrap(e);
  }
}
