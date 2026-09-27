/**
 * What each accrual is worth NOW, and what of it may actually be paid.
 *
 * ── Why this exists ──
 *
 * `CommissionAccrual.amount` is a projection the engine rewrites, and `postDelta` charges a
 * reversal's whole delta to the reversed event's own row. In a tiered period that is
 * visibly wrong per row even though the period total is right: reversing an 800 collection
 * that had let a second 800 cross a tier leaves the rows reading **-6.00** and **14.00**
 * when the honest answer is **0.00** and **8.00**. The rows still sum to 8.00, so nothing
 * failed reconciliation and nothing looked broken — but neither figure was that event's
 * contribution, and a person reading their own commission had no way to tell.
 *
 * The fix is not to rewrite the rows. An approved or paid accrual is a fact about what was
 * approved, and the movements are append-only. Both must stay exactly as they are.
 *
 * So entitlement is DERIVED, from records that already exist:
 *
 *     entitlement(accrual) = Σ its positive movements − Σ corrections applied against them
 *
 * A reversal is never counted directly. It is counted through its allocations, which is
 * precisely what `CommissionLedgerCorrection` records — so the per-accrual split falls out
 * of the same rows that already answer "what does this negative movement pay back".
 *
 * Worked on that tiered case:
 *
 *   movements   M1 +8.00 (event e1 → accrual A1)
 *               M2 +14.00 (event e2 → accrual A2)
 *               M3 −14.00 (event e1 → accrual A1)
 *   corrections M3 → M1  8.00      M3 → M2  6.00
 *
 *   A1 = 8.00 − 8.00 = 0.00        A2 = 14.00 − 6.00 = 8.00        period = 8.00
 *
 * ── What cannot be derived ──
 *
 * Movements written before provenance existed carry no accrual, so they belong to no row.
 * They are reported, never guessed at. A reversal whose allocation could not be completed
 * leaves `unallocatedReversal`. Both are period-level and both are visible, because an
 * entitlement nobody can attribute is exactly the thing that must not quietly become
 * payable — and the payout route refuses the whole employee-period while either stands.
 *
 * **Completeness is counted, never summed.** `unattributed` is reported as a signed net
 * because that is what a reader wants to see, but an unattributed +10.00 and an
 * unattributed −10.00 net to exactly zero while two movements remain unexplained. So
 * `fullyAttributed` reads `unattributedCount` and the two magnitudes beside it, which
 * cannot cancel each other out.
 */
import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { Decimal, ZERO, roundMoney } from "./engine";

type Tx = PrismaNS.TransactionClient | { [k: string]: never };

/** One accrual, and what it is worth after everything linked to it. */
export type AccrualEntitlement = {
  accrualId: string;
  employeeId: string;
  collectionEventId: string;
  status: string;
  /** What the engine stored. Frozen once approved; a projection before that. */
  storedAmount: PrismaNS.Decimal;
  /** The sum of the positive movements actually written against this accrual. */
  originalAward: PrismaNS.Decimal;
  /** Compensating amounts linked to those movements. Zero or more, always positive. */
  adjustments: PrismaNS.Decimal;
  /** originalAward − adjustments. What this accrual is worth now. */
  netEntitlement: PrismaNS.Decimal;
  /**
   * False when the accrual has no provenance-carrying movements, so its entitlement could
   * not be derived and `storedAmount` is all there is. Such rows are never treated as
   * payable — see `payoutBalances`.
   */
  derived: boolean;
};

