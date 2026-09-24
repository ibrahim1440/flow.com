import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { Decimal, ZERO, roundMoney } from "../commissions/engine";

type Tx = PrismaNS.TransactionClient;

/**
 * Quotations: pricing, the rules about discounts, and the lifecycle.
 *
 * The arithmetic is separated from the rows on purpose, exactly as the commission engine
 * is, so the money can be asserted against worked examples with no database running.
 *
 * ── Money ──
 * Decimal throughout. A quotation is the document a customer is invoiced against and the
 * document a commission is eventually computed from; a float total that is a hundredth out
 * becomes an argument with a café owner.
 *
 * ── What this file deliberately does NOT do ──
 * It does not touch stock. A quotation is an offer, not a reservation: pricing a hundred
 * bags must not make a hundred bags unavailable to the orders that are already real. The
 * reservation happens when the quote becomes an order, through the order service, under
 * that service's own guards.
 */

/** The only currency this system has a price list and a commission policy for. */
export const QUOTE_CURRENCY = "SAR";

/**
 * Discount above which a quotation needs `quote_approve_discount` before it may be issued.
 *
 * A policy constant rather than a settings row, and named so it is findable. Ten percent is
 * the figure to change when the business states its own; what matters structurally is that
 * a rep cannot issue an unlimited discount unilaterally, and that the authorisation is
 * recorded on the quote (`discountApprovedById`) rather than implied by who clicked issue.
 */
export const DISCOUNT_APPROVAL_THRESHOLD_PERCENT = new Decimal(10);

/** Hard ceiling. Not even an approver may give the coffee away by typing a wrong number. */
export const MAX_DISCOUNT_PERCENT = new Decimal(60);

const HUNDRED = new Decimal(100);

// ─── Pricing ──────────────────────────────────────────────────────────────────

export type LineInput = {
  /** One of these two is required; a bespoke blend or a delivery charge has no SKU. */
  productSkuId?: string | null;
  description?: string | null;
  quantity: Decimal;
  unit?: string;
  unitPrice: Decimal;
  discountPercent?: Decimal;
  taxRatePercent?: Decimal;
  position?: number;
};

export type PricedLine = {
  /** Quantity x unit price, before any discount. */
  gross: Decimal;
  discountAmount: Decimal;
  /** After discount, before tax. This is what the schema's `lineSubtotal` holds. */
  lineSubtotal: Decimal;
  lineTax: Decimal;
  lineTotal: Decimal;
};

export type PricedQuote = {
  lines: PricedLine[];
  /** Sum of the gross line values, BEFORE discount — so the discount stays visible. */
  subtotal: Decimal;
  discountTotal: Decimal;
  taxTotal: Decimal;
  grandTotal: Decimal;
  /** discountTotal as a percentage of subtotal. Zero on an empty or free quote. */
  effectiveDiscountPercent: Decimal;
};

/**
 * Price one line.
 *
 * Rounded at each step rather than once at the end, because these four figures are stored
 * and shown. A customer who adds up the printed lines must reach the printed total; if the
 * total were computed from unrounded intermediates it could differ from the visible sum by
 * a halala per line, and that is the arithmetic nobody ever wins an argument about.
 */
export function priceLine(line: LineInput): PricedLine {
  const gross = roundMoney(line.quantity.times(line.unitPrice));
  const discountAmount = roundMoney(gross.times(line.discountPercent ?? ZERO).dividedBy(HUNDRED));
  const lineSubtotal = roundMoney(gross.minus(discountAmount));
  const lineTax = roundMoney(lineSubtotal.times(line.taxRatePercent ?? ZERO).dividedBy(HUNDRED));
  const lineTotal = roundMoney(lineSubtotal.plus(lineTax));
  return { gross, discountAmount, lineSubtotal, lineTax, lineTotal };
}

/**
 * Price a whole quotation.
 *
 * `grandTotal` is computed from the stored components, so `subtotal - discountTotal +
 * taxTotal === grandTotal` holds exactly for every quote. Summing `lineTotal` instead would
 * usually agree and occasionally not, and "usually" is not a property a document has.
 */
