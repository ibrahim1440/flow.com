import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { syncCommissionPeriod } from "@/lib/accounting/ops/commissions-gl";
import { lockEmployeePeriod } from "./accrual";
import { Decimal, ZERO, qualifyingBase, roundMoney, riyadhMonthEnd, riyadhMonthStart } from "./engine";
import {
  clawbackMarker, computeCreditClawback, riyadhYearBounds,
  type ClawbackCollection, type ClawbackResult,
} from "./credit-clawback-rule";

type Tx = PrismaNS.TransactionClient;
const D = (v: { toString(): string } | null | undefined) => new Decimal(v == null ? 0 : v.toString());

/**
 * The year-end job of the credit-note clawback (owner decision, 29 Oct 2026; the rule and its
 * arithmetic are in ./credit-clawback-rule.ts, the policy in docs/sales/COMMISSION_RULES.md §10).
 *
 * For every credit note ISSUED in the year, it reads what was still unused on 31 December, follows the
 * note to its original invoice and from there to the receipts applied to that invoice and the commission
 * accruals those receipts produced, and writes ONE negative ADJUSTMENT per (credit note, person) into that
 * person's next payable commission month.
 *
 * ── Why ADJUSTMENT, not REVERSAL ──
 * The engine's own baseline is ACCRUAL + REVERSAL only (accrual.ts recomputeEmployeePeriod). A REVERSAL
 * written into January would be read as "the engine already recorded −X for January", and the next
 * January collection would compute its delta against that and quietly pay the clawback back. An
 * ADJUSTMENT is, by design, a decision recorded ON TOP of what the rules compute: the engine leaves it
 * alone, `periodStatement` nets it into `outstanding`, the payroll bridge pays the net, and the GL sync
 * (syncCommissionPeriod) books it with the month's approval. Exactly the existing `adjust` path, with a
 * reason that names the credit note.
 *
 * ── The next payable month, never a paid one ──
 * Never the closing year itself — December may already be paid — and never a month that is closed for
 * this person: a PAYOUT entry, a PAID accrual, or a payroll reservation (RESERVED or SETTLED). Of what is
 * left from the January after the year, the earliest month that already has commission waiting is
 * preferred (so the clawback comes off a real payable); with none, the run's own month (not before that
 * January), stepping forward past any closed month. A month is re-checked after its period lock is taken —
 * the same advisory key the payout and the payroll run take — so a payout cannot slip in between.
 *
 * ── Exactly once ──
 * The reason begins `CREDIT_NOTE_CLAWBACK:<credit note id>:` and the job writes a person's line only when
 * no ADJUSTMENT of theirs carries that prefix, under a transaction-scoped advisory lock on the credit note,
 * so two concurrent runs queue and the second finds the first's rows. Running it daily through January, or
 * again next year, writes nothing new for a note already handled. No schema change: the marker is the key.
 *
 * Known limit (TODO, needs a decision, not code): a clawback larger than the month it lands in leaves that
 * month's `outstanding` negative; nothing carries the excess to the month after (the payroll bridge only
 * pays periods with a positive outstanding). The excess stays visible on the statement until handled by a
 * manual adjustment.
 */

export type ClawbackNoteOutcome =
  | "CLAWED_BACK"
  | "ALREADY_DONE"
  | "FULLY_USED"
  | "NO_ORIGINAL_INVOICE"
  | "NO_COMMISSIONED_COLLECTION";

export type ClawbackEntry = {
  creditNoteId: string;
  employeeId: string;
  periodStart: Date;
  amount: PrismaNS.Decimal;
  entryId: string;
};

export type YearEndClawbackSummary = {
  year: number;
  creditNotes: number;
  outcomes: Record<ClawbackNoteOutcome, number>;
  entries: ClawbackEntry[];
  /** Lines skipped because that person already has this note's clawback (a re-run). */
  alreadyLines: number;
};

/** A month is closed for a person once anything in it is paid or reserved to be paid. */
export async function isCommissionPeriodClosed(tx: Tx, employeeId: string, periodStart: Date): Promise<boolean> {
  const [payouts, paid, reserved] = await Promise.all([
    tx.commissionLedgerEntry.count({ where: { employeeId, periodStart, type: "PAYOUT" } }),
    tx.commissionAccrual.count({ where: { employeeId, periodStart, status: "PAID" } }),
    tx.hrCommissionReservation.count({ where: { accountEmployeeId: employeeId, periodStart, status: { in: ["RESERVED", "SETTLED"] } } }),
  ]);
  return payouts + paid + reserved > 0;
}

/**
 * The month a clawback for `employeeId` lands in: not before `notBefore` (the January after the year),
 * the earliest month already holding commission that is not closed, else the run's month (clamped to
 * `notBefore`) or the first open month after it. Read-only.
 */
