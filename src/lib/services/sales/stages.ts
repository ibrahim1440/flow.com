import type { Prisma as PrismaNS } from "@/generated/prisma/client";

type Tx = PrismaNS.TransactionClient;

/**
 * Which stage the automation means when it says "Qualification" or "Quotation".
 *
 * ── Why this is a stored purpose and not a lookup by name or code ──
 * The lifecycle has to put a newly-qualified lead somewhere and move a quoted deal
 * somewhere else. Three obvious ways to decide where, and all three are wrong:
 *
 *   By Arabic name  — the labels are editable and translated. A roastery renaming
 *                     «تأهيل» to «فرز أولي» would silently break qualification.
 *   By code         — plausible, until you look: this deployment's codes are `UAT_QUALIFY`
 *                     and `UAT_PROPOSAL`. Any regex that matches those matches by accident.
 *   By position     — inserting a stage at position 2 redirects the automation to it
 *                     without anybody deciding that.
 *
 * So the meaning is configured once, next to the stages themselves, and read from there.
 * A unique index allows at most one stage per purpose.
 *
 * ── Why an unconfigured purpose refuses instead of guessing ──
 * The alternative is a fallback, and every fallback here is a guess about which column
 * somebody's deals land in. A refusal that names the settings screen is recoverable in
 * thirty seconds; deals quietly accumulating in the wrong column is not, because nobody
 * finds out until the forecast is wrong.
 */
export type StagePurpose = "QUALIFICATION" | "SAMPLE_EVALUATION" | "QUOTATION" | "NEGOTIATION";

/**
 * Every purpose, in pipeline order (migration 20261204100000_pipeline_qualification added the
 * middle two). The approved pipeline is Qualified Opportunity → Sample Evaluation → Quotation →
 * Negotiation & Approval → Closed; "Closed" is the deal's outcome (Won / Lost), never a stage,
 * so it has no purpose here. See docs/sales/PIPELINE_STAGES.md.
 */
export const STAGE_PURPOSES = ["QUALIFICATION", "SAMPLE_EVALUATION", "QUOTATION", "NEGOTIATION"] as const satisfies readonly StagePurpose[];

const WHAT: Record<StagePurpose, { en: string; ar: string }> = {
  QUALIFICATION: { en: "Qualified Opportunity", ar: "الفرصة المؤهلة" },
  SAMPLE_EVALUATION: { en: "Sample Evaluation", ar: "تجربة وتقييم العينات" },
  QUOTATION: { en: "Quotation", ar: "عرض السعر" },
  NEGOTIATION: { en: "Negotiation & Approval", ar: "التفاوض والاعتماد" },
};

export type ResolvedStage = { id: string; code: string; position: number };

/**
 * The stage configured for this purpose, or `null` when none is.
 *
 * Returns null rather than throwing so a read path (a screen explaining that automation is
 * not configured) does not have to catch. Write paths use `requireStageFor`.
 */
export async function stageFor(tx: Tx, purpose: StagePurpose): Promise<ResolvedStage | null> {
  const stage = await tx.pipelineStage.findFirst({
    where: { purpose, isActive: true },
    select: { id: true, code: true, position: true },
  });
  return stage ?? null;
}

/** As `stageFor`, but a missing configuration is a refusal that says how to fix it. */
export async function requireStageFor(tx: Tx, purpose: StagePurpose): Promise<ResolvedStage> {
  const stage = await stageFor(tx, purpose);
  if (stage) return stage;
  throw {
    _appCode: 409,
    message:
      `No pipeline stage is configured as the ${WHAT[purpose].en} stage, so this cannot be ` +
      "done automatically. Set one in Sales settings, or move the deal by hand.",
    messageAr:
      `لا توجد مرحلة مُهيَّأة بوصفها مرحلة ${WHAT[purpose].ar}، فتعذّر تنفيذ ذلك تلقائياً. ` +
      "حدّد واحدة من إعدادات المبيعات، أو انقل الصفقة يدوياً.",
  };
}

/**
 * Should a deal at `fromPosition` be advanced to `toPosition`?
 *
 * Forward only. A deal already in Negotiation does not go back to Quotation because a
 * second quotation was issued, and a deal that has passed Qualification does not return to
 * it because somebody logged another meeting. The automation's job is to stop work being
 * lost, never to undo a human's decision about where a deal actually is.
 */
export function advancesForward(fromPosition: number, toPosition: number): boolean {
  return toPosition > fromPosition;
}

// ── Sample evaluation: skipping it is allowed, silently skipping it is not ──────────────────

/**
 * The prefix a documented skip carries on the stage event's `reason`.
 *
 * Stored in the reason rather than in a column of its own: the stage history already exists to
 * answer "who moved this, when and why", and a skip IS a why. The prefix is what lets a screen
 * (or a report) tell a skip from any other reason without a second table.
 */
export const SAMPLE_SKIP_PREFIX = "تخطّي العيّنات: ";

/** The reason text to store for a documented skip. */
export function sampleSkipReasonText(reason: string): string {
  return `${SAMPLE_SKIP_PREFIX}${reason.trim()}`;
}

/** The skip reason inside a stored stage-event reason, or null when the event is not a skip. */
export function parseSampleSkip(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const at = reason.indexOf(SAMPLE_SKIP_PREFIX);
  if (at < 0) return null;
  return reason.slice(at + SAMPLE_SKIP_PREFIX.length).split(" · ")[0].trim() || null;
}

/**
 * Does this move need a documented reason for skipping the samples?
 *
 * Yes exactly when all three hold:
 *   - a stage is configured as Sample Evaluation (no configuration, no rule — the same stance as
 *     every other purpose: nothing is inferred from a name);
 *   - the move goes FORWARD past it: it starts at or before that stage and ends after it. Moving
 *     from Qualification straight to Quotation skips it just as surely as leaving it does;
 *   - the deal has no sample (a cancelled one is not an evaluation).
 *
 * Backward moves, moves that stay before the stage, and closing a deal (an outcome, not a move)
 * never need it. That is the whole rule: no other formality is added to moving a deal.
 */
export function sampleSkipRequired(input: {
  fromPosition: number;
  toPosition: number;
  samplePosition: number | null;
  sampleCount: number;
}): boolean {
  if (input.samplePosition === null) return false;
  if (input.sampleCount > 0) return false;
  return input.fromPosition <= input.samplePosition && input.toPosition > input.samplePosition;
}

/** The refusal a skip without a reason gets — coded, so a screen can open the skip dialog. */
export const SAMPLE_SKIP_REFUSAL = {
  _appCode: 409,
  code: "SAMPLE_SKIP_REASON_REQUIRED",
  message:
    "This deal has no sample and is moving past Sample Evaluation. Record a sample, or give the " +
    "reason the customer does not need one.",
  errorAr: "لا توجد عيّنة على هذه الصفقة وهي تتجاوز مرحلة تجربة وتقييم العينات. سجّل عيّنة، أو اذكر سبب عدم حاجة العميل إليها.",
} as const;
