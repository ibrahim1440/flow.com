import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { resolveLostReason, type LostReasonCode } from "./needs";
import { sampleSkipRequired, sampleSkipReasonText, SAMPLE_SKIP_REFUSAL } from "./stages";

type Tx = PrismaNS.TransactionClient;

/**
 * Lead handling: normalisation, duplicate detection and conversion.
 *
 * The rule that shapes this file: a company has many people, so two leads sharing a company
 * name are not a duplicate of each other. Automatic merging on name similarity is how real
 * customer records get destroyed, so nothing here merges. Candidates are SURFACED and a
 * person decides.
 */

/**
 * Normalise for comparison only — never for display.
 *
 * Arabic text needs more than lowercasing: the same company is written with أ إ آ or ا, with
 * or without ـ tatweel, and with or without diacritics. Comparing raw strings would report
 * two spellings of one café as unrelated.
 */
export function normalizeCompany(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, "")      // Arabic diacritics
    .replace(/ـ/g, "")                      // tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[ةه]$/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")            // punctuation → space, any script
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Last nine digits of a phone number, ignoring formatting and country prefix.
 *
 * +966 50 123 4567, 00966501234567 and 0501234567 are one phone. Comparing the raw strings
 * finds none of them equal.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-9);
}

export type DuplicateCandidate = {
  leadId: string;
  companyName: string;
  contactName: string;
  matchedOn: ("phone" | "company")[];
  /** True only for a phone match, which identifies a person rather than an organisation. */
  strong: boolean;
};

/**
 * Find leads that MIGHT be the same record. Never merges, never blocks on its own.
 *
 * A phone match is strong: it is one handset. A company match is weak on purpose — several
 * buyers at one café are the normal case, not an error.
 */
export async function findDuplicateCandidates(
  tx: Tx,
  input: { companyName: string; phone?: string | null; excludeLeadId?: string },
): Promise<DuplicateCandidate[]> {
  const company = normalizeCompany(input.companyName);
  const phone = normalizePhone(input.phone);

  const rows = await tx.lead.findMany({
    where: {
      AND: [
        input.excludeLeadId ? { id: { not: input.excludeLeadId } } : {},
        { status: { not: "CONVERTED" } },
        {
          OR: [
            ...(phone ? [{ normalizedPhone: phone }] : []),
            ...(company ? [{ normalizedCompany: company }] : []),
          ],
        },
      ],
    },
    select: { id: true, companyName: true, contactName: true, normalizedCompany: true, normalizedPhone: true },
    take: 25,
  });

  return rows.map((r) => {
    const matchedOn: ("phone" | "company")[] = [];
    if (phone && r.normalizedPhone === phone) matchedOn.push("phone");
    if (company && r.normalizedCompany === company) matchedOn.push("company");
    return {
      leadId: r.id,
      companyName: r.companyName,
      contactName: r.contactName,
      matchedOn,
      strong: matchedOn.includes("phone"),
    };
  });
}

/** The normalised keys to store alongside a lead. Written by the service, never by a client. */
export function normalizationFor(input: { companyName: string; phone?: string | null }) {
  return {
    normalizedCompany: normalizeCompany(input.companyName) || null,
    normalizedPhone: normalizePhone(input.phone),
  };
}

export type ConversionResult = {
  leadId: string;
  customerId: string;
  opportunityId: string;
  customerCreated: boolean;
  /** True when this call found an existing conversion instead of making one. */
  replayed: boolean;
};

/**
 * Convert a qualified lead into a customer and an opportunity.
 *
 * Idempotent, and it has to be: this is the button people double-click. Two things make it
 * safe. The lead row is locked first, so two concurrent requests queue rather than race; and
 * LeadConversion is unique on leadId, so even if a caller bypassed the lock the second
 * insert could not land. The loser reads what the winner wrote and returns it.
 *
 * Reuses the existing Customer — it does NOT create a parallel customer system. When
 * `linkToCustomerId` is supplied the lead attaches to that customer; otherwise a new one is
 * created from the lead's own details.
 */