export type PayoutBalances = {
  /** Every accrual's net entitlement, plus manual adjustments. Signed. */
  earnedNet: PrismaNS.Decimal;
  /** Of that, still waiting for approval. Never payable. */
  unapprovedEntitlement: PrismaNS.Decimal;
  /** Of that, signed off — the only entitlement a payout may draw on. */
  approvedEntitlement: PrismaNS.Decimal;
  /** Period-level manual corrections. Deliberate, so they count towards payability. */
  adjustments: PrismaNS.Decimal;
  /** Payouts already recorded as completed. Positive. */
  completedPayouts: PrismaNS.Decimal;
  /**
   * approvedEntitlement + adjustments − completedPayouts, KEPT SIGNED. Negative means more
   * has been paid than is now owed. Held signed internally so the two faces below cannot
   * disagree with each other.
   */
  signedBalance: PrismaNS.Decimal;
  /**
   * Whether `signedBalance` may be read as a statement about what is owed at all.
   *
   * It is computed from the derivable parts of the period only. When some of the period is
   * NOT derivable, the figure is missing those parts, so it is a provisional arithmetic
   * result rather than a finding — and neither of its faces means what its name says.
   */
  balanceStatus: "RESOLVED" | "UNRESOLVED";
  /** The signed figure as computed, resolved or not. Always populated; see `balanceStatus`. */
  provisionalBalance: PrismaNS.Decimal;
  /** What may still be paid. Zero whenever the balance is unresolved — nothing is. */
  availableToPay: PrismaNS.Decimal;
  /**
   * What is owed back. **Only ever non-zero on a resolved period**, because a shortfall
   * computed from incomplete history is not a debt anybody owes — see
   * `unresolvedShortfall`.
   */
  recoveryBalance: PrismaNS.Decimal;
  /**
   * The negative face of an UNRESOLVED balance: an apparent shortfall whose cause is
   * missing history, not overpayment. Reported so nothing is hidden, and named so nobody
   * collects it.
   */
  unresolvedShortfall: PrismaNS.Decimal;
  /**
   * The NET of the movements that belong to no accrual. Reportable, but **never** a test of
   * completeness: an unattributed +10.00 and an unattributed -10.00 net to zero while two
   * movements remain unexplained. Use `unattributedCount` for that.
   */
  unattributed: PrismaNS.Decimal;
  /** The positive half of the gap, at full magnitude. */
  unattributedPositive: PrismaNS.Decimal;
  /** The negative half of the gap, as a positive magnitude. */
  unattributedNegative: PrismaNS.Decimal;
  /** How many movements carry no accrual. Zero is the only value that means "none". */
  unattributedCount: number;
  /** Accruals whose entitlement could not be derived, so only a stored projection exists. */
  nonDerivedCount: number;
  /** Reversal money that could not be allocated to the movements it compensates. */
  unallocatedReversal: PrismaNS.Decimal;
  /** True only when every movement is placed and every reversal is fully allocated. */
  fullyAttributed: boolean;
};

const D = (v: unknown) => new Decimal(String(v ?? 0));

/** Every accrual in the period, with its award, its linked adjustments and its net. */
export async function accrualEntitlements(
  tx: Tx,
  employeeId: string,
  periodStart: Date,
): Promise<AccrualEntitlement[]> {
  const t = tx as PrismaNS.TransactionClient;

  const accruals = await t.commissionAccrual.findMany({
    where: { employeeId, periodStart },
    select: { id: true, employeeId: true, collectionEventId: true, status: true, amount: true },
    orderBy: { createdAt: "asc" },
  });
  if (accruals.length === 0) return [];

  // Positive movements, and what has been applied against each of them.
  const movements = await t.commissionLedgerEntry.findMany({
    where: {
      employeeId,
      periodStart,
      type: "ACCRUAL",
      accrualId: { in: accruals.map((a) => a.id) },
    },
    select: { id: true, accrualId: true, amount: true, correctedBy: { select: { amount: true } } },
  });

  return accruals.map((a) => {
    const mine = movements.filter((m) => m.accrualId === a.id);
    const originalAward = roundMoney(mine.reduce((s, m) => s.plus(D(m.amount)), ZERO));
    const adjustments = roundMoney(
      mine.reduce((s, m) => s.plus(m.correctedBy.reduce((x, c) => x.plus(D(c.amount)), ZERO)), ZERO),
    );
    return {
      accrualId: a.id,
      employeeId: a.employeeId,
      collectionEventId: a.collectionEventId,
      status: a.status as string,
      storedAmount: D(a.amount),
      originalAward,
      adjustments,
      netEntitlement: roundMoney(originalAward.minus(adjustments)),
      derived: mine.length > 0,
    };
  });
}

/**
 * The six balances, from the entitlement model rather than from the stored projections.
 *
 * How each input moves them:
 *
 * | input | earnedNet | approved | available | recovery |
 * | --- | --- | --- | --- | --- |
 * | an approval of a collection | + | — until the accrual is approved | — | — |
 * | approving the period | unchanged | + | + | − |
 * | a reversal, before payment | − | − once the accrual it hits is approved | − | + if it overshoots |
 * | a manual ADJUSTMENT | ± | unchanged | ± | ∓ |
 * | recording a completed payout | unchanged | unchanged | − | + |
 *
 * A manual adjustment is a human decision about the period, not about one collection, so it
 * is period-level and counts towards payability immediately — that is what distinguishes it
 * from an engine correction, which reaches a specific accrual through an allocation.
 *
 * **Unapproved entitlement never offsets a recovery balance.** `availableToPay` is computed
 * from approved entitlement only, so somebody carrying a debt from a reversed payment cannot
 * have it silently cancelled by new, unsigned-off earnings.
 */