export function priceQuote(lines: LineInput[]): PricedQuote {
  const priced = lines.map(priceLine);
  const sum = (pick: (p: PricedLine) => Decimal) =>
    roundMoney(priced.reduce((acc, p) => acc.plus(pick(p)), ZERO));

  const subtotal = sum((p) => p.gross);
  const discountTotal = sum((p) => p.discountAmount);
  const taxTotal = sum((p) => p.lineTax);
  const grandTotal = roundMoney(subtotal.minus(discountTotal).plus(taxTotal));

  return {
    lines: priced,
    subtotal,
    discountTotal,
    taxTotal,
    grandTotal,
    effectiveDiscountPercent: subtotal.isZero()
      ? ZERO
      : discountTotal.times(HUNDRED).dividedBy(subtotal).toDecimalPlaces(6, Decimal.ROUND_HALF_UP),
  };
}

/**
 * Turn request JSON into the line shape this service computes with.
 *
 * Amounts arrive as strings and are converted with Decimal, never with `Number()`. A price
 * that passes through a float on its way in has already lost whatever the float lost, and
 * no amount of Decimal arithmetic afterwards gets it back — which is the whole reason the
 * rest of this file is Decimal at all.
 */
export function parseLineInputs(raw: unknown[]): LineInput[] {
  return raw.map((r, i) => {
    const l = (r ?? {}) as Record<string, unknown>;
    const dec = (v: unknown, field: string, fallback?: string): Decimal => {
      if (v === undefined || v === null || v === "") {
        if (fallback !== undefined) return new Decimal(fallback);
        throw { _appCode: 400, message: `Line ${i + 1}: ${field} is required.` };
      }
      try {
        return new Decimal(String(v));
      } catch {
        throw { _appCode: 400, message: `Line ${i + 1}: ${field} is not a number.` };
      }
    };

    return {
      productSkuId: typeof l.productSkuId === "string" && l.productSkuId ? l.productSkuId : null,
      description: typeof l.description === "string" ? l.description : null,
      quantity: dec(l.quantity, "quantity"),
      unit: typeof l.unit === "string" && l.unit ? l.unit : "KG",
      unitPrice: dec(l.unitPrice, "unit price"),
      discountPercent: dec(l.discountPercent, "discount", "0"),
      taxRatePercent: dec(l.taxRatePercent, "tax rate", "0"),
      position: i,
    };
  });
}

// ─── Validation ───────────────────────────────────────────────────────────────

export type LineProblem = { index: number; code: string; message: string };

/**
 * What a SKU needs to be for a quantity to make sense on it.
 *
 * `unitOfMeasure` decides whether fractions are allowed. 1.5 kg of beans is an ordinary
 * order; 1.5 retail bags is not a thing that can be picked off a shelf, and accepting it
 * here produces an order line the warehouse cannot fulfil.
 */
export type SkuFacts = {
  id: string;
  isActive: boolean;
  unitOfMeasure: string;
  skuCode: string;
};

