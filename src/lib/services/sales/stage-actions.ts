// The ONE thing to do next on a deal, by the stage it is in (docs/sales/PIPELINE_STAGES.md).
//
// Every stage of the approved pipeline has a job, and the deal page's header shows the job as a
// single prominent button rather than leaving the rep to work out which of a dozen controls
// matters now:
//
//   Qualified opportunity   record the needs analysis, until the minimum is known
//   Sample evaluation       record a sample, send it, record its evaluation — or skip, with a reason
//   Quotation               create the quotation, then follow it
//   Negotiation & approval  record the negotiation result, or get the discount approved
//   Closed (an outcome)     document the win, or the reason for the loss
//
// Pure, and decided from the deal as the page already holds it: no request of its own, nothing a
// client could not equally compute, and asserted without a browser (tests/sales/unit). Which of
// these the person may actually do (the privileges) is the page's call — this only says what the
// stage wants.
import type { StagePurpose } from "./stages";
import { qualificationMissing } from "./needs";

export type StageActionKey =
  | "RECORD_NEEDS"           // open the needs-analysis form
  | "RECORD_SAMPLE"          // open the new-sample form
  | "SEND_SAMPLE"            // mark the prepared sample sent (`sampleId`)
  | "RECORD_SAMPLE_EVALUATION" // record the customer's evaluation of a sent sample (`sampleId`)
  | "SKIP_SAMPLES"           // move on without a sample, giving the reason
  | "CREATE_QUOTE"           // start a quotation for this deal
  | "FOLLOW_QUOTE"           // open the open quotation (`quoteId`)
  | "REQUEST_APPROVAL"       // the draft quotation waits for discount approval (`quoteId`)
  | "RECORD_NEGOTIATION"     // log the negotiation call / meeting and its result
  | "WIN"                    // mark the deal won (an accepted quotation exists)
  | "DOCUMENT_LOSS"          // the customer refused: record the loss and its reason
  | "ADVANCE";               // this stage's job is done: move to the next stage

export type StageAction = {
  key: StageActionKey;
  /** A second, quieter choice beside the primary one (Sample Evaluation's skip; a re-quote). */
  secondary?: StageActionKey;
  quoteId?: string;
  sampleId?: string;
};

export type StageActionDeal = {
  outcome: "OPEN" | "WON" | "LOST";
  hasCustomer: boolean;
  /** Whether there is an active stage after this one. */
  hasNextStage: boolean;
  businessType: string | null;
  needSummary: string | null;
  agreedNextStep: string | null;
  samples: { id: string; status: string }[];
  /** Newest first, as the deal endpoint returns them. */
  quotes: { id: string; status: string; discountPending?: boolean }[];
};

/**
 * The key action for a deal in a stage with this purpose, or null when there is none (a closed
 * deal — reopening is its own control — or an unconfigured last stage with nothing to win).
 *
 * Precedence: an accepted quotation makes WIN the action wherever the deal is, because that is the
 * moment the business became real (the server's own rule for Won). Otherwise the stage decides;
 * a stage with no purpose (not aligned yet) falls back to moving on, exactly as before.
 */
export function stagePrimaryAction(purpose: StagePurpose | null | undefined, deal: StageActionDeal): StageAction | null {
  if (deal.outcome !== "OPEN") return null;

  const accepted = deal.quotes.find((q) => q.status === "ACCEPTED");
  if (accepted && deal.hasCustomer) return { key: "WIN", quoteId: accepted.id };

  const advance: StageAction | null = deal.hasNextStage ? { key: "ADVANCE" } : null;
  // The quotation still in play: the newest one that is neither superseded nor expired.
  const live = deal.quotes.find((q) => q.status === "DRAFT" || q.status === "ISSUED" || q.status === "REJECTED");

  switch (purpose) {
    case "QUALIFICATION":
      if (qualificationMissing(deal).length > 0) return { key: "RECORD_NEEDS" };
      return advance ?? { key: "RECORD_NEEDS" };

    case "SAMPLE_EVALUATION": {
      const samples = deal.samples.filter((s) => s.status !== "CANCELLED");
      if (samples.length === 0) return { key: "RECORD_SAMPLE", secondary: "SKIP_SAMPLES" };
      if (samples.some((s) => s.status === "FEEDBACK_RECEIVED")) return advance ?? { key: "CREATE_QUOTE" };
      const sent = samples.find((s) => s.status === "SENT");
      if (sent) return { key: "RECORD_SAMPLE_EVALUATION", sampleId: sent.id };
      const preparing = samples.find((s) => s.status === "PREPARING");
      return preparing ? { key: "SEND_SAMPLE", sampleId: preparing.id } : advance;
    }

    case "QUOTATION":
      if (!live) return { key: "CREATE_QUOTE" };
      if (live.status === "DRAFT" && live.discountPending) return { key: "REQUEST_APPROVAL", quoteId: live.id };
      if (live.status === "REJECTED") return { key: "DOCUMENT_LOSS", secondary: "CREATE_QUOTE", quoteId: live.id };
      return { key: "FOLLOW_QUOTE", quoteId: live.id };

    case "NEGOTIATION":
      if (live?.status === "DRAFT" && live.discountPending) return { key: "REQUEST_APPROVAL", quoteId: live.id };
      if (live?.status === "REJECTED") return { key: "DOCUMENT_LOSS", secondary: "CREATE_QUOTE", quoteId: live.id };
      return { key: "RECORD_NEGOTIATION", ...(live ? { quoteId: live.id } : {}) };

    default:
      // Not aligned yet (no purpose), or a stage after Negotiation such as a legacy «Closing»:
      // move on while there is somewhere to go; at the end, the only open job is the outcome.
      if (advance) return advance;
      if (live?.status === "REJECTED") return { key: "DOCUMENT_LOSS", quoteId: live.id };
      return null;
  }
}