export async function nextPayablePeriod(tx: Tx, employeeId: string, notBefore: Date, runAt: Date): Promise<Date> {
  const waiting = await tx.commissionAccrual.findMany({
    where: { employeeId, periodStart: { gte: notBefore }, status: { in: ["ACCRUED", "APPROVED"] } },
    distinct: ["periodStart"], select: { periodStart: true }, orderBy: { periodStart: "asc" },
  });
  for (const { periodStart } of waiting) {
    if (!(await isCommissionPeriodClosed(tx, employeeId, periodStart))) return periodStart;
  }
  let p = riyadhMonthStart(runAt.getTime() > notBefore.getTime() ? runAt : notBefore);
  // Bounded: ten years of closed months in a row is not a state this can be in; refuse rather than spin.
  for (let i = 0; i < 120; i++) {
    if (!(await isCommissionPeriodClosed(tx, employeeId, p))) return p;
    p = riyadhMonthEnd(p);
  }
  throw { _appCode: 409, message: "No open commission month was found to carry the credit-note clawback." };
}

/** The collections a credit note relates to, with who earned on each and at what rate. */
async function relatedCollections(tx: Tx, originalInvoiceId: string, lastDay: string, yearEnd: Date): Promise<ClawbackCollection[]> {
  // Receipts applied to the original invoice (the AR sub-ledger's own link; an accountant receipt and the
  // automatic application at approval both write an ArApplication). Only what stood on 31 December.
  const apps = await tx.arApplication.findMany({
    where: { invoiceId: originalInvoiceId, status: "APPLIED", collectionId: { not: null }, appliedDate: { lte: new Date(`${lastDay}T00:00:00Z`) } },
    select: { amount: true, collection: { select: { collectionEventId: true } } },
  });
  const appliedByEvent = new Map<string, Decimal>();
  for (const a of apps) {
    const ev = a.collection?.collectionEventId;
    if (ev) appliedByEvent.set(ev, (appliedByEvent.get(ev) ?? ZERO).plus(D(a.amount)));
  }
  const out: ClawbackCollection[] = [];
  for (const [eventId, applied] of [...appliedByEvent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ev = await tx.collectionEvent.findUnique({
      where: { id: eventId },
      select: { id: true, status: true, collectedAt: true, amountGross: true, amountTax: true, amountNonQualifying: true },
    });
    if (!ev || ev.status !== "RECORDED" || ev.collectedAt.getTime() >= yearEnd.getTime()) continue;
    const gross = D(ev.amountGross);
    if (gross.lessThanOrEqualTo(0)) continue;
    // Only the part of the receipt that paid THIS invoice: a receipt split over two invoices is not all
    // attributable to the one that was credited.
    const part = Decimal.min(applied.dividedBy(gross), new Decimal(1));
    const base = roundMoney(qualifyingBase({ amountGross: ev.amountGross, amountTax: ev.amountTax, amountNonQualifying: ev.amountNonQualifying }).times(part));
    // Who earned on it: the accrual rows themselves, which already carry the split in force at the
    // collection date (sharesForCollection) and the effective rate the engine applied. The latest row per
    // person if a plan version change left two.
    const accruals = await tx.commissionAccrual.findMany({
      where: { collectionEventId: ev.id, status: { not: "REVERSED" } },
      select: { employeeId: true, sharePercent: true, effectiveRatePercent: true },
      orderBy: { createdAt: "desc" },
    });
    const seen = new Set<string>();
    const earners = accruals.filter((a) => !seen.has(a.employeeId) && seen.add(a.employeeId)).map((a) => ({
      employeeId: a.employeeId, sharePercent: D(a.sharePercent), effectiveRatePercent: D(a.effectiveRatePercent),
    }));
    if (earners.length) out.push({ collectionEventId: ev.id, base, earners });
  }
  return out;
}

/** What the clawback of one credit note would be at year end. Read-only. */
export async function creditNoteClawback(tx: Tx, creditNoteId: string, year: number): Promise<{ outcome: ClawbackNoteOutcome | null; result: ClawbackResult | null; number: string | null }> {
  const { end, lastDay } = riyadhYearBounds(year);
  const cn = await tx.salesInvoice.findUnique({ where: { id: creditNoteId }, select: { id: true, number: true, grandTotal: true, taxTotal: true, originalInvoiceId: true } });
  if (!cn) return { outcome: null, result: null, number: null };
  const used = await tx.arApplication.aggregate({ where: { creditNoteId: cn.id, status: "APPLIED", appliedDate: { lte: new Date(`${lastDay}T00:00:00Z`) } }, _sum: { amount: true } });
  const note = { grandTotal: D(cn.grandTotal), taxTotal: D(cn.taxTotal), applied: D(used._sum.amount) };
  if (note.grandTotal.minus(note.applied).lessThanOrEqualTo(0)) return { outcome: "FULLY_USED", result: null, number: cn.number };
  if (!cn.originalInvoiceId) return { outcome: "NO_ORIGINAL_INVOICE", result: null, number: cn.number };
  const result = computeCreditClawback(note, await relatedCollections(tx, cn.originalInvoiceId, lastDay, end));
  return { outcome: result.lines.length ? null : "NO_COMMISSIONED_COLLECTION", result, number: cn.number };
}

/**
 * Run the year-end clawback for `year` (a Riyadh calendar year that has ended). Safe to call any number
 * of times: each (credit note, person) is written once. One transaction per credit note, so one note's
 * refusal does not hold back the others' — it is rethrown after the rest have run.
 */
export async function runYearEndCreditClawback(opts: { year: number; actorId?: string | null; now?: Date }): Promise<YearEndClawbackSummary> {
  const { year } = opts;
  const now = opts.now ?? new Date();
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw { _appCode: 400, message: "year must be a four-digit calendar year." };
  const { end, firstDay, lastDay } = riyadhYearBounds(year);
  if (now.getTime() < end.getTime()) {
    throw { _appCode: 409, message: "That year has not ended in Riyadh yet. The credit-note clawback runs once, after 31 December." };
  }
  const actorId = opts.actorId ?? null;

  const notes = await prisma.salesInvoice.findMany({
    where: { kind: "CREDIT_NOTE", status: "ISSUED", issueDate: { gte: new Date(`${firstDay}T00:00:00Z`), lte: new Date(`${lastDay}T00:00:00Z`) } },
    select: { id: true }, orderBy: [{ issueDate: "asc" }, { id: "asc" }],
  });
  const summary: YearEndClawbackSummary = {
    year, creditNotes: notes.length, entries: [], alreadyLines: 0,
    outcomes: { CLAWED_BACK: 0, ALREADY_DONE: 0, FULLY_USED: 0, NO_ORIGINAL_INVOICE: 0, NO_COMMISSIONED_COLLECTION: 0 },
  };
  let firstFailure: unknown = null;

  for (const { id } of notes) {
    try {
      // The summary is touched only after the transaction commits, so a rolled-back note reports nothing.
      const done = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"commission-clawback:" + id}))`;
        const { outcome, result, number } = await creditNoteClawback(tx, id, year);
        if (outcome || !result) return { outcome, entries: [] as ClawbackEntry[], already: 0 };
        const entries: ClawbackEntry[] = [];
        let already = 0;
        const marker = clawbackMarker(id);
        for (const line of result.lines) {
          const prior = await tx.commissionLedgerEntry.findFirst({ where: { employeeId: line.employeeId, type: "ADJUSTMENT", reason: { startsWith: marker } }, select: { id: true } });
          if (prior) { already++; continue; }
          // Lock the chosen month, then make sure it is still open; a payout that won the race moves us on.
          let periodStart = await nextPayablePeriod(tx, line.employeeId, end, now);
          for (let i = 0; i < 12; i++) {
            await lockEmployeePeriod(tx, line.employeeId, periodStart);
            if (!(await isCommissionPeriodClosed(tx, line.employeeId, periodStart))) break;
            periodStart = await nextPayablePeriod(tx, line.employeeId, riyadhMonthEnd(periodStart), now);
          }
          const entry = await tx.commissionLedgerEntry.create({
            data: {
              type: "ADJUSTMENT",
              employeeId: line.employeeId,
              periodStart,
              amount: line.amount,
              reason:
                `${marker}FY${year} — year-end clawback: credit note ${number ?? id} still had ${result.unusedNet.toFixed(2)} ` +
                `(net of VAT) unused on 31 Dec ${year}. Commission at ${line.ratePercent.toFixed(4)}% on this person's ` +
                `${line.base.toFixed(2)} share of it, taken from the next payable month.`,
              actorId,
            },
            select: { id: true },
          });
          // As `adjust` does: a no-op until the month is approved, then booked with it (Accounting A3).
          await syncCommissionPeriod(tx, line.employeeId, periodStart, actorId ?? "system");
          entries.push({ creditNoteId: id, employeeId: line.employeeId, periodStart, amount: line.amount, entryId: entry.id });
        }
        return { outcome: (entries.length ? "CLAWED_BACK" : "ALREADY_DONE") as ClawbackNoteOutcome, entries, already };
      }, TX_OPTS);
      if (done.outcome) summary.outcomes[done.outcome]++;
      summary.entries.push(...done.entries);
      summary.alreadyLines += done.already;
    } catch (e) {
      firstFailure ??= e;
    }
  }
  if (firstFailure) throw firstFailure;
  return summary;
}