export function validateLines(lines: LineInput[], skus: Map<string, SkuFacts>): LineProblem[] {
  const problems: LineProblem[] = [];
  if (lines.length === 0) {
    problems.push({ index: -1, code: "EMPTY", message: "A quotation needs at least one line." });
    return problems;
  }

  lines.forEach((line, index) => {
    const at = (code: string, message: string) => problems.push({ index, code, message });

    const hasSku = typeof line.productSkuId === "string" && line.productSkuId.length > 0;
    const hasText = typeof line.description === "string" && line.description.trim().length >= 2;
    if (!hasSku && !hasText) {
      at("NO_SUBJECT", "Each line needs either a product or a description of what is being quoted.");
    }

    if (line.quantity.lessThanOrEqualTo(0)) {
      at("QTY", "Quantity must be greater than zero.");
    }
    if (line.unitPrice.isNegative()) {
      at("PRICE", "A unit price cannot be negative.");
    }

    const disc = line.discountPercent ?? ZERO;
    if (disc.isNegative() || disc.greaterThan(HUNDRED)) {
      at("DISCOUNT_RANGE", "A discount must be between 0 and 100 percent.");
    } else if (disc.greaterThan(MAX_DISCOUNT_PERCENT)) {
      at(
        "DISCOUNT_CEILING",
        `A discount above ${MAX_DISCOUNT_PERCENT.toString()}% is refused. Correct the price instead.`,
      );
    }

    const tax = line.taxRatePercent ?? ZERO;
    if (tax.isNegative() || tax.greaterThan(HUNDRED)) {
      at("TAX_RANGE", "A tax rate must be between 0 and 100 percent.");
    }

    if (hasSku) {
      const sku = skus.get(line.productSkuId as string);
      if (!sku) {
        at("SKU_MISSING", "That product no longer exists.");
      } else {
        if (!sku.isActive) {
          at("SKU_INACTIVE", `"${sku.skuCode}" is inactive and cannot be quoted.`);
        }
        // Discrete packs come in whole numbers. KG and GRAM lines may carry fractions.
        if (sku.unitOfMeasure === "UNIT" || sku.unitOfMeasure === "PIECE") {
          if (!line.quantity.equals(line.quantity.trunc())) {
            at(
              "SKU_FRACTION",
              `"${sku.skuCode}" is sold as whole packs, so ${line.quantity.toString()} cannot be quoted.`,
            );
          }
        }
      }
    }
  });

  return problems;
}

/** Whether this quote may be issued by a caller who cannot approve discounts. */
export function discountNeedsApproval(priced: PricedQuote): boolean {
  return priced.effectiveDiscountPercent.greaterThan(DISCOUNT_APPROVAL_THRESHOLD_PERCENT);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export type QuoteStatus = "DRAFT" | "ISSUED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "SUPERSEDED";

/**
 * Which moves are legal, stated once.
 *
 * A table rather than a chain of ifs, because the interesting property is what is ABSENT:
 * nothing leads back out of ACCEPTED or SUPERSEDED. An accepted quotation is the basis a
 * deal was won on and an order may already exist against it; editing it afterwards would
 * change what the customer agreed to. The way to change an accepted price is a new revision
 * of the quote, which is a new document with its own number.
 */
export const ALLOWED_QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  DRAFT: ["ISSUED"],
  ISSUED: ["ACCEPTED", "REJECTED", "EXPIRED"],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
  SUPERSEDED: [],
};

/** True when a quote's lines and prices may still be edited. */
export function isEditable(status: QuoteStatus): boolean {
  return status === "DRAFT";
}

/** True when a new revision may be raised from this one. */
export function isRevisable(status: QuoteStatus): boolean {
  return status === "ISSUED" || status === "REJECTED" || status === "EXPIRED";
}

export function assertTransition(from: QuoteStatus, to: QuoteStatus): void {
  if (from === to) {
    throw { _appCode: 409, message: `This quotation is already ${from.toLowerCase()}.` };
  }
  if (!ALLOWED_QUOTE_TRANSITIONS[from].includes(to)) {
    throw {
      _appCode: 409,
      message:
        `A ${from.toLowerCase()} quotation cannot become ${to.toLowerCase()}.` +
        (from === "ACCEPTED" || from === "SUPERSEDED" ? " Raise a new revision instead." : ""),
    };
  }
}

/**
 * Has this quote passed its validity date?
 *
 * Reported, never inferred silently. An expired quotation is a business fact — the price is
 * no longer on offer — and the accept path refuses one rather than letting a stale price
 * through because nobody ran a nightly job.
 */
