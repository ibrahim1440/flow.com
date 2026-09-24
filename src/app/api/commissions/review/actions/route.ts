import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { Decimal, ZERO, roundMoney, riyadhMonthStart } from "@/lib/services/commissions/engine";
import { approvePeriod, adjust, periodStatement } from "@/lib/services/commissions/accrual";

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

    const result = await prisma.$transaction(async (tx) => {
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
