import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { Decimal } from "@/lib/services/commissions/engine";
import {
  submitCollection, collectionSummary, PAYMENT_METHODS, type PaymentMethodValue,
} from "@/lib/services/sales/collections";
import { collectionScope, collectionWhere, seesAllSales } from "@/lib/services/sales/scope";

/**
 * Sales collections — the list, and recording a new one.
 *
 * Nothing here is a bank integration. A collection is a salesperson's claim that money
 * arrived; it becomes a fact when Finance verifies it, and only then does it create any
 * commission. Both halves of that sentence are enforced in the service, not here.
 */

/** GET /api/sales/collections — what the caller is allowed to see, newest first. */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const opportunityId = url.searchParams.get("opportunityId");

  const scope = collectionScope(user.permissions, user.id);

  try {
    const rows = await prisma.salesCollection.findMany({
      where: {
        ...collectionWhere(user.permissions, user.id),
        ...(status ? { status: status as never } : {}),
        ...(opportunityId ? { opportunityId } : {}),
      },
      orderBy: [{ submittedAt: "desc" }],
      take: 200,
      select: {
        id: true, status: true, amountGross: true, amountTax: true, amountNet: true,
        currency: true, paymentMethod: true, collectedAt: true, referenceNumber: true,
        note: true, submittedAt: true, decidedAt: true, decisionReason: true,
        reversedAt: true, reversalReason: true, collectionEventId: true,
        submittedBy: { select: { id: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
        reversedBy: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true, nameAr: true } },
        opportunity: { select: { id: true, title: true, ownerId: true } },
        quote: { select: { id: true, quoteNumber: true } },
        _count: { select: { evidence: true } },
        // The commission this collection actually produced. Read from the accruals against
        // its event rather than recomputed here, so the screen cannot disagree with the
        // ledger it is describing.
        collectionEvent: {
          select: {
            accruals: {
              select: {
                amount: true, status: true,
                employee: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    return NextResponse.json({
      rows,
      scope: scope.all ? "all" : "own",
      can: {
        submit: hasSubPrivilege(user.permissions, "sales", "collection_submit"),
        verify: hasSubPrivilege(user.permissions, "commissions", "collection_verify"),
        reject: hasSubPrivilege(user.permissions, "commissions", "collection_reject"),
        reverse: hasSubPrivilege(user.permissions, "commissions", "collection_reverse"),
      },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** POST /api/sales/collections — record a claimed receipt. Creates no commission. */
export async function POST(request: Request) {
  const { user, error } = await requireSub("sales", "collection_submit");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const opportunityId = typeof b.opportunityId === "string" ? b.opportunityId : "";
  if (!opportunityId) {
    return NextResponse.json({ error: "A collection has to name the deal it is against." }, { status: 400 });
  }

  // Client-generated and required. Without it a double-submitted form is two receipts, and
  // the second one is discovered by Finance approving the same money twice.
  const idempotencyKey = typeof b.idempotencyKey === "string" ? b.idempotencyKey.trim() : "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return NextResponse.json(
      { error: "idempotencyKey must be 8–128 characters. Generate one per form, not per click." },
      { status: 400 },
    );
  }

  const rawAmount = typeof b.amountGross === "string" || typeof b.amountGross === "number"
    ? String(b.amountGross).trim()
    : "";
  if (!/^\d+(\.\d{1,2})?$/.test(rawAmount)) {
    return NextResponse.json(
      { error: "amountGross must be a positive amount with at most two decimal places." },
      { status: 400 },
    );
  }
  const amountGross = new Decimal(rawAmount);

  const paymentMethod = (
    typeof b.paymentMethod === "string" && (PAYMENT_METHODS as string[]).includes(b.paymentMethod)
      ? b.paymentMethod
      : "BANK_TRANSFER"
  ) as PaymentMethodValue;

  let collectedAt = new Date();
  if (typeof b.collectedAt === "string" && b.collectedAt) {
    collectedAt = new Date(b.collectedAt);
    if (Number.isNaN(collectedAt.getTime())) {
      return NextResponse.json({ error: "collectedAt is not a date." }, { status: 400 });
    }
  }
  // A receipt dated next month lands in a commission period that has not happened.
  if (collectedAt.getTime() > Date.now() + 24 * 3600_000) {
    return NextResponse.json({ error: "A collection cannot be dated in the future." }, { status: 400 });
  }

  try {
    // Ownership first, and as a 404: a rep may record against a deal they own. Confirming
    // that somebody else's deal exists is the enumeration problem, so it is not confirmed.
    const deal = await prisma.opportunity.findFirst({
      where: { id: opportunityId, ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }) },
      select: { id: true },
    });
    if (!deal) return NextResponse.json({ error: "Deal not found." }, { status: 404 });

    const result = await prisma.$transaction(
      (tx) =>
        submitCollection(tx, {
          opportunityId,
          amountGross,
          currency: typeof b.currency === "string" && b.currency ? b.currency : "SAR",
          collectedAt,
          paymentMethod,
          referenceNumber: typeof b.referenceNumber === "string" ? b.referenceNumber : null,
          note: typeof b.note === "string" ? b.note : null,
          idempotencyKey,
          submittedById: user.id,
        }),
      TX_OPTS,
    );

    const summary = await collectionSummary(prisma, opportunityId);
    return NextResponse.json(
      {
        collectionId: result.collectionId,
        replayed: result.replayed,
        amountTax: result.amountTax.toFixed(2),
        amountNet: result.amountNet.toFixed(2),
        summary: serialiseSummary(summary),
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}

/** Decimals as fixed strings. A float on the wire is a float in somebody's commission. */
export function serialiseSummary(s: Awaited<ReturnType<typeof collectionSummary>>) {
  return {
    document: s.document
      ? {
          quoteId: s.document.quoteId,
          quoteNumber: s.document.quoteNumber,
          currency: s.document.currency,
          gross: s.document.gross.toFixed(2),
          tax: s.document.tax.toFixed(2),
          net: s.document.net.toFixed(2),
        }
      : null,
    approvedGross: s.approvedGross.toFixed(2),
    approvedTax: s.approvedTax.toFixed(2),
    approvedNet: s.approvedNet.toFixed(2),
    pendingGross: s.pendingGross.toFixed(2),
    reversedGross: s.reversedGross.toFixed(2),
    remainingGross: s.remainingGross.toFixed(2),
    state: s.state,
  };
}