export async function convertLead(
  tx: Tx,
  input: {
    leadId: string;
    linkToCustomerId?: string | null;
    stageId: string;
    title?: string;
    amount?: PrismaNS.Decimal;
    expectedCloseAt?: Date | null;
    actorId: string;
  },
): Promise<ConversionResult> {
  const locked = await tx.$queryRaw<{ id: string; status: string; ownerId: string; companyName: string }[]>`
    SELECT "id", "status"::text AS status, "ownerId", "companyName"
      FROM "Lead"
     WHERE "id" = ${input.leadId}
       FOR UPDATE
  `;
  const lead = locked[0];
  if (!lead) throw { _appCode: 404, message: "Lead not found." };

  // Behind the lock, with nothing cheaper in front of it.
  const existing = await tx.leadConversion.findUnique({
    where: { leadId: input.leadId },
    select: { leadId: true, customerId: true, opportunityId: true, customerCreated: true },
  });
  if (existing) {
    return { ...existing, replayed: true };
  }

  if (lead.status === "UNQUALIFIED") {
    throw { _appCode: 409, message: "An unqualified lead cannot be converted. Qualify it first, or reopen it." };
  }

  const full = await tx.lead.findUniqueOrThrow({
    where: { id: input.leadId },
    select: {
      companyName: true, companyNameAr: true, contactName: true,
      phone: true, email: true, address: true, ownerId: true,
      // The needs analysis gathered on the lead travels with it (20261204100000_pipeline_qualification).
      businessType: true, needSummary: true, expectedMonthlyKg: true, agreedNextStep: true,
    },
  });

  let customerId = input.linkToCustomerId ?? null;
  let customerCreated = false;
  if (!customerId) {
    const customer = await tx.customer.create({
      data: {
        name: full.companyName,
        nameAr: full.companyNameAr,
        phone: full.phone,
        email: full.email,
        address: full.address,
        // The lead's owner is responsible for the new account («المسؤول»): without it the customer
        // sat in nobody's book, so invoice scope and the account page could not attribute it.
        accountOwnerId: full.ownerId,
      },
      select: { id: true },
    });
    customerId = customer.id;
    customerCreated = true;
  } else {
    // Refuse a link to a customer that does not exist rather than writing a dangling id.
    const exists = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!exists) throw { _appCode: 404, message: "That customer no longer exists." };
  }

  const opportunity = await tx.opportunity.create({
    data: {
      title: input.title?.trim() || full.companyName,
      customerId,
      stageId: input.stageId,
      outcome: "OPEN",
      amount: input.amount ?? undefined,
      expectedCloseAt: input.expectedCloseAt ?? null,
      ownerId: full.ownerId,
      businessType: full.businessType,
      needSummary: full.needSummary,
      expectedMonthlyKg: full.expectedMonthlyKg,
      agreedNextStep: full.agreedNextStep,
    },
    select: { id: true },
  });

  await tx.opportunityStageEvent.create({
    data: {
      opportunityId: opportunity.id,
      toStageId: input.stageId,
      toOutcome: "OPEN",
      reason: "Created by lead conversion",
      actorId: input.actorId,
    },
  });

  const conversion = await tx.leadConversion.create({
    data: {
      leadId: input.leadId,
      customerId,
      opportunityId: opportunity.id,
      customerCreated,
      convertedById: input.actorId,
    },
    select: { leadId: true, customerId: true, opportunityId: true, customerCreated: true },
  });

  await tx.lead.update({ where: { id: input.leadId }, data: { status: "CONVERTED" } });

  // The lead's history follows it. Activities keep their lead link and gain the customer,
  // so a conversation from before the sale is still readable after it.
  await tx.activity.updateMany({
    where: { leadId: input.leadId },
    data: { customerId },
  });

  return { ...conversion, replayed: false };
}

/**
 * Move an opportunity between stages, or close it.
 *
 * Enforced on the server. Dragging a card is a request, not a decision: the Kanban calls
 * this and is refused exactly as any other caller would be.
 */
