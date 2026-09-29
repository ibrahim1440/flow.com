import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { Decimal, ZERO, roundMoney, riyadhMonthStart } from "@/lib/services/commissions/engine";
import { approvePeriod, adjust, periodStatement } from "@/lib/services/commissions/accrual";
import {
  payoutBalances,
  serialiseBalances,
  payoutBlock,
  unresolvedDetail,
} from "@/lib/services/commissions/entitlement";
import { payoutLockKey, payoutKeyLock } from "@/lib/services/commissions/lock";

/**
 * POST /api/commissions/review/actions — approve a period, adjust it, or record a payout.
 *
 * Three acts, three privileges, one endpoint, because they share the same subject
 * (employee + period) and the same rule: **nobody acts on their own commission.**
 *
 * That last rule is enforced here rather than left to the permission model. `approve`
 * belongs to a finance or management role, and such a person may well be on a plan
 * themselves; without this check the privilege would let them sign off their own pay.
 *
 * ── Nothing here is an edit ──
 * Approving sets a status. Adjusting appends a referenced entry with a reason and an actor.
 * Recording a payout appends a PAYOUT entry. The approved figure is never rewritten, which
 * is the entire point of an append-only ledger and the reason a correction reads as what
 * happened rather than as what someone later wished had happened.
 */