export function hasExpired(quote: { validUntil: Date | null }, at: Date): boolean {
  return quote.validUntil !== null && quote.validUntil.getTime() < at.getTime();
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

/**
 * Next quotation number, as `Q-YYYYMM-NNNN`.
 *
 * Scoped to the month so the sequence stays short and readable, and derived from the
 * highest existing number in that month rather than from a count — deleting a draft must
 * not hand its number to the next quote.
 */
export async function nextQuoteNumber(tx: Tx, at: Date): Promise<string> {
  const ym = `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
  const prefix = `Q-${ym}-`;
  const last = await tx.quote.findFirst({
    where: { quoteNumber: { startsWith: prefix } },
    orderBy: { quoteNumber: "desc" },
    select: { quoteNumber: true },
  });
  const n = last ? Number(last.quoteNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, "0")}`;
}

export type SaveLinesResult = {
  priced: PricedQuote;
  needsDiscountApproval: boolean;
};

/**
 * Replace a draft quotation's lines and recompute its totals.
 *
 * Totals are computed HERE, from the lines, and never accepted from the client. A quote
 * whose grand total arrives in the request body is a quote whose price the browser decides.
 */
export async function saveQuoteLines(
  tx: Tx,
  input: { quoteId: string; lines: LineInput[] },
): Promise<SaveLinesResult> {
  const quote = await tx.quote.findUnique({
    where: { id: input.quoteId },
    select: { id: true, status: true, currency: true },
  });
  if (!quote) throw { _appCode: 404, message: "Quotation not found." };
  if (!isEditable(quote.status as QuoteStatus)) {
    throw {
      _appCode: 409,
      message: `A ${quote.status.toLowerCase()} quotation cannot be edited. Raise a new revision instead.`,
    };
  }
  if (quote.currency !== QUOTE_CURRENCY) {
    throw {
      _appCode: 409,
      message: `Only ${QUOTE_CURRENCY} quotations are supported; there is no exchange-rate policy configured.`,
    };
  }

  const skuIds = input.lines
    .map((l) => l.productSkuId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const skuRows = skuIds.length
    ? await tx.productSKU.findMany({
        where: { id: { in: skuIds } },
        select: { id: true, isActive: true, unitOfMeasure: true, skuCode: true },
      })
    : [];
  const skus = new Map<string, SkuFacts>(skuRows.map((s) => [s.id, s as SkuFacts]));

  const problems = validateLines(input.lines, skus);
  if (problems.length > 0) {
    throw { _appCode: 400, message: problems[0].message, problems };
  }

  const priced = priceQuote(input.lines);

  // Replaced wholesale rather than diffed. A draft's lines have no history worth
  // preserving — the document that matters is the issued snapshot — and a diff here would
  // be a second place for the totals to drift out of step with the rows.
  await tx.quoteLine.deleteMany({ where: { quoteId: input.quoteId } });
  await tx.quoteLine.createMany({
    data: input.lines.map((line, i) => ({
      quoteId: input.quoteId,
      productSkuId: line.productSkuId || null,
      description: line.description?.trim() || null,
      quantity: line.quantity,
      unit: line.unit ?? "KG",
      unitPrice: line.unitPrice,
      discountPercent: line.discountPercent ?? ZERO,
      taxRatePercent: line.taxRatePercent ?? ZERO,
      lineSubtotal: priced.lines[i].lineSubtotal,
      lineTax: priced.lines[i].lineTax,
      lineTotal: priced.lines[i].lineTotal,
      position: line.position ?? i,
    })),
  });

  await tx.quote.update({
    where: { id: input.quoteId },
    data: {
      subtotal: priced.subtotal,
      discountTotal: priced.discountTotal,
      taxTotal: priced.taxTotal,
      grandTotal: priced.grandTotal,
    },
  });

  return { priced, needsDiscountApproval: discountNeedsApproval(priced) };
}

/**
 * Issue a quotation: freeze it and put it in front of the customer.
 *
 * The snapshot is the point. After this the lines could in principle be read back from
 * QuoteLine, but those rows track the live catalogue — a SKU renamed next month would
 * silently rewrite what the customer was sent. `issuedSnapshot` is what was actually
 * offered, in the words it was offered in.
 */
export async function issueQuote(
  tx: Tx,
  input: { quoteId: string; actorId: string; canApproveDiscount: boolean; at?: Date },
): Promise<{ quoteNumber: string; grandTotal: Decimal; discountApproved: boolean }> {
  const at = input.at ?? new Date();

  const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT "id", "status"::text AS status FROM "Quote" WHERE "id" = ${input.quoteId} FOR UPDATE
  `;
  if (!locked[0]) throw { _appCode: 404, message: "Quotation not found." };
  assertTransition(locked[0].status as QuoteStatus, "ISSUED");

  const quote = await tx.quote.findUniqueOrThrow({
    where: { id: input.quoteId },
    select: {
      id: true, quoteNumber: true, revision: true, currency: true, validUntil: true,
      customerId: true, opportunityId: true,
      lines: {
        orderBy: { position: "asc" },
        select: {
          productSkuId: true, description: true, quantity: true, unit: true,
          unitPrice: true, discountPercent: true, taxRatePercent: true,
          lineSubtotal: true, lineTax: true, lineTotal: true, position: true,
          productSku: { select: { skuCode: true, name: true, nameAr: true } },
        },
      },
    },
  });

  if (quote.lines.length === 0) {
    throw { _appCode: 400, message: "A quotation cannot be issued with no lines." };
  }
  if (!quote.validUntil) {
    throw { _appCode: 400, message: "An issued quotation needs a validity date." };
  }
  if (quote.validUntil.getTime() <= at.getTime()) {
    throw { _appCode: 400, message: "The validity date has already passed. Choose a later one." };
  }

  const priced = priceQuote(
    quote.lines.map((l) => ({
      productSkuId: l.productSkuId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPercent: l.discountPercent,
      taxRatePercent: l.taxRatePercent,
    })),
  );

  // Re-checked at issue, not only when the lines were saved. The saving caller and the
  // issuing caller can be different people, and the authorisation belongs to the act that
  // puts the price in front of the customer.
  let discountApproved = false;
  if (discountNeedsApproval(priced)) {
    if (!input.canApproveDiscount) {
      throw {
        _appCode: 403,
        message:
          `This quotation discounts ${priced.effectiveDiscountPercent.toDecimalPlaces(2).toString()}%, ` +
          `above the ${DISCOUNT_APPROVAL_THRESHOLD_PERCENT.toString()}% that may be given without approval. ` +
          "A manager with discount approval must issue it.",
      };
    }
    discountApproved = true;
  }

  const snapshot = {
    frozenAt: at.toISOString(),
    quoteNumber: quote.quoteNumber,
    revision: quote.revision,
    currency: quote.currency,
    validUntil: quote.validUntil.toISOString(),
    totals: {
      subtotal: priced.subtotal.toFixed(2),
      discountTotal: priced.discountTotal.toFixed(2),
      taxTotal: priced.taxTotal.toFixed(2),
      grandTotal: priced.grandTotal.toFixed(2),
      effectiveDiscountPercent: priced.effectiveDiscountPercent.toString(),
    },
    lines: quote.lines.map((l, i) => ({
      position: l.position,
      // The name as it stood when the offer was made, not as the catalogue reads today.
      productSkuId: l.productSkuId,
      skuCode: l.productSku?.skuCode ?? null,
      name: l.productSku?.name ?? l.description,
      nameAr: l.productSku?.nameAr ?? null,
      description: l.description,
      quantity: l.quantity.toString(),
      unit: l.unit,
      unitPrice: l.unitPrice.toFixed(2),
      discountPercent: l.discountPercent.toString(),
      taxRatePercent: l.taxRatePercent.toString(),
      gross: priced.lines[i].gross.toFixed(2),
      discountAmount: priced.lines[i].discountAmount.toFixed(2),
      lineSubtotal: priced.lines[i].lineSubtotal.toFixed(2),
      lineTax: priced.lines[i].lineTax.toFixed(2),
      lineTotal: priced.lines[i].lineTotal.toFixed(2),
    })),
  };

  await tx.quote.update({
    where: { id: input.quoteId },
    data: {
      status: "ISSUED",
      issuedAt: at,
      issuedSnapshot: snapshot as unknown as PrismaNS.InputJsonValue,
      subtotal: priced.subtotal,
      discountTotal: priced.discountTotal,
      taxTotal: priced.taxTotal,
      grandTotal: priced.grandTotal,
      ...(discountApproved ? { discountApprovedById: input.actorId, discountApprovedAt: at } : {}),
    },
  });

  return { quoteNumber: quote.quoteNumber, grandTotal: priced.grandTotal, discountApproved };
}

/**
 * Accept, reject or expire an issued quotation.
 *
 * Acceptance is the fact a deal may then be won on, so it is guarded: an expired offer
 * cannot be accepted, and rejection needs a reason for the same purpose a lost deal does —
 * a pipeline of rejected quotations with no reasons teaches nobody anything.
 */
export async function decideQuote(
  tx: Tx,
  input: {
    quoteId: string;
    to: "ACCEPTED" | "REJECTED" | "EXPIRED";
    note?: string | null;
    actorId: string;
    at?: Date;
  },
): Promise<{ status: string }> {
  const at = input.at ?? new Date();

  const locked = await tx.$queryRaw<{ id: string; status: string; validUntil: Date | null }[]>`
    SELECT "id", "status"::text AS status, "validUntil"
      FROM "Quote" WHERE "id" = ${input.quoteId} FOR UPDATE
  `;
  const row = locked[0];
  if (!row) throw { _appCode: 404, message: "Quotation not found." };
  assertTransition(row.status as QuoteStatus, input.to);

  if (input.to === "ACCEPTED" && hasExpired(row, at)) {
    throw {
      _appCode: 409,
      message: "This quotation expired. Raise a new revision at a current price before accepting.",
    };
  }
  if (input.to === "REJECTED" && !(input.note ?? "").trim()) {
    throw { _appCode: 400, message: "Recording a rejection needs a reason." };
  }

  await tx.quote.update({
    where: { id: input.quoteId },
    data: {
      status: input.to,
      acceptedAt: input.to === "ACCEPTED" ? at : undefined,
      rejectedAt: input.to === "REJECTED" ? at : undefined,
      rejectionNote: input.to === "REJECTED" ? (input.note ?? "").trim() : undefined,
    },
  });

  return { status: input.to };
}

/**
 * Raise revision n+1 of a quotation, superseding the original.
 *
 * The chain is walkable in both directions (`supersedesId` / `supersededBy`) so the history
 * of what was offered at what price is readable. The lines are copied as they stand, which
 * is what a person revising a price actually wants to start from.
 */
export async function reviseQuote(
  tx: Tx,
  input: { quoteId: string; actorId: string; at?: Date },
): Promise<{ id: string; quoteNumber: string; revision: number }> {
  const at = input.at ?? new Date();

  const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT "id", "status"::text AS status FROM "Quote" WHERE "id" = ${input.quoteId} FOR UPDATE
  `;
  const row = locked[0];
  if (!row) throw { _appCode: 404, message: "Quotation not found." };
  if (!isRevisable(row.status as QuoteStatus)) {
    throw {
      _appCode: 409,
      message:
        row.status === "ACCEPTED"
          ? "An accepted quotation is what the customer agreed to and is not revised. Raise a new quotation on the deal."
          : `A ${row.status.toLowerCase()} quotation cannot be revised.`,
    };
  }

  const original = await tx.quote.findUniqueOrThrow({
    where: { id: input.quoteId },
    select: {
      opportunityId: true, customerId: true, currency: true, revision: true, validUntil: true,
      lines: {
        orderBy: { position: "asc" },
        select: {
          productSkuId: true, description: true, quantity: true, unit: true, unitPrice: true,
          discountPercent: true, taxRatePercent: true, position: true,
        },
      },
    },
  });

  const quoteNumber = await nextQuoteNumber(tx, at);
  const created = await tx.quote.create({
    data: {
      quoteNumber,
      revision: original.revision + 1,
      supersedesId: input.quoteId,
      opportunityId: original.opportunityId,
      customerId: original.customerId,
      status: "DRAFT",
      currency: original.currency,
      validUntil: original.validUntil,
      createdById: input.actorId,
    },
    select: { id: true, quoteNumber: true, revision: true },
  });

  // The lines are written by the same call that computes the totals, so the new draft's
  // figures are this service's arithmetic rather than an inherited number nobody re-derived.
  await saveQuoteLines(tx, {
    quoteId: created.id,
    lines: original.lines.map((l) => ({
      productSkuId: l.productSkuId,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      discountPercent: l.discountPercent,
      taxRatePercent: l.taxRatePercent,
      position: l.position,
    })),
  });

  await tx.quote.update({ where: { id: input.quoteId }, data: { status: "SUPERSEDED" } });

  return created;
}