export async function transitionOpportunity(
  tx: Tx,
  input: {
    opportunityId: string;
    toStageId?: string | null;
    toOutcome?: "OPEN" | "WON" | "LOST" | null;
    lostReason?: string | null;
    /** Optional coded loss reason (LOST_REASON_CODES); the text stays required unless a code other than OTHER is given. */
    lostReasonCode?: string | null;
    /**
     * Why the samples are being skipped. Required (409 SAMPLE_SKIP_REASON_REQUIRED without it) when
     * the move goes forward past the Sample Evaluation stage and the deal has no sample; stored on
     * the stage event's reason (`sampleSkipReasonText`). Ignored on every other move.
     */
    skipReason?: string | null;
    actorId: string;
    canReopen: boolean;
  },
): Promise<{ stageId: string; outcome: string; fromStageId: string; fromOutcome: string; samplesSkipped: boolean }> {
  const locked = await tx.$queryRaw<{ id: string; stageId: string; outcome: string; customerId: string | null }[]>`
    SELECT "id", "stageId", "outcome"::text AS outcome, "customerId"
      FROM "Opportunity"
     WHERE "id" = ${input.opportunityId}
       FOR UPDATE
  `;
  const opp = locked[0];
  if (!opp) throw { _appCode: 404, message: "Opportunity not found." };

  const closing = input.toOutcome === "WON" || input.toOutcome === "LOST";
  const wasClosed = opp.outcome === "WON" || opp.outcome === "LOST";

  // Reopening is a privileged act, and it is the only way out of a terminal state. Editing
  // a closed deal's stage must not quietly reopen it — that is how a lost deal reappears in
  // the forecast with nobody having decided it should.
  if (wasClosed) {
    const reopening = input.toOutcome === "OPEN";
    if (!reopening) {
      throw {
        _appCode: 409,
        message: `This deal is already ${opp.outcome}. Reopen it explicitly before changing it.`,
      };
    }
    if (!input.canReopen) {
      throw { _appCode: 403, message: "Reopening a closed deal needs the deal-reopen permission." };
    }
  }

  // A loss needs a reason: typed text, or a code other than OTHER (whose label then becomes the
  // text, so every reader of `lostReason` keeps working). An unknown code is refused.
  let lost: { reason: string; code: LostReasonCode | null } | null = null;
  if (input.toOutcome === "LOST") {
    const r = resolveLostReason({ lostReason: input.lostReason, lostReasonCode: input.lostReasonCode });
    if (!r.ok) throw { _appCode: 400, message: r.error, errorAr: r.errorAr };
    lost = { reason: r.reason, code: r.code };
  }

  // Sample Evaluation may be skipped, but not silently (owner decision, docs/sales/PIPELINE_STAGES.md):
  // a forward move past it on a deal with no sample needs the reason the customer does not need one.
  let skipText: string | null = null;
  if (input.toStageId && input.toStageId !== opp.stageId) {
    const sampleStage = await tx.pipelineStage.findFirst({
      where: { purpose: "SAMPLE_EVALUATION", isActive: true },
      select: { position: true },
    });
    if (sampleStage) {
      const ends = await tx.pipelineStage.findMany({
        where: { id: { in: [opp.stageId, input.toStageId] } },
        select: { id: true, position: true },
      });
      const from = ends.find((s) => s.id === opp.stageId);
      const to = ends.find((s) => s.id === input.toStageId);
      const sampleCount = await tx.sampleShipment.count({
        where: { opportunityId: input.opportunityId, status: { not: "CANCELLED" } },
      });
      if (from && to && sampleSkipRequired({
        fromPosition: from.position, toPosition: to.position,
        samplePosition: sampleStage.position, sampleCount,
      })) {
        const why = (input.skipReason ?? "").trim();
        if (why.length < 2) throw { ...SAMPLE_SKIP_REFUSAL };
        skipText = sampleSkipReasonText(why);
      }
    }
  }

  if (input.toOutcome === "WON") {
    // Won is the claim that this became real business, so it must at least name the
    // customer it became business with.
    if (!opp.customerId) {
      throw {
        _appCode: 409,
        message: "A deal cannot be won without a customer. Link one first.",
      };
    }
    const accepted = await tx.quote.count({
      where: { opportunityId: input.opportunityId, status: "ACCEPTED" },
    });
    if (accepted === 0) {
      throw {
        _appCode: 409,
        message: "A deal is won when a quotation is accepted. Record the accepted quotation first.",
      };
    }
  }

  const nextStageId = input.toStageId ?? opp.stageId;
  const nextOutcome = input.toOutcome ?? (opp.outcome as "OPEN" | "WON" | "LOST");

  await tx.opportunity.update({
    where: { id: input.opportunityId },
    data: {
      stageId: nextStageId,
      outcome: nextOutcome,
      lostReason: nextOutcome === "LOST" ? (lost?.reason ?? null) : null,
      lostReasonCode: nextOutcome === "LOST" ? (lost?.code ?? null) : null,
      closedAt: closing ? new Date() : nextOutcome === "OPEN" ? null : undefined,
    },
  });

  await tx.opportunityStageEvent.create({
    data: {
      opportunityId: input.opportunityId,
      fromStageId: opp.stageId,
      toStageId: nextStageId,
      fromOutcome: opp.outcome as "OPEN" | "WON" | "LOST",
      toOutcome: nextOutcome,
      // The why of this move: the skip, the loss, or both (" · " — `parseSampleSkip` reads the first part).
      reason: [skipText, lost?.reason].filter(Boolean).join(" · ") || null,
      actorId: input.actorId,
    },
  });
  // The route raises "sales.deal_stage_changed" from these (services/sales/deal-events.ts): this
  // module is also imported by client screens for its constants, so it must not import the outbox.
  return { stageId: nextStageId, outcome: nextOutcome, fromStageId: opp.stageId, fromOutcome: opp.outcome, samplesSkipped: !!skipText };
}