export async function payoutBalances(
  tx: Tx,
  employeeId: string,
  periodStart: Date,
): Promise<PayoutBalances> {
  const t = tx as PrismaNS.TransactionClient;
  const rows = await accrualEntitlements(t, employeeId, periodStart);

  // Only a derived row can be trusted to a payment. An accrual whose movements predate
  // provenance has no defensible current value, so it is counted as unattributed and kept
  // out of both approved and unapproved entitlement.
  const derived = rows.filter((r) => r.derived);

  const approvedEntitlement = roundMoney(
    derived
      .filter((r) => r.status === "APPROVED" || r.status === "PAID")
      .reduce((s, r) => s.plus(r.netEntitlement), ZERO),
  );
  // Everything not signed off, whatever its status. A REVERSED row nets to zero once its
  // allocation is complete, but a partly-allocated one does not — and it is certainly not
  // payable, so it belongs here rather than being dropped out of the totals entirely.
  const unapprovedEntitlement = roundMoney(
    derived
      .filter((r) => r.status !== "APPROVED" && r.status !== "PAID")
      .reduce((s, r) => s.plus(r.netEntitlement), ZERO),
  );

  const ledger = await t.commissionLedgerEntry.findMany({
    where: { employeeId, periodStart },
    select: {
      type: true, amount: true, accrualId: true,
      corrects: { select: { amount: true } },
    },
  });

  const sumOf = (type: string) =>
    roundMoney(ledger.filter((l) => l.type === type).reduce((s, l) => s.plus(D(l.amount)), ZERO));

  const adjustments = sumOf("ADJUSTMENT");
  const completedPayouts = sumOf("PAYOUT");

  // Movements the model could not place: no accrual to attribute them to.
  //
  // Counted in three ways on purpose. The signed net is what a reader wants to see, but it
  // is worthless as a completeness test, because an unattributed +10.00 and an unattributed
  // -10.00 sum to exactly zero while two movements remain unexplained — and a zero there
  // would have declared the period fully attributed and let it be paid. Magnitudes and a
  // count cannot cancel, so those are what the gate below actually reads.
  const orphans = ledger.filter(
    (l) => (l.type === "ACCRUAL" || l.type === "REVERSAL") && l.accrualId === null,
  );
  const unattributed = roundMoney(orphans.reduce((s, l) => s.plus(D(l.amount)), ZERO));
  const unattributedPositive = roundMoney(
    orphans.filter((l) => D(l.amount).greaterThan(0)).reduce((s, l) => s.plus(D(l.amount)), ZERO),
  );
  const unattributedNegative = roundMoney(
    orphans
      .filter((l) => D(l.amount).lessThan(0))
      .reduce((s, l) => s.plus(D(l.amount).negated()), ZERO),
  );

  // Reversal money with nothing left to compensate.
  const unallocatedReversal = roundMoney(
    ledger
      .filter((l) => l.type === "REVERSAL")
      .reduce((s, l) => {
        const magnitude = D(l.amount).negated();
        const applied = l.corrects.reduce((x, c) => x.plus(D(c.amount)), ZERO);
        return s.plus(Decimal.max(ZERO, magnitude.minus(applied)));
      }, ZERO),
  );

  const earnedNet = roundMoney(approvedEntitlement.plus(unapprovedEntitlement).plus(adjustments));
  const signedBalance = roundMoney(approvedEntitlement.plus(adjustments).minus(completedPayouts));

  const fullyAttributed =
    orphans.length === 0 && unallocatedReversal.isZero() && rows.every((r) => r.derived);

  // ── A shortfall is not a debt until the history behind it is complete ──
  //
  // `signedBalance` is built from the derivable parts of the period ALONE. On a period that
  // still holds movements nothing can place, the parts that were left out are exactly the
  // ones that would close the gap — so a negative result says "this is what is missing",
  // not "this person was overpaid". Presenting it as a recovery asserts a debt that no
  // record establishes, against a real person, and invites somebody to collect it.
  //
  // Seen on the preview database: a rep shows a 3.00 shortfall while the nine movements
  // the model could not place net to exactly +3.00. Adopt them and the period closes at
  // zero. Nothing was ever owed; the figure was the hole in the data with a minus sign.
  //
  // So the two faces are only populated once the period is resolved. Until then the same
  // number is reported under a name that says what it actually is, and nothing is payable
  // — an unresolved period cannot be trusted in either direction.
  const resolved = fullyAttributed;

  return {
    earnedNet,
    unapprovedEntitlement,
    approvedEntitlement,
    adjustments,
    completedPayouts,
    signedBalance,
    balanceStatus: resolved ? ("RESOLVED" as const) : ("UNRESOLVED" as const),
    provisionalBalance: signedBalance,
    availableToPay: resolved && signedBalance.greaterThan(0) ? signedBalance : ZERO,
    recoveryBalance: resolved && signedBalance.lessThan(0) ? signedBalance.negated() : ZERO,
    unresolvedShortfall: !resolved && signedBalance.lessThan(0) ? signedBalance.negated() : ZERO,
    unattributed,
    unattributedPositive,
    unattributedNegative,
    unattributedCount: orphans.length,
    nonDerivedCount: rows.length - derived.length,
    unallocatedReversal,
    // Counts and magnitudes, never a signed sum. See `orphans` above.
    fullyAttributed,
  };
}