export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const action = typeof b.action === "string" ? b.action : "";
  if (!["approve", "adjust", "payout"].includes(action)) {
    return NextResponse.json({ error: "action must be approve, adjust or payout." }, { status: 400 });
  }

  const employeeId = typeof b.employeeId === "string" ? b.employeeId : "";
  if (!employeeId) return NextResponse.json({ error: "employeeId is required." }, { status: 400 });

  const monthParam = typeof b.month === "string" ? b.month : null;
  const at = monthParam ? new Date(`${monthParam}-15T00:00:00Z`) : new Date();
  if (Number.isNaN(at.getTime())) {
    return NextResponse.json({ error: "month must look like 2026-09." }, { status: 400 });
  }
  const periodStart = riyadhMonthStart(at);

  // The rule that has to hold before any privilege is even consulted.
  if (employeeId === user.id) {
    return NextResponse.json(
      {
        error:
          "You cannot approve, adjust or pay your own commission. Another approver must do it, " +
          "so nobody signs off their own pay.",
      },
      { status: 403 },
    );
  }

  const needed =
    action === "payout" ? "record_payout" : action === "approve" ? "approve" : "approve";
  if (!hasSubPrivilege(user.permissions, "commissions", needed)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  try {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, name: true },
    });
    if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });

    if (action === "approve") {
      const result = await prisma.$transaction(async (tx) => {
        const count = await approvePeriod(tx, employeeId, periodStart, user.id);
        const statement = await periodStatement(tx, employeeId, periodStart);
        return { count, statement };
      }, TX_OPTS);

      if (result.count === 0) {
        return NextResponse.json(
          {
            approved: 0,
            message:
              "Nothing was waiting for approval in that period — it is either already approved or empty.",
          },
          { status: 200 },
        );
      }

      return NextResponse.json({
        approved: result.count,
        statement: {
          accrued: result.statement.accrued.toFixed(2),
          adjustments: result.statement.adjustments.toFixed(2),
          paid: result.statement.paid.toFixed(2),
          outstanding: result.statement.outstanding.toFixed(2),
        },
        notice:
          "Approved figures are now immutable. A later correction appends an adjustment with a " +
          "reason rather than changing these rows.",
      });
    }

    if (action === "adjust") {
      let amount: Decimal;
      try {
        amount = new Decimal(String(b.amount ?? ""));
      } catch {
        return NextResponse.json({ error: "amount is not a number." }, { status: 400 });
      }
      const reason = typeof b.reason === "string" ? b.reason : "";

      const entryId = await prisma.$transaction(
        (tx) =>
          adjust(tx, {
            employeeId,
            periodStart,
            amount,
            reason,
            correctsEntryId: typeof b.correctsEntryId === "string" ? b.correctsEntryId : null,
            actorId: user.id,
          }),
        TX_OPTS,
      );

      const statement = await periodStatement(prisma, employeeId, periodStart);
      return NextResponse.json(
        {
          entryId,
          statement: {
            accrued: statement.accrued.toFixed(2),
            adjustments: statement.adjustments.toFixed(2),
            paid: statement.paid.toFixed(2),
            outstanding: statement.outstanding.toFixed(2),
          },
        },
        { status: 201 },
      );
    }

    // ── payout ──
    let amount: Decimal;
    try {
      amount = roundMoney(new Decimal(String(b.amount ?? "")));
    } catch {
      return NextResponse.json({ error: "amount is not a number." }, { status: 400 });
    }
    if (amount.lessThanOrEqualTo(ZERO)) {
      return NextResponse.json({ error: "A payout must be greater than zero." }, { status: 400 });
    }

    /**
     * Required, not optional.
     *
     * It used to be accepted when absent, which made the protection opt-in — and the one
     * caller that mattered, the payout dialog, never sent it. A retried payment therefore
     * landed twice whenever the balance still covered it, which is precisely the case a
     * partial payment leaves behind. A payment without a way to recognise its own retry is
     * refused instead.
     */
    const idempotencyKey =
      typeof b.idempotencyKey === "string" && b.idempotencyKey.trim() ? b.idempotencyKey.trim() : null;
    if (!idempotencyKey) {
      return NextResponse.json(
        {
          error:
            "idempotencyKey is required for a payout. Send the same key when retrying the same " +
            "payment so the retry is recognised, and a new one for a different payment.",
        },
        { status: 400 },
      );
    }
    if (idempotencyKey.length > 200) {
      return NextResponse.json({ error: "idempotencyKey is too long (200 characters max)." }, { status: 400 });
    }
    const reason = typeof b.reason === "string" ? b.reason.trim() || null : null;

    const result = await prisma.$transaction(async (tx) => {
      // One writer per employee-period. Prisma's transactions are Read Committed, so two
      // payouts could otherwise each read the same available balance, each find it
      // sufficient, and each write — spending it twice. The same key is taken by the
      // reversal path, so a payout racing a reversal serialises rather than interleaves.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${payoutLockKey(employeeId, periodStart)}))`;

      // Second, on the key itself. The lock above is per employee and period, so without
      // this one the same key replayed against a different employee would take a different
      // lock and slip past the reuse check below. Always taken in this order; see lock.ts.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${payoutKeyLock(idempotencyKey)}))`;

      // A retry must land once. Searched across the whole ledger rather than within this
      // employee and period, because a key identifies a payment, and the same key arriving
      // for a different person is a client bug rather than a second legitimate payment.
      const seen = await tx.commissionLedgerEntry.findFirst({
        where: { type: "PAYOUT", idempotencyKey },
        select: { id: true, employeeId: true, periodStart: true, amount: true, reason: true },
      });
      if (seen) {
        // Same key, same payment → the original, not a second one.
        const samePayment =
          seen.employeeId === employeeId &&
          seen.periodStart.getTime() === periodStart.getTime() &&
          new Decimal(seen.amount.toString()).equals(amount) &&
          (seen.reason ?? null) === reason;

        if (!samePayment) {
          // Same key, different payment. Neither outcome is safe to guess at: replaying
          // would silently discard a real payment, and writing would defeat the key. Say so.
          throw {
            _appCode: 409,
            message:
              "This idempotencyKey was already used for a different payment " +
              `(${new Decimal(seen.amount.toString()).toFixed(2)} SAR recorded against ` +
              `${seen.periodStart.toISOString().slice(0, 10)}). Use a new key for a new payment, ` +
              "or resend the original amount and reason to retry the one that was recorded.",
          };
        }

        const now = await payoutBalances(tx, employeeId, periodStart);
        const st = await periodStatement(tx, employeeId, periodStart);
        return { entryId: seen.id, balances: now, replayed: true, markedPaid: 0, statement: st };
      }

      const before = await payoutBalances(tx, employeeId, periodStart);

      // ── Fail closed while entitlement is unresolved ──
      //
      // Checked before the amount, because an amount is only meaningful once the balance it
      // is checked against is derivable. A period holding an unallocated reversal or a
      // movement that belongs to no accrual has positive linked entitlement that LOOKS
      // payable and a negative one nothing has been applied to yet; paying the first while
      // the second is outstanding is an overpayment the ledger cannot even report.
      //
      // Nothing here is inferred from a signed total. `fullyAttributed` counts movements and
      // reads magnitudes, because a +10.00 gap and a -10.00 gap sum to zero while both are
      // still unexplained. No allocation is invented to clear the block and no record is
      // altered: the period stays exactly as it is until somebody reconciles it.
      if (before.balanceStatus === "UNRESOLVED") {
        throw {
          _appCode: 409,
          message:
            `${employee.name}'s balance for this period is unresolved, so nothing in it is ` +
            `payable in either direction: ${unresolvedDetail(before)}. Reconcile the period ` +
            "first — the records are preserved as they are and no allocation is assumed.",
        };
      }

      // Approved entitlement only. An unapproved accrual is not payable, and a recovery
      // balance is not cancelled by earnings nobody has signed off.
      if (amount.greaterThan(before.availableToPay)) {
        throw {
          _appCode: 409,
          message:
            // Reachable only past the gate above, so the history behind this figure IS
            // complete and "owed back" is a finding rather than a gap in the record.
            before.recoveryBalance.greaterThan(0)
              ? `${employee.name} has no payable balance for this period: ${before.recoveryBalance.toFixed(2)} ` +
                "has been paid beyond the entitlement this period's complete history supports, and is " +
                "owed back. Resolve the recovery first."
              : `${employee.name} has ${before.availableToPay.toFixed(2)} available to pay for this period, ` +
                `which is less than the ${amount.toFixed(2)} being paid` +
                (before.unapprovedEntitlement.greaterThan(0)
                  ? `. ${before.unapprovedEntitlement.toFixed(2)} more is earned but not yet approved.`
                  : ". Record an adjustment first if the extra is deliberate."),
        };
      }

      const entry = await tx.commissionLedgerEntry.create({
        data: {
          type: "PAYOUT",
          employeeId,
          periodStart,
          // Positive. `periodStatement` subtracts the PAYOUT total from the accrued figure,
          // so storing a negative here would ADD the payout to what is owed — the ledger
          // would report a bigger balance every time somebody was paid.
          amount,
          reason,
          actorId: user.id,
          idempotencyKey,
        },
        select: { id: true },
      });

      const after = await payoutBalances(tx, employeeId, periodStart);

      // ── Partial payouts ──
      // This used to mark every APPROVED accrual PAID the moment any payout was written,
      // so paying 1.00 of a 3.00 balance left three rows claiming to be settled. Payouts
      // are period-level and accruals are not individually allocated to them, so PAID
      // means one thing only: **the period's approved entitlement has been settled in
      // full.** A partial payment leaves the rows APPROVED and the remainder available.
      const settled = after.availableToPay.lessThanOrEqualTo(0);
      const markedPaid = settled
        ? (await tx.commissionAccrual.updateMany({
            where: { employeeId, periodStart, status: "APPROVED" },
            data: { status: "PAID" },
          })).count
        : 0;

      const statement = await periodStatement(tx, employeeId, periodStart);
      return { entryId: entry.id, balances: after, replayed: false, markedPaid, statement };
    }, TX_OPTS);

    return NextResponse.json(
      {
        entryId: result.entryId,
        replayed: result.replayed,
        /** How many accrual rows this payout settled in full. Zero for a partial payment. */
        accrualsMarkedPaid: result.markedPaid,
        balances: serialiseBalances(result.balances),
        /** Why nothing further may be paid, if anything. Same codes the screen renders. */
        payoutBlock: payoutBlock(result.balances),
        // The older shape, kept so existing callers keep working. `outstanding` here is
        // earned-less-paid and still counts unapproved money — `balances.availableToPay`
        // is the figure that governs what may be paid.
        statement: {
          accrued: result.statement.accrued.toFixed(2),
          adjustments: result.statement.adjustments.toFixed(2),
          paid: result.statement.paid.toFixed(2),
          outstanding: result.statement.outstanding.toFixed(2),
        },
        /**
         * The boundary, stated where nobody can miss it. This endpoint RECORDS a payment
         * that has already been made somewhere else. It does not instruct, schedule or
         * execute one: there is no payment integration, no bank connection and no payroll
         * deduction anywhere in this system.
         */
        settlement: "RECORDED_AS_COMPLETED_EXTERNALLY",
        notice:
          "This records a payout that was already completed outside this system. It does not " +
          "move money, request a transfer, or deduct anything from payroll.",
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}
