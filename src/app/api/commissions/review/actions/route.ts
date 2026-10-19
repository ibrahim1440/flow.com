import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAuth, privilegedGate } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { ZERO, roundMoney, riyadhMonthStart, parseFiniteDecimal } from "@/lib/services/commissions/engine";
import { approvePeriod, adjust, periodStatement } from "@/lib/services/commissions/accrual";
import { isReservedByPayroll, lockCommissionPeriod } from "@/lib/hr/services/commission-bridge";
import { isPayrollLive, payrollLockedRefusal } from "@/lib/hr/payroll-lock";
import { isSimpleMode } from "@/lib/simple-mode";

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
  // SIMPLE MODE: a single owner may decide their own request / act on their own record.
  if (!isSimpleMode() && (employeeId === user.id)) {
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
  // Commission approval and payout: a verified individual and a recent step-up (SOD.md §19).
  const refused = await privilegedGate(user, "commissions", needed);
  if (refused) return refused;

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
      // Finite decimals only: a NaN adjustment was stored and poisoned the period statement.
      const amount = parseFiniteDecimal(b.amount ?? "");
      if (!amount) return NextResponse.json({ error: "amount is not a number." }, { status: 400 });
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
    // Phase 1 payroll lock (independent review F2; owner-adjustable scope, PAYROLL-LOCK.md): a payout
    // records employee compensation as PAID, so it is refused while payroll is locked — for every
    // account, administrators included. Calculation, review, approval and adjustments stay open.
    // Checked again inside the transaction; the database refuses the PAYOUT row and PAID too.
    if (!(await isPayrollLive())) return handleDomainError(payrollLockedRefusal("COMMISSION_PAYOUT"));
    const parsed = parseFiniteDecimal(b.amount ?? "");
    if (!parsed) return NextResponse.json({ error: "amount is not a number." }, { status: 400 });
    const amount = roundMoney(parsed);
    if (amount.lessThanOrEqualTo(ZERO)) {
      return NextResponse.json({ error: "A payout must be greater than zero." }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Native HR may pay this period through payroll. Both paths take this lock before
      // reading what is owed, so two payouts can never both pass the check below; and a
      // period a payroll run has reserved is paid by that run, never also here.
      await lockCommissionPeriod(tx, employeeId, periodStart);
      if (!(await isPayrollLive(tx))) throw payrollLockedRefusal("COMMISSION_PAYOUT");
      if (await isReservedByPayroll(tx, employeeId, periodStart)) {
        throw {
          _appCode: 409,
          message:
            "This period is reserved by a payroll run and will be paid through payroll. " +
            "Cancel that run first if it should be paid here instead.",
        };
      }
      const before = await periodStatement(tx, employeeId, periodStart);

      // Paying more than is owed is refused rather than recorded. An over-payment recorded
      // as a payout leaves a negative outstanding balance that every later period inherits,
      // and nobody reading it can tell whether it was a mistake or a policy.
      if (amount.greaterThan(before.outstanding)) {
        throw {
          _appCode: 409,
          message:
            `${employee.name} is owed ${before.outstanding.toFixed(2)} for this period, which is ` +
            `less than the ${amount.toFixed(2)} being paid. Record an adjustment first if the ` +
            "extra is deliberate.",
        };
      }

      // A payout against nothing approved is a payout of a provisional figure.
      const unapproved = await tx.commissionAccrual.count({
        where: { employeeId, periodStart, status: "ACCRUED" },
      });
      if (unapproved > 0) {
        throw {
          _appCode: 409,
          message: `${unapproved} accruals in this period are still waiting for approval. Approve them first.`,
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
          reason: typeof b.reason === "string" ? b.reason.trim() || null : null,
          actorId: user.id,
        },
        select: { id: true },
      });

      await tx.commissionAccrual.updateMany({
        where: { employeeId, periodStart, status: "APPROVED" },
        data: { status: "PAID" },
      });

      const after = await periodStatement(tx, employeeId, periodStart);
      return { entryId: entry.id, after };
    }, TX_OPTS);

    return NextResponse.json(
      {
        entryId: result.entryId,
        statement: {
          accrued: result.after.accrued.toFixed(2),
          adjustments: result.after.adjustments.toFixed(2),
          paid: result.after.paid.toFixed(2),
          outstanding: result.after.outstanding.toFixed(2),
        },
        notice:
          "This records that a payout was made. It does not move money — there is no payment " +
          "integration in this system.",
      },
      { status: 201 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}