/** Shape the balances for an API response, as fixed-2 strings like every other figure. */
export function serialiseBalances(b: PayoutBalances) {
  return {
    earnedNet: b.earnedNet.toFixed(2),
    unapprovedEntitlement: b.unapprovedEntitlement.toFixed(2),
    approvedEntitlement: b.approvedEntitlement.toFixed(2),
    adjustments: b.adjustments.toFixed(2),
    completedPayouts: b.completedPayouts.toFixed(2),
    signedBalance: b.signedBalance.toFixed(2),
    balanceStatus: b.balanceStatus,
    provisionalBalance: b.provisionalBalance.toFixed(2),
    availableToPay: b.availableToPay.toFixed(2),
    recoveryBalance: b.recoveryBalance.toFixed(2),
    unresolvedShortfall: b.unresolvedShortfall.toFixed(2),
    unattributed: b.unattributed.toFixed(2),
    unattributedPositive: b.unattributedPositive.toFixed(2),
    unattributedNegative: b.unattributedNegative.toFixed(2),
    unattributedCount: b.unattributedCount,
    nonDerivedCount: b.nonDerivedCount,
    unallocatedReversal: b.unallocatedReversal.toFixed(2),
    fullyAttributed: b.fullyAttributed,
    payoutBlock: payoutBlock(b),
  };
}

/**
 * Why a payout cannot be recorded right now, as a code both the API and the screen render.
 *
 * Ordered by severity, because the reasons are not equally informative. An unresolved
 * period is reported as unresolved even when it also happens to show a recovery: the
 * recovery figure is computed from entitlement that the period has just admitted it cannot
 * derive, so quoting it as the reason would be quoting a number that is not yet trustworthy.
 */
export type PayoutBlockCode =
  | "BALANCE_UNRESOLVED"
  | "RECOVERY_OUTSTANDING"
  | "NOTHING_PAYABLE"
  | null;

export function payoutBlock(b: PayoutBalances): PayoutBlockCode {
  // Renamed from ENTITLEMENT_UNRESOLVED: what is unresolved is the BALANCE, and saying so
  // is the difference between "we cannot tell what this comes to" and "this person owes
  // money". Only the first is true here.
  if (b.balanceStatus === "UNRESOLVED") return "BALANCE_UNRESOLVED";
  if (b.recoveryBalance.greaterThan(0)) return "RECOVERY_OUTSTANDING";
  if (b.availableToPay.lessThanOrEqualTo(0)) return "NOTHING_PAYABLE";
  return null;
}

/**
 * The unresolved period, spelled out in figures rather than as a flag. Every clause names a
 * count or a magnitude; none of them is a signed sum that a matching gap could cancel.
 */
export function unresolvedDetail(b: PayoutBalances): string {
  const parts: string[] = [];
  if (b.unresolvedShortfall.greaterThan(0)) {
    parts.push(
      `the derivable part comes to -${b.unresolvedShortfall.toFixed(2)}, which is a gap in the ` +
        "record rather than a debt",
    );
  }
  if (b.unattributedCount > 0) {
    parts.push(
      `${b.unattributedCount} movement${b.unattributedCount === 1 ? "" : "s"} belong to no accrual ` +
        `(+${b.unattributedPositive.toFixed(2)} and -${b.unattributedNegative.toFixed(2)})`,
    );
  }
  if (b.nonDerivedCount > 0) {
    parts.push(
      `${b.nonDerivedCount} accrual${b.nonDerivedCount === 1 ? "" : "s"} carry no derivable entitlement`,
    );
  }
  if (b.unallocatedReversal.greaterThan(0)) {
    parts.push(`${b.unallocatedReversal.toFixed(2)} of reversal is unallocated`);
  }
  return parts.join("; ");
}
