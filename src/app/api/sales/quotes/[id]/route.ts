import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import {
  saveQuoteLines, parseLineInputs, isEditable, isRevisable, hasExpired,
  DISCOUNT_APPROVAL_THRESHOLD_PERCENT, type QuoteStatus,
} from "@/lib/services/sales/quotes";

type Params = { params: Promise<{ id: string }> };

/** GET /api/sales/quotes/[id] — one quotation, its lines and what may be done to it. */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  const { id } = await params;

  try {
    const quote = await prisma.quote.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { opportunity: { ownerId: user.id } }) },
      select: {
        id: true, quoteNumber: true, revision: true, status: true, currency: true,
        validUntil: true, subtotal: true, discountTotal: true, taxTotal: true, grandTotal: true,
        issuedAt: true, issuedSnapshot: true, acceptedAt: true, rejectedAt: true,
        rejectionNote: true, discountApprovedById: true, discountApprovedAt: true,
        supersedesId: true, createdAt: true, updatedAt: true,
        supersededBy: { select: { id: true, quoteNumber: true, revision: true, status: true } },
        supersedes: { select: { id: true, quoteNumber: true, revision: true } },
        customer: { select: { id: true, name: true, nameAr: true, phone: true, email: true, address: true } },
        opportunity: {
          select: {
            id: true, title: true, outcome: true, customerId: true,
            owner: { select: { id: true, name: true } },
          },
        },
        lines: {
          orderBy: { position: "asc" },
          select: {
            id: true, productSkuId: true, description: true, quantity: true, unit: true,
            unitPrice: true, discountPercent: true, taxRatePercent: true,
            lineSubtotal: true, lineTax: true, lineTotal: true, position: true,
            productSku: { select: { id: true, skuCode: true, name: true, nameAr: true, unitOfMeasure: true, price: true } },
          },
        },
        orderLinks: {
          select: {
            id: true, isFirstOrder: true, createdAt: true,
            order: { select: { id: true, orderNumber: true, status: true } },
          },
        },
      },
    });
    if (!quote) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const status = quote.status as QuoteStatus;
    const now = new Date();

    return NextResponse.json({
      quote,
      // Reported so the screen shows the right controls. Every one is re-checked on the
      // server by the endpoint that performs it; this copy is a convenience, not the gate.
      state: {
        editable: isEditable(status),
        revisable: isRevisable(status),
        expired: hasExpired(quote, now),
        orderable: status === "ACCEPTED" && quote.orderLinks.length === 0,
      },
      can: {
        write: hasSubPrivilege(user.permissions, "sales", "quote_write"),
        approveDiscount: hasSubPrivilege(user.permissions, "sales", "quote_approve_discount"),
        createOrder: hasSubPrivilege(user.permissions, "orders", "create"),
      },
      discountThresholdPercent: DISCOUNT_APPROVAL_THRESHOLD_PERCENT.toString(),
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PUT /api/sales/quotes/[id] — replace a draft's lines and header, recomputing the totals.
 *
 * Only a draft. Once a quotation is issued it is the document the customer holds, and the
 * way to change it is a new revision with its own number — which is what `revise` does.
 */
export async function PUT(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "quote_write");
  if (error) return error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const rawLines = Array.isArray(b.lines) ? b.lines : null;
  if (!rawLines) {
    return NextResponse.json({ error: "lines must be an array." }, { status: 400 });
  }
  if (rawLines.length > 100) {
    return NextResponse.json({ error: "A quotation may carry at most 100 lines." }, { status: 400 });
  }

  try {
    const quote = await prisma.quote.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { opportunity: { ownerId: user.id } }) },
      select: { id: true, status: true, customerId: true, opportunity: { select: { customerId: true } } },
    });
    if (!quote) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const header: Record<string, unknown> = {};
    if (b.validUntil === null) {
      header.validUntil = null;
    } else if (typeof b.validUntil === "string" && b.validUntil) {
      const d = new Date(b.validUntil);
      if (Number.isNaN(d.getTime())) throw { _appCode: 400, message: "validUntil is not a date." };
      header.validUntil = d;
    }
    if (typeof b.customerId === "string" && b.customerId) {
      const customer = await prisma.customer.findUnique({ where: { id: b.customerId }, select: { id: true } });
      if (!customer) throw { _appCode: 400, message: "That customer does not exist." };
      header.customerId = b.customerId;
    }

    const lines = parseLineInputs(rawLines);

    const saved = await prisma.$transaction(async (tx) => {
      if (Object.keys(header).length > 0) {
        // The status check inside saveQuoteLines is the real gate, but the header must not
        // slip past it either: editing an issued quote's validity date silently extends an
        // offer the customer was given a deadline on.
        if (!isEditable(quote.status as QuoteStatus)) {
          throw {
            _appCode: 409,
            message: `A ${quote.status.toLowerCase()} quotation cannot be edited. Raise a new revision instead.`,
          };
        }
        await tx.quote.update({ where: { id }, data: header });
      }
      return saveQuoteLines(tx, { quoteId: id, lines });
    }, TX_OPTS);

    return NextResponse.json({
      totals: {
        subtotal: saved.priced.subtotal.toFixed(2),
        discountTotal: saved.priced.discountTotal.toFixed(2),
        taxTotal: saved.priced.taxTotal.toFixed(2),
        grandTotal: saved.priced.grandTotal.toFixed(2),
        effectiveDiscountPercent: saved.priced.effectiveDiscountPercent.toString(),
      },
      needsDiscountApproval: saved.needsDiscountApproval,
      // Said now, on the draft, rather than as a surprise refusal at the moment of issue.
      notice: saved.needsDiscountApproval
        ? `This discount is above ${DISCOUNT_APPROVAL_THRESHOLD_PERCENT.toString()}%, so a manager with ` +
          "discount approval must be the one to issue it."
        : null,
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** DELETE /api/sales/quotes/[id] — discard a draft that was raised by mistake. */
export async function DELETE(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "quote_write");
  if (error) return error;
  const { id } = await params;

  try {
    const quote = await prisma.quote.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { opportunity: { ownerId: user.id } }) },
      select: { id: true, status: true, quoteNumber: true },
    });
    if (!quote) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    if (quote.status !== "DRAFT") {
      // An issued quotation is a document that left the building. Deleting it removes the
      // record of a price somebody was given.
      return NextResponse.json(
        { error: `${quote.quoteNumber} has been issued and is part of the record. It cannot be deleted.` },
        { status: 409 },
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.quoteLine.deleteMany({ where: { quoteId: id } });
      await tx.quote.delete({ where: { id } });
    }, TX_OPTS);

    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handleDomainError(err);
  }
}
