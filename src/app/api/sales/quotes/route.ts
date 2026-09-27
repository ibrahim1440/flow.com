import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { seesAllSales } from "@/lib/services/sales/scope";

import {
  nextQuoteNumber, saveQuoteLines, parseLineInputs, QUOTE_CURRENCY,
  DISCOUNT_APPROVAL_THRESHOLD_PERCENT,
} from "@/lib/services/sales/quotes";

const STATUSES = ["DRAFT", "ISSUED", "ACCEPTED", "REJECTED", "EXPIRED", "SUPERSEDED"];

/** GET /api/sales/quotes — the quotation list, scoped through the deal that owns it. */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const opportunityId = url.searchParams.get("opportunityId");
  const q = (url.searchParams.get("q") ?? "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("perPage") ?? 25) || 25));

  const scopeAll = seesAllSales(user.permissions);

  try {
    const where = {
      // A quotation has no owner column; the deal it belongs to does. Scoping through the
      // relation keeps one definition of "mine" rather than a second, drifting copy.
      ...(scopeAll ? {} : { opportunity: { ownerId: user.id } }),
      ...(status && STATUSES.includes(status) ? { status: status as never } : {}),
      ...(opportunityId ? { opportunityId } : {}),
      ...(q
        ? {
            OR: [
              { quoteNumber: { contains: q, mode: "insensitive" as const } },
              { opportunity: { title: { contains: q, mode: "insensitive" as const } } },
              { customer: { name: { contains: q, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.quote.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true, quoteNumber: true, revision: true, status: true, currency: true,
          validUntil: true, subtotal: true, discountTotal: true, taxTotal: true, grandTotal: true,
          issuedAt: true, acceptedAt: true, createdAt: true, supersedesId: true,
          customer: { select: { id: true, name: true, nameAr: true } },
          opportunity: {
            select: { id: true, title: true, outcome: true, owner: { select: { id: true, name: true } } },
          },
          _count: { select: { lines: true, orderLinks: true } },
        },
      }),
      prisma.quote.count({ where }),
    ]);

    return NextResponse.json({
      rows,
      page,
      perPage,
      total,
      scope: scopeAll ? "all" : "own",
      discountThresholdPercent: DISCOUNT_APPROVAL_THRESHOLD_PERCENT.toString(),
      can: {
        write: hasSubPrivilege(user.permissions, "sales", "quote_write"),
        approveDiscount: hasSubPrivilege(user.permissions, "sales", "quote_approve_discount"),
        createOrder: hasSubPrivilege(user.permissions, "orders", "create"),
      },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * POST /api/sales/quotes — raise a draft quotation on a deal.
 *
 * Created as a DRAFT with its lines priced by the service. Nothing here accepts a total
 * from the client: a quotation whose grand total arrives in the request body is a quotation
 * whose price the browser decides.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("sales", "quote_write");
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
    return NextResponse.json({ error: "A quotation belongs to a deal." }, { status: 400 });
  }
  if (typeof b.currency === "string" && b.currency !== QUOTE_CURRENCY) {
    return NextResponse.json(
      { error: `Only ${QUOTE_CURRENCY} quotations are supported; there is no exchange-rate policy configured.` },
      { status: 400 },
    );
  }

  let validUntil: Date | null = null;
  if (typeof b.validUntil === "string" && b.validUntil) {
    validUntil = new Date(b.validUntil);
    if (Number.isNaN(validUntil.getTime())) {
      return NextResponse.json({ error: "validUntil is not a date." }, { status: 400 });
    }
  }

  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  if (rawLines.length > 100) {
    return NextResponse.json({ error: "A quotation may carry at most 100 lines." }, { status: 400 });
  }

  try {
    const deal = await prisma.opportunity.findFirst({
      where: {
        id: opportunityId,
        ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }),
      },
      select: { id: true, customerId: true, outcome: true },
    });
    if (!deal) return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    if (deal.outcome === "LOST") {
      return NextResponse.json(
        { error: "This deal is lost. Reopen it before quoting again." },
        { status: 409 },
      );
    }

    const lines = parseLineInputs(rawLines);

    const result = await prisma.$transaction(async (tx) => {
      const quoteNumber = await nextQuoteNumber(tx, new Date());
      const created = await tx.quote.create({
        data: {
          quoteNumber,
          revision: 1,
          opportunityId,
          customerId: deal.customerId,
          status: "DRAFT",
          currency: QUOTE_CURRENCY,
          validUntil,
          createdById: user.id,
        },
        select: { id: true, quoteNumber: true, revision: true },
      });

      if (lines.length > 0) {
        const saved = await saveQuoteLines(tx, { quoteId: created.id, lines });
        return { quote: created, priced: saved.priced, needsDiscountApproval: saved.needsDiscountApproval };
      }
      return { quote: created, priced: null, needsDiscountApproval: false };
    }, TX_OPTS);

    return NextResponse.json(
      {
        quote: result.quote,
        totals: result.priced
          ? {
              subtotal: result.priced.subtotal.toFixed(2),
              discountTotal: result.priced.discountTotal.toFixed(2),
              taxTotal: result.priced.taxTotal.toFixed(2),
              grandTotal: result.priced.grandTotal.toFixed(2),
              effectiveDiscountPercent: result.priced.effectiveDiscountPercent.toString(),
            }
          : null,
        needsDiscountApproval: result.needsDiscountApproval,
      },
      { status: 201 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}
